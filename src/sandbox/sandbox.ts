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
 * Interval between lifecycle polls. The pause and deletion waits reuse it so
 * their pacing cannot drift apart. Readiness waiting long-polls instead and
 * uses the constants below.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * Readiness waiting (see {@link Sandbox.waitUntilReady}). Each round asks the
 * backend to hold the status GET for `LONG_POLL_WAIT_SECONDS`, allowing the
 * request itself `LONG_POLL_MARGIN_SECONDS` more so a hold that expires still
 * answers in time. A round that returns faster than `IMMEDIATE_RESPONSE_MS`
 * did not block server-side, so the next one is paced by `DEGRADED_POLL_MS`.
 */
const LONG_POLL_WAIT_SECONDS = 20;
const LONG_POLL_MARGIN_SECONDS = 5;
const IMMEDIATE_RESPONSE_MS = 500;
const DEGRADED_POLL_MS = 1000;

/**
 * Kernel warmup (see {@link Sandbox.warmupKernel}). The agent's blocking ping
 * is bounded by `KERNEL_PING_MAX_SECONDS` per attempt; the marker probe runs
 * with a `PROBE_MAX_TIMEOUT_SEC` budget and `PROBE_RETRY_MS` between attempts.
 */
const KERNEL_PING_MAX_SECONDS = 100;
const PROBE_MAX_TIMEOUT_SEC = 5;
const PROBE_RETRY_MS = 500;
/**
 * runCode and the agent ping both take an integer second budget, so a
 * sub-second remainder cannot be expressed without overrunning the deadline.
 */
const MIN_PROBE_BUDGET_MS = 1000;

/**
 * Result of one kernel-ready ping attempt: the kernel is up, the agent has no
 * such endpoint (fall back to marker probing), or the budget ran out first.
 */
