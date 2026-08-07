import { randomUUID } from "node:crypto";
import { Config, type ConfigOptions } from "../common/config.js";
import {
	NotFoundError,
	ProKubeError,
	RequestTimeoutError,
	SandboxError,
	SandboxNotFoundError,
	SandboxTimeoutError,
} from "../common/errors.js";
import { SandboxClient } from "./client.js";
import { CodeRunner } from "./code.js";
import { CommandRunner } from "./commands.js";
import { FileManager } from "./files.js";
import {
	type CodeResult,
	type EnvVar,
	type ResourceRequests,
	type SandboxInfo,
	type SandboxInfoPage,
	SandboxStatus,
} from "./models.js";

/**
 * Interval between lifecycle polls. Every wait in this class (readiness,
 * pause, deletion) reuses it so their pacing cannot drift apart.
 */
const POLL_INTERVAL_MS = 2000;

export interface SandboxOptions extends ConfigOptions {
	volumeSize?: string;
	/** Per-claim auto-idle override in seconds. Omit to inherit the warm-pool/platform default. */
	autoIdleTimeoutSeconds?: number;
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
	/** Per-sandbox auto-idle override in seconds. Omit to inherit the platform default. */
	autoIdleTimeoutSeconds?: number;
	/** Environment variables to inject into the sandbox. */
	envVars?: EnvVar[];
	/** Names of Kubernetes secrets to mount/reference in the sandbox. */
	secretRefs?: string[];
}

/** Options for {@link Sandbox.pause}. */
export interface PauseOptions {
	/**
	 * Block until the sandbox has actually reached `Paused` (default: true).
	 * Pass `false` to return as soon as the backend accepted the request,
	 * leaving the phase at `Pausing`.
	 */
	wait?: boolean;
	/** Maximum seconds to wait when `wait` is true (default: 300). */
	timeout?: number;
}

/** Options for {@link Sandbox.kill}. */
export interface KillOptions {
	/** Poll until the sandbox is really gone (default: false). */
	wait?: boolean;
	/** Maximum seconds to wait when `wait` is true (default: 300). */
	timeout?: number;
}

/** Options for {@link Sandbox.listPage}. */
export interface SandboxListPageOptions extends ConfigOptions {
	/** Page size, 1–100 (default: 25). */
	limit?: number;
	/** Opaque keyset cursor from the previous page's `continueToken`. */
	continueToken?: string;
	/** Client-side phase filter applied to the page that was fetched. */
	phase?: SandboxStatus;
}

/**
 * One bounded page of ready-to-use sandboxes.
 *
 * Pass `continueToken` back to {@link Sandbox.listPage} together with the
 * same `limit` to fetch the next page.
 */
export interface SandboxPage {
	sandboxes: Sandbox[];
	loaded: number;
	hasMore: boolean;
	continueToken?: string;
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
	private _autoIdleTimeoutSeconds: number | undefined;
	private _killed = false;
	private _deleteRequested = false;
	private _lastError: string | undefined;

	private readonly _timeout: number;

	private constructor(
		name: string,
		workspace: string,
		client: SandboxClient,
		status: SandboxStatus,
		timeout: number,
		image?: string,
		pool?: string,
		autoIdleTimeoutSeconds?: number,
		lastError?: string,
	) {
		this._name = name;
		this._workspace = workspace;
		this._client = client;
		this._status = status;
		this._timeout = timeout;
		this._image = image;
		this._pool = pool;
		this._autoIdleTimeoutSeconds = autoIdleTimeoutSeconds;
		this._lastError = lastError;
		this._code = new CodeRunner(client, name);
		this._commands = new CommandRunner(client, name, timeout);
		this._files = new FileManager(client, name);
	}

	// ---- Factory methods ----

