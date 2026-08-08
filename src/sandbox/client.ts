import { checkBackendCompatibility } from "../common/compat.js";
import type { Config } from "../common/config.js";
import {
	NotFoundError,
	PoolNotFoundError,
	ProKubeError,
	SandboxError,
	SandboxNotFoundError,
} from "../common/errors.js";
import { HttpClient } from "../common/http.js";
import { uint8ArrayToBase64 } from "./base64.js";
import {
	type BatchFileWriteResponse,
	type CodeResult,
	type CommandResult,
	type CreateSandboxRequest,
	type FileInfo,
	type FileWriteInput,
	type SandboxInfo,
	type SandboxInfoPage,
	SandboxStatus,
	parseBatchFileWriteResponse,
	parseCodeResult,
	parseCommandResult,
	parseFileInfo,
	parseSandboxInfo,
} from "./models.js";

const textEncoder = new TextEncoder();

/**
 * Long-poll status GET (`?wait_phase=&timeout=`) tuning. The backend caps the
 * hold at 30s and defaults to 20s; the SDK mirrors those numbers so it never
 * asks for a window the backend would silently shorten. The margin is how
 * much longer than the hold a request is allowed to take, covering the round
 * trip of a response that only arrives when the hold expires.
 */
const DEFAULT_WAIT_TIMEOUT_SECONDS = 20;
const MAX_WAIT_TIMEOUT_SECONDS = 30;
const WAIT_REQUEST_MARGIN_SECONDS = 5;

/** Options for one page of {@link SandboxClient.listPage}. */
export interface ListPageOptions {
	/** Page size, 1–100 (default: 25). */
	limit?: number;
	/** Opaque keyset cursor from the previous page's `continueToken`. */
	continueToken?: string;
}

export class SandboxClient {
	private readonly http: HttpClient;
	private readonly workspace: string;
	private readonly checkVersion: boolean;
	private compatibilityChecked: Promise<void> | undefined;

	/**
	 * @param checkVersion Whether {@link ensureCompatibility} performs the
	 *   backend version check. Pass `false` for the extra clients built per
	 *   listing result, whose compatibility the listing client already
	 *   verified.
	 */
	constructor(config: Config, checkVersion = true) {
		this.http = new HttpClient(config);
		this.workspace = config.workspace;
		this.checkVersion = checkVersion;
	}

	/**
	 * Verify backend compatibility once, before the first real request.
	 *
	 * The Python SDK does this in `SandboxClient.__init__`; TypeScript
	 * constructors cannot await, so the `Sandbox` factories call this
	 * explicitly. Resolves immediately (and only warns, never throws) when
	 * the check is disabled, uses API-key auth, or has already run.
	 */
	async ensureCompatibility(): Promise<void> {
		if (!this.checkVersion) return;
		this.compatibilityChecked ??= checkBackendCompatibility(this.http);
		return this.compatibilityChecked;
	}

	// ---- Path helpers ----

	private sandboxesPath(): string {
		if (this.http.config.useApiKey) {
			return `/sandbox/${this.workspace}/sandboxes`;
		}
		return `/_platform/sandbox/${this.workspace}/sandboxes`;
	}

	private sandboxPath(name: string): string {
		return `${this.sandboxesPath()}/${name}`;
	}

	private sandboxSubPath(name: string, sub: string): string {
		return `${this.sandboxPath(name)}/${sub}`;
	}

	// ---- Sandbox lifecycle ----

	/**
	 * Claim a sandbox from a warm pool.
	 *
	 * The backend accepts the claim with HTTP 202 and adopts a warm pod
	 * asynchronously, so the returned sandbox usually starts out `Pending`.
	 * Poll {@link get} until it is `Running`.
	 */
	async claimFromPool(
		pool: string,
		volumeSize?: string,
		autoIdleTimeoutSeconds?: number,
	): Promise<SandboxInfo> {
		const body: Record<string, unknown> = { poolName: pool };
		if (volumeSize !== undefined) body.volumeSize = volumeSize;
		if (autoIdleTimeoutSeconds !== undefined) {
			body.autoIdleTimeoutSeconds = autoIdleTimeoutSeconds;
		}

		let data: Record<string, unknown>;
		try {
			data = (await this.http.post(`${this.sandboxesPath()}/claim`, body)) as Record<
				string,
				unknown
			>;
		} catch (e) {
			if (e instanceof NotFoundError) {
				throw new PoolNotFoundError(`Pool '${pool}' not found`);
			}
			throw e;
		}
		const info = parseSandboxInfo(data, this.workspace, SandboxStatus.Pending);
		return {
			...info,
			pool: info.pool ?? pool,
			autoIdleTimeoutSeconds: info.autoIdleTimeoutSeconds ?? autoIdleTimeoutSeconds,
		};
	}

