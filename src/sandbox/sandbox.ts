import { randomUUID } from "node:crypto";
import { Config, type ConfigOptions } from "../common/config.js";
import { SandboxError, SandboxTimeoutError } from "../common/errors.js";
import { SandboxClient } from "./client.js";
import { CodeRunner } from "./code.js";
import { CommandRunner } from "./commands.js";
import { FileManager } from "./files.js";
import { type CodeResult, type EnvVar, type ResourceRequests, SandboxStatus } from "./models.js";

export interface SandboxOptions extends ConfigOptions {
	volumeSize?: string;
}

/**
 * Options for {@link Sandbox.create}. All new fields are optional; omitted
 * fields are not sent to the backend.
 */
export interface SandboxCreateOptions extends SandboxOptions {
	/** Optional sandbox name. If omitted, a random name is generated. */
	name?: string;
	/** CPU / memory resource requests (e.g. `{ cpu: "2", memory: "4Gi" }`). */
	resources?: ResourceRequests;
	/** If set, whether the sandbox may reach the public internet. */
	allowInternetAccess?: boolean;
	/** Environment variables to inject into the sandbox. */
	envVars?: EnvVar[];
	/** Names of Kubernetes secrets to mount/reference in the sandbox. */
	secretRefs?: string[];
}

export class Sandbox {
	private readonly _name: string;
	private readonly _workspace: string;
	private readonly _client: SandboxClient;
	private readonly _code: CodeRunner;
	private readonly _commands: CommandRunner;
	private readonly _files: FileManager;
	private _status: SandboxStatus;
	private _image: string | undefined;
	private _pool: string | undefined;
	private _killed = false;

	private readonly _timeout: number;

	private constructor(
		name: string,
		workspace: string,
		client: SandboxClient,
		status: SandboxStatus,
		timeout: number,
		image?: string,
		pool?: string,
	) {
		this._name = name;
		this._workspace = workspace;
		this._client = client;
		this._status = status;
		this._timeout = timeout;
		this._image = image;
		this._pool = pool;
		this._code = new CodeRunner(client, name);
		this._commands = new CommandRunner(client, name, timeout);
		this._files = new FileManager(client, name);
	}

	// ---- Factory methods ----

	/**
	 * Claim a pre-warmed sandbox from a warm pool.
	 * Typically ready in <100ms.
	 */
	static async fromPool(pool: string, options: SandboxOptions = {}): Promise<Sandbox> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			const info = await client.claimFromPool(pool, options.volumeSize);
			return new Sandbox(
				info.name,
				config.workspace,
				client,
				info.status,
				config.timeout,
				info.image,
				pool,
			);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/**
	 * Create a new sandbox from a container image.
	 * Cold start takes ~10-30 seconds; call `waitUntilReady()` before use.
	 */
	static async create(image: string, options: SandboxCreateOptions = {}): Promise<Sandbox> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			const sandboxName = options.name ?? `sandbox-${randomHex(8)}`;
			const info = await client.create({
				image,
				name: sandboxName,
				volumeSize: options.volumeSize,
				cpu: options.resources?.cpu,
				memory: options.resources?.memory,
				allowInternetAccess: options.allowInternetAccess,
				envVars: options.envVars,
				secretRefs: options.secretRefs,
			});
			return new Sandbox(info.name, config.workspace, client, info.status, config.timeout, image);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/**
	 * Connect to an existing sandbox by name.
	 */
	static async get(name: string, options: ConfigOptions = {}): Promise<Sandbox> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			const info = await client.get(name);
			return new Sandbox(
				info.name,
				config.workspace,
				client,
				info.status,
				config.timeout,
				info.image,
				info.pool,
			);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/** Alias for `get`. */
	static connect = Sandbox.get;