	/**
	 * Claim a sandbox from a warm pool.
	 *
	 * This is the fastest way to get a sandbox: the backend adopts a
	 * pre-warmed pod, but does so asynchronously, so the claim starts out in
	 * phase `Pending`. Call {@link waitUntilReady} before using it.
	 */
	static async fromPool(pool: string, options: SandboxOptions = {}): Promise<Sandbox> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			await client.ensureCompatibility();
			const info = await client.claimFromPool(
				pool,
				options.volumeSize,
				options.autoIdleTimeoutSeconds,
			);
			return new Sandbox(
				info.name,
				config.workspace,
				client,
				info.status,
				config.timeout,
				info.image,
				pool,
				info.autoIdleTimeoutSeconds ?? options.autoIdleTimeoutSeconds,
				info.lastError,
			);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/**
	 * Create a new sandbox from a container image.
	 *
	 * The backend accepts the request asynchronously, so the sandbox starts
	 * out `Pending` and cold start takes ~10-30 seconds; call
	 * {@link waitUntilReady} before use.
	 */
	static async create(image: string, options: SandboxCreateOptions = {}): Promise<Sandbox> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		try {
			await client.ensureCompatibility();
			const sandboxName = options.name ?? `sandbox-${randomHex(8)}`;
			const info = await client.create({
				image,
				name: sandboxName,
				volumeSize: options.volumeSize,
				cpu: options.resources?.cpu,
				memory: options.resources?.memory,
				allowInternetAccess: options.allowInternetAccess,
				autoIdleTimeoutSeconds: options.autoIdleTimeoutSeconds,
				envVars: options.envVars,
				secretRefs: options.secretRefs,
			});
			return new Sandbox(
				info.name,
				config.workspace,
				client,
				info.status,
				config.timeout,
				image,
				info.pool,
				info.autoIdleTimeoutSeconds ?? options.autoIdleTimeoutSeconds,
				info.lastError,
			);
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
			await client.ensureCompatibility();
			const info = await client.get(name);
			return new Sandbox(
				info.name,
				config.workspace,
				client,
				info.status,
				config.timeout,
				info.image,
				info.pool,
				info.autoIdleTimeoutSeconds,
				info.lastError,
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
			await client.ensureCompatibility();
			const infos = await client.list();
			return Sandbox.wrapInfos(
				infos.filter((info) => !options.phase || info.status === options.phase),
				config,
			);
		} finally {
			client.close();
		}
	}

	/**
	 * List one bounded page of sandboxes.
	 *
	 * One name-ordered listing covers every sandbox state. Pass
	 * `continueToken` from the previous page together with the same `limit`
	 * to fetch the next page; the token is an opaque keyset cursor.
	 *
	 * `loaded` and `hasMore` describe the page the backend returned, so they
	 * are unaffected by the client-side `phase` filter.
	 */
	static async listPage(options: SandboxListPageOptions = {}): Promise<SandboxPage> {
		const config = new Config(options);
		const client = new SandboxClient(config);
		let page: SandboxInfoPage;
		try {
			await client.ensureCompatibility();
			page = await client.listPage({
				limit: options.limit,
				continueToken: options.continueToken,
			});
		} finally {
			client.close();
		}

		return {
			sandboxes: Sandbox.wrapInfos(
				page.sandboxes.filter((info) => !options.phase || info.status === options.phase),
				config,
			),
			loaded: page.loaded,
			hasMore: page.hasMore,
			continueToken: page.continueToken,
		};
	}

	/**
	 * Build one Sandbox per listing result.
	 *
	 * Each sandbox gets its own client so that `kill()` on one does not
	 * invalidate the others. The version check is skipped because the listing
	 * client already verified compatibility.
	 */
	private static wrapInfos(infos: SandboxInfo[], config: Config): Sandbox[] {
		return infos.map(
			(info) =>
				new Sandbox(
					info.name,
					config.workspace,
					new SandboxClient(config, false),
					info.status,
					config.timeout,
					info.image,
					info.pool,
					info.autoIdleTimeoutSeconds,
					info.lastError,
				),
		);
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
		this.checkUsable();
		return this._commands;
	}

	get files(): FileManager {
		this.checkUsable();
		return this._files;
	}

	get sessionId(): string | undefined {
		return this._code.getSessionId();
	}

	get autoIdleTimeoutSeconds(): number | undefined {
		return this._autoIdleTimeoutSeconds;
	}