type KernelPingOutcome = "warm" | "unsupported" | "expired";

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
 * Pass `continueToken` back to {@link Sandbox.listPage} together with a
 * `limit` (any valid value, 1-100) to fetch the next page.
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
		// Bind the usability guard into every helper so the check runs on each
		// operation, not just on the property access that handed the helper
		// out. Mirrors the Python SDK, which injects `_check_not_killed` into
		// CommandRunner/FileManager/CodeRunner.
		const checkUsable = () => {
			this.checkUsable();
		};
		this._code = new CodeRunner(client, name, checkUsable);
		this._commands = new CommandRunner(client, name, timeout, checkUsable);
		this._files = new FileManager(client, name, checkUsable);
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
	 * `continueToken` from the previous page to fetch the next page; the
	 * token is an opaque keyset cursor and `limit` must be supplied whenever
	 * a `continueToken` is.
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
	 * Each round long-polls the status endpoint: the backend holds the GET
	 * open until the sandbox reaches `Running` (or its own wait window
	 * elapses) and answers with the current payload either way, so a
	 * transition is observed within milliseconds instead of on the next fixed
	 * poll tick. Transitional phases (`Pending`, `Pausing`, `Resuming`) simply
	 * start another round.
	 *
	 * Backends that predate the `wait_phase` parameter ignore it and answer
	 * immediately; those rounds are paced with a short client-side sleep so
	 * the loop degrades into the plain polling it replaced instead of
	 * hammering the API.
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
			const roundStarted = Date.now();
			let remainingMs = deadline - roundStarted;
			if (remainingMs <= 0) break;
			// Ask the backend to hold the request for at most the remaining
			// budget, and cap the GET itself at the remaining budget too so a
			// single stalled round cannot block past the caller's deadline:
			// without this the request falls back to the client's default
			// timeout (PROKUBE_TIMEOUT, 300s), which can vastly exceed a short
			// waitUntilReady(timeout) call. The GET is allowed a margin over
			// the hold so a response that only arrives when the hold expires
			// is not mistaken for a stall.
			const waitTimeoutSec = Math.min(LONG_POLL_WAIT_SECONDS, remainingMs / 1000);
			try {
				await this.refresh(
					Math.min(waitTimeoutSec + LONG_POLL_MARGIN_SECONDS, remainingMs / 1000),
					SandboxStatus.Running,
					waitTimeoutSec,
				);
			} catch (e) {
				if (!(e instanceof RequestTimeoutError)) throw e;
				remainingMs = deadline - Date.now();
				if (remainingMs <= 0) break;
				await sleep(Math.min(DEGRADED_POLL_MS, remainingMs));
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

			const roundEnded = Date.now();
			remainingMs = deadline - roundEnded;
			if (remainingMs <= 0) break;
			if (roundEnded - roundStarted < IMMEDIATE_RESPONSE_MS) {
				// The answer came back instantly without the target phase, so
				// the backend did not hold the request — either it ignores
				// wait_phase (older backend) or it reported an intermediate
				// transition. Pace the next round instead of spinning.
				await sleep(Math.min(DEGRADED_POLL_MS, remainingMs));
			}
		}

		throw new SandboxTimeoutError(
			`Sandbox '${this._name}' did not become ready within ${effectiveTimeout}s (last phase: ${this._status})`,
		);
	}

	/**
	 * Wait until the sandbox's code-execution pipeline is live.
	 *
	 * The first execution after pod start can race a cold interpreter and
	 * return `success=true` with empty stdout; without warmup, the first user
	 * `runCode` call after `waitUntilReady` would absorb that race. (Whether
	 * the current sandbox agent still exhibits it is unverified; the probe is
	 * kept as cheap insurance until warmup is re-measured against it.)
	 *
	 * The agent closes that window itself: `GET <sandbox>/ping?wait=kernel`
	 * blocks until the kernel has started (200) or the wait window elapses
	 * (503). One blocking call therefore replaces the poll loop. Because the
	 * ping only proves the *kernel* started — not that the exec/SSE pipeline
	 * in front of it delivers output — a `print(<marker>)` round-trip still
	 * follows it as end-to-end proof, run by {@link probeKernelLoop}: a warm
	 * kernel normally echoes the marker on the first try, but a transient
	 * gateway 504 or a swallowed first stdout must be retried inside the
	 * remaining budget instead of handing the user a sandbox whose next
	 * `runCode` resets the just-prewarmed session. The marker check is
	 * containment, not equality: the interpreter may append unrelated text
	 * (e.g. warnings) alongside the marker, and extra output does not make
	 * the session any less live.
	 *
	 * Agents without the endpoint answer 404/400/405; those fall back to the
	 * very same loop, which is all warmup was before the ping existed.
	 *
	 * Bounded by `deadline`. Never throws on deadline exceeded — logs a
	 * warning and returns. Other errors from `runCode` still propagate.
	 */
	private async warmupKernel(deadline: number): Promise<void> {
		this.checkUsable();
		const outcome = await this.pingKernel(deadline);
		if (outcome === "expired") {
			this.warnWarmupIncomplete(0);
			return;
		}
		await this.probeKernelLoop(deadline);
	}

	/**
	 * Block on the agent's kernel-ready ping until it reports warm.
	 *
	 * Resolves to `"warm"` once the agent answers 200, `"unsupported"` if it
	 * has no such endpoint (so the caller must probe through `exec`), or
	 * `"expired"` when the deadline runs out while the kernel is still cold.
	 */
	private async pingKernel(deadline: number): Promise<KernelPingOutcome> {
		while (true) {
			const remainingMs = deadline - Date.now();
			// The agent takes an integer second wait window, so a sub-second
			// budget cannot be expressed; give up rather than round up and
			// overrun waitUntilReady's deadline.
			if (remainingMs < MIN_PROBE_BUDGET_MS) return "expired";
			// Keep the agent's own wait window inside the remaining budget,
			// leaving room for the response trip, and below the ceiling the
			// gateway in front of the agent tolerates.
			const waitSeconds = Math.floor(
				Math.min(
					KERNEL_PING_MAX_SECONDS,
					Math.max(1, remainingMs / 1000 - LONG_POLL_MARGIN_SECONDS),
				),
			);
			const started = Date.now();
			try {
				await this._client.pingKernel(this._name, waitSeconds, remainingMs / 1000);
			} catch (error) {
				// A stalled ping is indistinguishable from a proxy that never
				// forwards it; the marker probe is the reliable path.
				if (error instanceof RequestTimeoutError) return "unsupported";
				if (error instanceof NotFoundError) return "unsupported";
				if (!(error instanceof ProKubeError)) throw error;
				if (error.statusCode === 400 || error.statusCode === 405) return "unsupported";
				if (error.statusCode !== 503 && error.statusCode !== 504) throw error;
				// 503: kernel still cold after the agent's wait window.
				// 504: the gateway cut the blocking request. Both are
				// transient — keep waiting inside our own deadline, pacing a
				// ping that answered instantly so a non-blocking agent cannot
				// spin the loop.
				if (Date.now() - started < IMMEDIATE_RESPONSE_MS) {
					await sleep(Math.min(PROBE_RETRY_MS, Math.max(0, deadline - Date.now())));
				}
				continue;
			}
			return "warm";
		}
	}

	/**
	 * Probe the Jupyter kernel until it echoes a unique marker back.
	 *
	 * Used both as the end-to-end proof after a warm kernel-ready ping and as
	 * the whole warmup for agents without that endpoint. The marker is
	 * per-call to avoid collisions with user code, and a probe that returns
	 * without it discards the session before retrying — otherwise a
	 * cold/stale Jupyter session can be reused forever and every probe keeps
	 * returning empty stdout.
	 */
	private async probeKernelLoop(deadline: number): Promise<void> {
		const marker = `__pk_warmup_${randomUUID().replace(/-/g, "")}__`;
		const probeCode = `print("${marker}")`;
		let attempts = 0;

		while (true) {
			const remainingMs = deadline - Date.now();
			// runCode expects a positive integer second timeout. We can't
			// probe with a sub-second budget without potentially overrunning
			// the deadline, so once less than 1s remains we give up rather
			// than rounding up.
			if (remainingMs < MIN_PROBE_BUDGET_MS) break;
			attempts += 1;

			// `probeTimeoutSec` caps the BACKEND execution time of the probe
			// (passed through to /exec), keeping retries frequent against a
			// stuck kernel. Without this cap the first probe call could block
			// the SDK for the user's full timeout (potentially minutes) and
			// starve the retry loop. floor() at least guarantees
			// probeTimeoutSec * 1000 <= remainingMs.
			const probeTimeoutSec = Math.min(PROBE_MAX_TIMEOUT_SEC, Math.floor(remainingMs / 1000));
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
				await sleep(Math.min(PROBE_RETRY_MS, postErrorRemainingMs));
				continue;
			}
			if (result.stdout.includes(marker)) return;
			this._code.markSessionInvalid();

			const postProbeRemainingMs = deadline - Date.now();
			if (postProbeRemainingMs <= 0) break;
			await sleep(Math.min(PROBE_RETRY_MS, postProbeRemainingMs));
		}

		this.warnWarmupIncomplete(attempts);
	}

	/** Log that warmup did not confirm a live kernel; never throws. */
	private warnWarmupIncomplete(attempts: number): void {
		console.warn(
			`Sandbox '${this._name}': kernel warmup probe did not observe marker within deadline after ${attempts} attempt(s); proceeding anyway`,
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
	 * @param waitPhase Phase to long-poll for. See {@link SandboxClient.get}.
	 * @param waitTimeout How long the backend may hold the request when
	 *   `waitPhase` is set. See {@link SandboxClient.get}.
	 */
	async refresh(requestTimeout?: number, waitPhase?: string, waitTimeout?: number): Promise<void> {
		this.checkUsable();
		const info = await this._client.get(this._name, requestTimeout, waitPhase, waitTimeout);
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