	/**
	 * List all sandboxes in the workspace.
	 */
	static async list(options: ConfigOptions & { phase?: SandboxStatus } = {}): Promise<Sandbox[]> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			const infos = await client.list();
			return infos
				.filter((info) => !options.phase || info.status === options.phase)
				.map(
					(info) =>
						new Sandbox(
							info.name,
							config.workspace,
							new SandboxClient(config),
							info.status,
							config.timeout,
							info.image,
							info.pool,
						),
				);
		} finally {
			client.close();
		}
	}

	// ---- Properties ----

	get name(): string {
		return this._name;
	}

	get workspace(): string {
		return this._workspace;
	}

	/** Returns the cached status without an API call. */
	get status(): SandboxStatus {
		return this._status;
	}

	/** Returns the current phase, refreshed from the API. */
	async getPhase(): Promise<SandboxStatus> {
		await this.refresh();
		return this._status;
	}

	get commands(): CommandRunner {
		this.checkNotKilled();
		return this._commands;
	}

	get files(): FileManager {
		this.checkNotKilled();
		return this._files;
	}

	get sessionId(): string | undefined {
		return this._code.getSessionId();
	}

	// ---- Code execution ----

	async runCode(code: string, language = "python", timeout?: number): Promise<CodeResult> {
		this.checkNotKilled();
		return this._code.run(code, language, timeout ?? this._timeout);
	}

	resetSession(): void {
		this._code.resetSession();
	}

	// ---- Lifecycle ----

	async pause(): Promise<void> {
		this.checkNotKilled();
		await this._client.pause(this._name);
		this._status = SandboxStatus.Paused;
		this._code.markSessionInvalid();
	}

	async resume(): Promise<void> {
		this.checkNotKilled();
		await this._client.resume(this._name);
		this._status = SandboxStatus.Running;
		this._code.markSessionInvalid();
	}

	async waitUntilReady(timeout?: number): Promise<void> {
		const effectiveTimeout = timeout ?? this._timeout;
		const deadline = Date.now() + effectiveTimeout * 1000;
		const pollIntervalMs = 2000;

		while (Date.now() < deadline) {
			await this.refresh();

			if (this._status === SandboxStatus.Running) {
				await this.warmupKernel(deadline);
				return;
			}

			if (this._status === SandboxStatus.Failed || this._status === SandboxStatus.Succeeded) {
				throw new SandboxError(`Sandbox '${this._name}' entered terminal state: ${this._status}`);
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(pollIntervalMs, remainingMs));
		}

		throw new SandboxTimeoutError(
			`Sandbox '${this._name}' did not become ready within ${effectiveTimeout}s`,
		);
	}

	/**
	 * Warm up the Jupyter kernel by running a marker print until it is
	 * observable in stdout. Jupyter's ipykernel takes ~1.7s after pod start
	 * before its first `execute_request` produces visible iopub stdout.
	 * Without this, the first user `runCode` call after `waitUntilReady`
	 * can return `success=true` with empty stdout.
	 *
	 * Bounded by `deadline`. Never throws on deadline exceeded — logs a
	 * warning and returns. Propagates any error thrown by `runCode`.
	 */
	private async warmupKernel(deadline: number): Promise<void> {
		this.checkNotKilled();
		const marker = `__pk_warmup_${randomUUID().replace(/-/g, "")}__`;
		const probeCode = `print("${marker}")`;
		const probeIntervalMs = 500;
		// runCode expects a positive integer second timeout. We can't probe
		// with a sub-second budget without potentially overrunning the
		// deadline, so once less than 1s remains we give up rather than
		// rounding up.
		const minProbeBudgetMs = 1000;
		// Cap the per-probe backend timeout so a single warmup attempt
		// cannot consume the entire waitUntilReady budget. Without this
		// cap, the first probe call against an unresponsive kernel could
		// block the SDK for the user's full timeout (potentially minutes)
		// and starve the intended 500ms retry loop.
		const maxProbeTimeoutSec = 5;

		while (true) {
			const remainingMs = deadline - Date.now();
			if (remainingMs < minProbeBudgetMs) break;

			// `probeTimeoutSec` caps the BACKEND execution time of the probe
			// (passed through to /exec). It does NOT bound the client-side
			// fetch() duration — HttpClient currently has no AbortSignal
			// timeout, so a stalled TCP connection could still let a single
			// probe overrun the overall waitUntilReady deadline. Tracked as
			// a separate concern (HTTP-layer fetch timeout). floor() at
			// least guarantees probeTimeoutSec * 1000 <= remainingMs.
			const probeTimeoutSec = Math.min(maxProbeTimeoutSec, Math.floor(remainingMs / 1000));
			const result = await this.runCode(probeCode, "python", probeTimeoutSec);
			if (result.stdout.trim() === marker) return;

			const postProbeRemainingMs = deadline - Date.now();
			if (postProbeRemainingMs <= 0) break;
			await sleep(Math.min(probeIntervalMs, postProbeRemainingMs));
		}

		console.warn(
			`Sandbox '${this._name}': kernel warmup probe did not observe marker within deadline; proceeding anyway`,
		);
	}

	async kill(): Promise<void> {
		if (this._killed) return;
		await this._client.delete(this._name);
		this._status = SandboxStatus.Succeeded;
		this._killed = true;
		this._client.close();
	}

	async refresh(): Promise<void> {
		this.checkNotKilled();
		const info = await this._client.get(this._name);
		this._status = info.status;
		if (info.image) this._image = info.image;
		if (info.pool) this._pool = info.pool;
	}

	// ---- Cleanup helper ----

	/**
	 * Use with `await using` (TC39 Explicit Resource Management) or
	 * call `kill()` manually in a `finally` block.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.kill();
		} catch {
			// Suppress cleanup errors, matching Python SDK context manager behavior
		}
	}

	// ---- Internal ----

	private checkNotKilled(): void {
		if (this._killed) {
			throw new SandboxError(`Sandbox '${this._name}' has been killed and cannot be used anymore`);
		}
	}
}

function randomHex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