	/**
	 * Create a new sandbox.
	 *
	 * The backend accepts the request with HTTP 202; the sandbox starts out
	 * `Pending`. Poll {@link get} until it is `Running`.
	 */
	async create(params: CreateSandboxRequest): Promise<SandboxInfo> {
		const {
			image,
			name,
			volumeSize,
			cpu,
			memory,
			allowInternetAccess,
			autoIdleTimeoutSeconds,
			envVars,
			secretRefs,
		} = params;

		// Use `!== undefined` for every optional field so that explicit
		// falsy/empty values ("", "0") are forwarded to the backend (which
		// can then validate/reject them) instead of being silently dropped
		// by truthiness checks. Only `undefined` means "caller didn't set
		// this — use the backend default".
		const body: Record<string, unknown> = { image };
		if (name !== undefined) body.name = name;
		if (volumeSize !== undefined) body.volumeSize = volumeSize;
		if (cpu !== undefined) body.cpu = cpu;
		if (memory !== undefined) body.memory = memory;
		if (allowInternetAccess !== undefined) body.allowInternetAccess = allowInternetAccess;
		if (autoIdleTimeoutSeconds !== undefined) {
			body.autoIdleTimeoutSeconds = autoIdleTimeoutSeconds;
		}
		if (envVars !== undefined) body.envVars = envVars;
		if (secretRefs !== undefined) body.secretRefs = secretRefs;

		// The backend has two create wire shapes: the internal route's
		// CreateSandboxRequest nests cpu/memory under `resources` (and
		// silently ignores the top-level keys), while the external API-key
		// route's ExternalCreateRequest takes them flat (and ignores
		// `resources`). Send both so sizing is never dropped; each route
		// reads its own shape.
		const resources: Record<string, string> = {};
		if (cpu !== undefined) resources.cpu = cpu;
		if (memory !== undefined) resources.memory = memory;
		if (Object.keys(resources).length > 0) body.resources = resources;

		const data = (await this.http.post(this.sandboxesPath(), body)) as Record<string, unknown>;
		const info = parseSandboxInfo(data, this.workspace, SandboxStatus.Pending);
		return {
			...info,
			image: info.image ?? image,
			autoIdleTimeoutSeconds: info.autoIdleTimeoutSeconds ?? autoIdleTimeoutSeconds,
		};
	}

	async list(): Promise<SandboxInfo[]> {
		const data = (await this.http.get(this.sandboxesPath())) as Record<string, unknown>;
		const sandboxes = (data.sandboxes ?? []) as Record<string, unknown>[];
		return sandboxes.map((s) => parseSandboxInfo(s, this.workspace));
	}

	/**
	 * List one bounded page of sandboxes.
	 *
	 * There is exactly one name-ordered listing across every sandbox state.
	 * The continuation token is an opaque keyset cursor, and the backend
	 * requires `limit` to be present whenever `continueToken` is supplied.
	 * An empty token means "no token": the backend rejects `continueToken=`
	 * with HTTP 422, so it is treated the same as omitting it and requests
	 * the first page.
	 */
	async listPage(options: ListPageOptions = {}): Promise<SandboxInfoPage> {
		const limit = options.limit ?? 25;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new RangeError("limit must be between 1 and 100");
		}

		const params: Record<string, string> = { limit: String(limit) };
		if (options.continueToken) params.continueToken = options.continueToken;