	// ---- Code execution ----

	async runCode(code: string, language = "python", timeout?: number): Promise<CodeResult> {
		this.checkUsable();
		return this._code.run(code, language, timeout ?? this._timeout);
	}

	resetSession(): void {
		this._code.resetSession();
	}

	// ---- Lifecycle ----

	/**
	 * Pause the sandbox, freeing its compute resources.
	 *
	 * Preserves `/workspace` (working directory) and `/home/agent` (HOME,
	 * `pip --user`, dotfiles). Lost: running processes, apt-installed system
	 * packages, `/tmp`.
	 *
	 * The backend accepts the pause asynchronously (phase `Pausing`). By
	 * default this blocks until the sandbox reports `Paused`.
	 *
	 * @throws SandboxError if the sandbox is not Running, or if the pause
	 *   itself fails (phase `Failed`). Re-issuing `pause()` retries.
	 * @throws SandboxTimeoutError if the sandbox does not reach `Paused`
	 *   within `options.timeout` seconds.
	 */
	async pause(options: PauseOptions = {}): Promise<void> {
		this.checkUsable();
		const info = await this._client.pause(this._name);
		this._status = info.status;
		this._lastError = info.lastError;
		// Pausing deletes the underlying pod, so any existing Jupyter session
		// is no longer valid. Reset so the next runCode() starts a fresh kernel.
		this._code.markSessionInvalid();
		if (options.wait ?? true) {
			await this.waitForPause(options.timeout ?? 300);
		}
	}

	/** Poll until the sandbox settles on Paused, Failed, or the deadline. */
	private async waitForPause(timeout: number): Promise<void> {
		const deadline = Date.now() + timeout * 1000;

		while (true) {
			let remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			try {
				await this.refresh(remainingMs / 1000);
			} catch (e) {
				if (e instanceof SandboxNotFoundError || e instanceof NotFoundError) {
					// A concurrently admitted delete finished while we waited.
					throw new SandboxError(
						`Sandbox '${this._name}' was deleted while waiting for it to pause`,
					);
				}
				if (!(e instanceof RequestTimeoutError)) throw e;
				// A single stalled poll is not fatal; retry until our deadline.
			}

			if (this._status === SandboxStatus.Paused) return;
			if (this._status === SandboxStatus.Failed) {
				throw new SandboxError(
					`Sandbox '${this._name}' failed to pause: ${
						this._lastError ?? "no error reported by the backend"
					} (re-issue pause() to retry)`,
				);
			}
			if (this._status === SandboxStatus.Deleting) {
				// Delete outranks pause on the backend: the pause worker's
				// settle will miss and the sandbox is going away. Waiting any
				// longer can only end in 404.
				throw new SandboxError(
					`Sandbox '${this._name}' is being deleted; it will never reach Paused`,
				);
			}

			remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
		}

		throw new SandboxTimeoutError(
			`Sandbox '${this._name}' did not pause within ${timeout}s (current phase: ${this._status})`,
		);
	}

	/**
	 * Resume a paused sandbox.
	 *
	 * A new pod starts with the same PVC mounts at `/workspace` and
	 * `/home/agent`. If `/home/agent/.sandbox-restore.sh` exists, it runs
	 * automatically on startup to reinstall system packages.
	 *
	 * The backend accepts the resume asynchronously and reports phase
	 * `Resuming`; this call does not block. Use {@link waitUntilReady} to
	 * wait for the new pod to become `Running`.
	 *
	 * @throws SandboxError if the sandbox is not in the `Paused` state.
	 */
	async resume(): Promise<void> {
		this.checkUsable();
		const info = await this._client.resume(this._name);
		this._status = info.status;
		this._lastError = info.lastError;
		if (info.image) this._image = info.image;
		if (info.pool) this._pool = info.pool;
		if (info.autoIdleTimeoutSeconds !== undefined) {
			this._autoIdleTimeoutSeconds = info.autoIdleTimeoutSeconds;
		}
		// New pod means the previous Jupyter session is invalid.
		this._code.markSessionInvalid();
	}

	/**
	 * Block until the sandbox phase is `Running`. Useful after `resume()`.
	 *
	 * Transitional phases (`Pending`, `Pausing`, `Resuming`) simply keep
	 * polling.
	 *
	 * @param timeout Maximum seconds to wait. Defaults to the configured
	 *   request timeout.
	 * @throws SandboxTimeoutError if the sandbox does not become `Running` in
	 *   time.
	 * @throws SandboxError if the sandbox enters a state from which it can no
	 *   longer become ready (`Failed`, `Succeeded` or `Deleting`). For a
	 *   failed sandbox the backend's `lastError` is included.
	 */
	async waitUntilReady(timeout?: number): Promise<void> {
		this.checkUsable();
		const effectiveTimeout = timeout ?? this._timeout;
		const deadline = Date.now() + effectiveTimeout * 1000;

		while (true) {
			let remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			try {
				// Cap the GET at the remaining budget so a single stalled poll
				// cannot block past the caller's deadline: without this the
				// request falls back to the client's default timeout
				// (PROKUBE_TIMEOUT, 300s), which can vastly exceed a short
				// waitUntilReady(timeout) call.
				await this.refresh(remainingMs / 1000);
			} catch (e) {
				if (!(e instanceof RequestTimeoutError)) throw e;
				remainingMs = deadline - Date.now();
				if (remainingMs <= 0) break;
				await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
				continue;
			}

			if (this._status === SandboxStatus.Running) {
				await this.warmupKernel(deadline);
				return;
			}

			if (
				this._status === SandboxStatus.Failed ||
				this._status === SandboxStatus.Succeeded ||
				this._status === SandboxStatus.Deleting
			) {
				const detail = this._lastError ? `: ${this._lastError}` : "";
				throw new SandboxError(
					`Sandbox '${this._name}' entered terminal state ${this._status} while waiting for it to become ready${detail}`,
				);
			}

			remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
		}

		throw new SandboxTimeoutError(
			`Sandbox '${this._name}' did not become ready within ${effectiveTimeout}s (last phase: ${this._status})`,
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
	 * warning and returns. Transient gateway timeouts during warmup are retried;
	 * other errors from `runCode` still propagate.
	 */
	private async warmupKernel(deadline: number): Promise<void> {
		this.checkUsable();
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
			// (passed through to /exec). The client-side fetch is bounded
			// separately by the HTTP client's configured timeout, so a stalled
			// connection can still let one probe outlive this deadline — that
			// bound is config.timeout, not infinity. floor() at least
			// guarantees probeTimeoutSec * 1000 <= remainingMs.
			const probeTimeoutSec = Math.min(maxProbeTimeoutSec, Math.floor(remainingMs / 1000));
			let result: CodeResult;
			try {
				result = await this.runCode(probeCode, "python", probeTimeoutSec);
			} catch (error) {
				if (!(error instanceof ProKubeError) || error.statusCode !== 504) {
					throw error;
				}
				this._code.markSessionInvalid();
				const postErrorRemainingMs = deadline - Date.now();
				if (postErrorRemainingMs <= 0) break;
				await sleep(Math.min(probeIntervalMs, postErrorRemainingMs));
				continue;
			}
			if (result.stdout.trim() === marker) return;
			this._code.markSessionInvalid();

			const postProbeRemainingMs = deadline - Date.now();
			if (postProbeRemainingMs <= 0) break;
			await sleep(Math.min(probeIntervalMs, postProbeRemainingMs));
		}

		console.warn(
			`Sandbox '${this._name}': kernel warmup probe did not observe marker within deadline; proceeding anyway`,
		);
	}

	/**
	 * Destroy the sandbox.
	 *
	 * The backend accepts the delete with HTTP 202 and tears the sandbox down
	 * asynchronously, including purging its persistence records. The sandbox
	 * name stays reserved until that purge completes, so pass `wait: true`
	 * when you intend to reuse the name (or need the quota back) and must
	 * know the reclamation finished.
	 *
	 * Once the delete has been admitted the sandbox cannot be used anymore:
	 * `runCode()`, `commands` and `files` throw. If waiting fails or times
	 * out, the object stays in a deletion-requested state — normal operations
	 * stay blocked, but `kill({ wait: true })` may be re-issued to keep
	 * waiting (the backend's DELETE is idempotent while teardown is in
	 * flight). If the initial delete request itself fails, the error is
	 * thrown and the sandbox remains usable so callers can retry.
	 *
	 * @throws SandboxError if `wait` is true and the backend lands the delete
	 *   in a terminal failure (phase `Failed` with `lastError`); re-issue
	 *   `kill()` to retry the delete.
	 * @throws SandboxTimeoutError if `wait` is true and the sandbox is still
	 *   present after `options.timeout` seconds.
	 */
	async kill(options: KillOptions = {}): Promise<void> {
		if (this._killed) return;
		try {
			await this._client.delete(this._name);
		} catch (e) {
			if (!(e instanceof SandboxNotFoundError) && !(e instanceof NotFoundError)) throw e;
			// A re-issued kill can find the sandbox already gone: that is the
			// outcome we wanted, not an error.
			this._status = SandboxStatus.Succeeded;
			this._killed = true;
			this._client.close();
			return;
		}
		// The delete is admitted: from here the sandbox is going away and must
		// not accept work, even if the wait below fails or times out.
		this._deleteRequested = true;
		if (options.wait ?? false) {
			await this.waitUntilGone(options.timeout ?? 300);
		}
		this._status = SandboxStatus.Succeeded;
		this._killed = true;
		this._client.close();
	}

	/** Poll the sandbox until the backend reports it as absent (404). */
	private async waitUntilGone(timeout: number): Promise<void> {
		const deadline = Date.now() + timeout * 1000;

		while (true) {
			let remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			try {
				const info = await this._client.get(this._name, remainingMs / 1000);
				this._status = info.status;
				this._lastError = info.lastError;
				if (this._status === SandboxStatus.Failed) {
					// delete_failed on the backend: retries are exhausted and
					// the row (and name) stay reserved until a delete is
					// re-issued and succeeds.
					throw new SandboxError(
						`Sandbox '${this._name}' failed to delete: ${
							this._lastError ?? "no error reported by the backend"
						} (re-issue kill() to retry)`,
					);
				}
			} catch (e) {
				if (e instanceof SandboxNotFoundError || e instanceof NotFoundError) return;
				if (!(e instanceof RequestTimeoutError)) throw e;
				// A single stalled poll is not fatal; retry until our deadline.
			}

			remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
		}

		throw new SandboxTimeoutError(
			`Sandbox '${this._name}' was not deleted within ${timeout}s (current phase: ${this._status})`,
		);
	}

	/**
	 * Refresh sandbox information from the API.
	 *
	 * @param requestTimeout Per-request timeout override in seconds. Callers
	 *   polling toward a deadline should pass the remaining budget.
	 */
	async refresh(requestTimeout?: number): Promise<void> {
		this.checkUsable();
		const info = await this._client.get(this._name, requestTimeout);
		this._status = info.status;
		this._lastError = info.lastError;
		if (info.image) this._image = info.image;
		if (info.pool) this._pool = info.pool;
		if (info.autoIdleTimeoutSeconds !== undefined) {
			this._autoIdleTimeoutSeconds = info.autoIdleTimeoutSeconds;
		}
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

	/**
	 * Reject work on a sandbox that is killed or on its way out.
	 *
	 * A sandbox whose delete has been admitted is locked even though the
	 * teardown may still be in flight: the pod is going away, so any exec or
	 * file operation would either fail or silently target a doomed pod.
	 */
	private checkUsable(): void {
		if (this._killed) {
			throw new SandboxError(`Sandbox '${this._name}' has been killed and cannot be used anymore`);
		}
		if (this._deleteRequested) {
			throw new SandboxError(
				`Sandbox '${this._name}' is being deleted; call kill({ wait: true }) to wait for the deletion to complete`,
			);
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