		const data = (await this.http.get(this.sandboxesPath(), params)) as Record<string, unknown>;
		const sandboxes = (data.sandboxes ?? []) as Record<string, unknown>[];
		const infos = sandboxes.map((s) => parseSandboxInfo(s, this.workspace));
		return {
			sandboxes: infos,
			loaded: typeof data.loaded === "number" ? data.loaded : infos.length,
			hasMore: data.hasMore === true,
			continueToken: typeof data.continueToken === "string" ? data.continueToken : undefined,
		};
	}

	/**
	 * Get information about a sandbox. This is the poll target for every
	 * asynchronous lifecycle operation.
	 *
	 * @param requestTimeout Per-request timeout override in seconds. Callers
	 *   polling toward a deadline should pass the remaining budget so a single
	 *   stalled request cannot outlast their overall timeout.
	 * @param waitPhase Phase to long-poll for (e.g. `Running`). When given, the
	 *   backend holds the request open until the sandbox reaches that phase or
	 *   its own wait window elapses, and answers with the current payload
	 *   either way — a response that still reports another phase is a normal
	 *   timeout, not an error. Backends that predate the parameter ignore it
	 *   and answer immediately, which degrades to plain polling.
	 * @param waitTimeout How long, in seconds, the backend may hold the request
	 *   when `waitPhase` is set. Defaults to 20s and is clamped both to the
	 *   server-side cap and to what `requestTimeout` can outlast.
	 */
	async get(
		name: string,
		requestTimeout?: number,
		waitPhase?: string,
		waitTimeout?: number,
	): Promise<SandboxInfo> {
		let params: Record<string, string> | undefined;
		if (waitPhase !== undefined) {
			let hold = Math.floor(
				Math.min(MAX_WAIT_TIMEOUT_SECONDS, waitTimeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS),
			);
			if (requestTimeout !== undefined) {
				// The server holds the connection for the whole wait window
				// before answering, so the per-request timeout must outlast it.
				// Leave a margin for the response trip so a long-poll that
				// answers right at its cap still lands. Once too little budget
				// is left to hold anything, fall back to a plain status GET.
				hold = Math.min(hold, Math.floor(requestTimeout) - WAIT_REQUEST_MARGIN_SECONDS);
			}
			if (hold >= 1) params = { wait_phase: waitPhase, timeout: String(hold) };
		}
		try {
			const data = (await this.http.get(this.sandboxPath(name), params, requestTimeout)) as
				| Record<string, unknown>
				| undefined;
			return parseSandboxInfo(data ?? {}, this.workspace);
		} catch (e) {
			if (e instanceof NotFoundError) {
				throw new SandboxNotFoundError(`Sandbox '${name}' not found`);
			}
			throw e;
		}
	}

	/**
	 * Block on the sandbox agent until its Jupyter kernel is warm.
	 *
	 * Calls `GET <sandbox>/ping?wait=kernel&timeout=<waitTimeout>` on the
	 * sandbox agent (the same per-sandbox base path `exec` uses, so it is
	 * proxied exactly like code execution). Resolving means the agent answered
	 * 200 — the kernel has started.
	 *
	 * @throws NotFoundError if the agent (or the proxy in front of it) does not
	 *   expose the endpoint — an older agent, so the caller must fall back to
	 *   probing the kernel through `exec`.
	 * @throws ProKubeError on any other non-2xx answer. `statusCode === 503`
	 *   means the kernel is not warm yet and the call may be retried; 400/405
	 *   likewise indicate an agent without this endpoint.
	 */
	async pingKernel(name: string, waitTimeout: number, requestTimeout?: number): Promise<void> {
		// The agent answers plain text ("pong"), not JSON: fetch bytes so the
		// shared error translation still runs without a JSON parse of the body.
		await this.http.getBytes(
			this.sandboxSubPath(name, "ping"),
			{ wait: "kernel", timeout: String(waitTimeout) },
			requestTimeout,
		);
	}

	/**
	 * Delete a sandbox.
	 *
	 * The backend accepts the request with HTTP 202 and an empty body, then
	 * tears the sandbox down — including purging its persistence records —
	 * asynchronously. Poll {@link get} until it throws
	 * {@link SandboxNotFoundError} to know the name has been released.
	 */
	async delete(name: string): Promise<void> {
		await this.http.delete(this.sandboxPath(name));
	}

	// ---- Pause / Resume ----

	/**
	 * Pause a running sandbox and return the accepted admission body.
	 *
	 * The backend accepts the request with HTTP 202 and reports phase
	 * `Pausing` until its worker settles the sandbox on `Paused`; poll
	 * {@link get} to observe the final phase. The phase in the returned
	 * {@link SandboxInfo} is the transitional `Pausing`, not the settled one.
	 */
	async pause(name: string): Promise<SandboxInfo> {
		try {
			const data = (await this.http.post(this.sandboxSubPath(name, "pause"))) as Record<
				string,
				unknown
			>;
			return parseSandboxInfo(data, this.workspace, SandboxStatus.Pausing);
		} catch (e) {
			if (e instanceof ProKubeError && e.statusCode === 409) {
				throw new SandboxError(`Cannot pause sandbox '${name}': not in Running state`, 409);
			}
			throw e;
		}
	}

	/**
	 * Resume a paused sandbox and return the accepted admission body.
	 *
	 * The backend accepts the request with HTTP 202 and reports phase
	 * `Resuming` until the new pod is up; poll {@link get} until `Running`.
	 * The phase in the returned {@link SandboxInfo} is the transitional
	 * `Resuming`.
	 */
	async resume(name: string): Promise<SandboxInfo> {
		try {
			const data = (await this.http.post(this.sandboxSubPath(name, "resume"))) as Record<
				string,
				unknown
			>;
			return parseSandboxInfo(data, this.workspace, SandboxStatus.Resuming);
		} catch (e) {
			if (e instanceof ProKubeError && e.statusCode === 409) {
				throw new SandboxError(`Cannot resume sandbox '${name}': not in Paused state`, 409);
			}
			throw e;
		}
	}

	// ---- Execution ----

	// Both exec entry points bound the fetch by
	// `max(config.timeout, <execution timeout>)`. Python sends exec through
	// the shared `httpx.Client`, built once with `timeout=self.config.timeout`
	// (see `prokube/common/http.py`), and `SandboxClient.exec_code` /
	// `exec_command` pass no per-request override — so the transport budget is
	// the configured timeout, with no extra grace on top of the execution
	// timeout. We keep that configured timeout as the floor (never shortening
	// a request that used to be allowed) and raise it to the caller's
	// execution budget when that is longer: otherwise
	// `execCode(..., timeout: 600)` under the default 300s config would abort
	// the fetch before the backend could answer.

	async execCode(
		name: string,
		code: string,
		language = "python",
		timeout = 300,
		sessionId?: string,
		resetSession = false,
	): Promise<CodeResult> {
		const body: Record<string, unknown> = {
			code,
			use_jupyter: true,
			timeout,
			language,
		};
		if (sessionId) body.session_id = sessionId;
		if (resetSession) body.reset_session = true;

		const data = (await this.http.post(
			this.sandboxSubPath(name, "exec"),
			body,
			Math.max(this.http.config.timeout, timeout),
		)) as Record<string, unknown>;

		return parseCodeResult(data);
	}

	async execCommand(name: string, command: string, timeout = 300): Promise<CommandResult> {
		const body = {
			code: command,
			use_jupyter: false,
			timeout,
		};

		const data = (await this.http.post(
			this.sandboxSubPath(name, "exec"),
			body,
			Math.max(this.http.config.timeout, timeout),
		)) as Record<string, unknown>;

		return parseCommandResult(data);
	}

	// ---- Files ----

	async writeFile(name: string, path: string, content: Uint8Array): Promise<void> {
		const base64 = uint8ArrayToBase64(content);
		await this.http.post(this.sandboxSubPath(name, "files"), {
			path,
			content: base64,
			encoding: "base64",
		});
	}

	async writeFilesBatch(name: string, items: FileWriteInput[]): Promise<BatchFileWriteResponse> {
		const data = (await this.http.post(this.sandboxSubPath(name, "files/batch"), {
			items: items.map((item) => ({
				path: item.path,
				content: uint8ArrayToBase64(
					typeof item.content === "string" ? textEncoder.encode(item.content) : item.content,
				),
				encoding: "base64",
			})),
		})) as Record<string, unknown>;
		return parseBatchFileWriteResponse(data);
	}

	async readFile(name: string, path: string): Promise<Uint8Array> {
		return this.http.getBytes(this.sandboxSubPath(name, "files/download"), {
			path,
		});
	}

	async listFiles(name: string, path = "/workspace"): Promise<FileInfo[]> {
		const data = (await this.http.get(this.sandboxSubPath(name, "files"), {
			path,
		})) as Record<string, unknown>;

		const files = (data.files ?? []) as Record<string, unknown>[];
		return files.map(parseFileInfo);
	}

	close(): void {
		this.http.close();
	}
}
