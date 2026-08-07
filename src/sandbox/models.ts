/**
 * Lifecycle phase of a sandbox.
 *
 * Since pk-sandbox v0.8 every mutation is admission-only, so the
 * transitional phases `Pausing`, `Resuming` and `Deleting` are observable
 * between a request being accepted and the backend settling it.
 */
export enum SandboxStatus {
	Pending = "Pending",
	Running = "Running",
	Paused = "Paused",
	/** Pause accepted; the pod is being torn down. Settles on `Paused`. */
	Pausing = "Pausing",
	/** Resume accepted; a new pod is starting. Settles on `Running`. */
	Resuming = "Resuming",
	/** Delete accepted; teardown and persistence purge are in flight. */
	Deleting = "Deleting",
	/**
	 * @deprecated Never returned by pk-sandbox v0.8 or later backends. Kept
	 * so existing code that references it still compiles.
	 */
	Bound = "Bound",
	Succeeded = "Succeeded",
	Failed = "Failed",
	Unknown = "Unknown",
}

export interface SandboxInfo {
	name: string;
	workspace: string;
	status: SandboxStatus;
	image?: string;
	pool?: string;
	createdAt?: string;
	autoIdleTimeoutSeconds?: number;
	/** Why the last lifecycle step failed. Set when the phase is `Failed`. */
	lastError?: string;
	/**
	 * @deprecated pk-sandbox v0.8 no longer reports warm-pool resume swaps,
	 * so this is never populated. Kept for source compatibility.
	 */
	resumedFromPool?: boolean;
}

/** One bounded page of sandbox information, as returned by the API. */
export interface SandboxInfoPage {
	sandboxes: SandboxInfo[];
	loaded: number;
	hasMore: boolean;
	continueToken?: string;
}

export interface CodeResult {
	stdout: string;
	stderr: string;
	success: boolean;
	executionTimeMs: number;
	errorName?: string;
	errorValue?: string;
	traceback?: string[];
	sessionId?: string;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

export interface FileInfo {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	modified?: string;
}

export interface FileWriteInput {
	path: string;
	content: string | Uint8Array;
}

export interface BatchFileWriteResult {
	index: number;
	path: string;
	success: boolean;
	error?: string;
}

export interface BatchFileWriteResponse {
	success: boolean;
	total: number;
	successCount: number;
	failureCount: number;
	results: BatchFileWriteResult[];
}

export interface PoolInfo {
	name: string;
	workspace: string;
	replicas: number;
	readyReplicas: number;
	image?: string;
	cpu?: string;
	memory?: string;
	autoIdleTimeoutSeconds?: number;
}

export interface EnvVar {
	name: string;
	value: string;
}

export interface ResourceRequests {
	cpu?: string;
	memory?: string;
}

export interface CreatePoolRequest {
	name: string;
	image: string;
	poolSize: number;
	cpu?: string;
	memory?: string;
	allowInternetAccess?: boolean;
	autoIdleTimeoutSeconds?: number;
	envVars?: EnvVar[];
	secretRefs?: string[];
}

export interface CreateSandboxRequest {
	image: string;
	name?: string;
	volumeSize?: string;
	cpu?: string;
	memory?: string;
	allowInternetAccess?: boolean;
	autoIdleTimeoutSeconds?: number;
	envVars?: EnvVar[];
	secretRefs?: string[];
}

// ---- Request models ----

export interface ClaimRequest {
	poolName: string;
	volumeSize?: string;
	autoIdleTimeoutSeconds?: number;
}

export interface ExecRequest {
	code: string;
	use_jupyter: boolean;
	timeout: number;
	language?: string;
	session_id?: string;
	reset_session?: boolean;
}

export interface FileWriteRequest {
	path: string;
	content: string;
	encoding?: "text" | "base64";
}

export interface BatchFileWriteRequest {
	items: FileWriteRequest[];
}

// ---- Parsing helpers ----

/**
 * @param fallback Phase to assume when the body reports none. Admission-only
 *   endpoints (claim/create/pause/resume) know the phase they just requested,
 *   so they pass it instead of falling back to `Unknown`.
 */
export function parseStatus(
	value: string | undefined,
	fallback: SandboxStatus = SandboxStatus.Unknown,
): SandboxStatus {
	if (!value) return fallback;
	const match = Object.values(SandboxStatus).find((s) => s === value);
	return match ?? SandboxStatus.Unknown;
}

/**
 * Build a {@link SandboxInfo} from one raw backend Sandbox body.
 *
 * Every sandbox endpoint returns this same shape, so list/get/create/claim/
 * pause/resume all share this parser. The backend has used both camelCase and
 * snake_case spellings and reports the phase as either `status` or `phase`;
 * accept every spelling so the endpoints stay in sync.
 */
export function parseSandboxInfo(
	data: Record<string, unknown>,
	workspace: string,
	defaultStatus: SandboxStatus = SandboxStatus.Unknown,
): SandboxInfo {
	const name = stringField(data, "name");
	if (!name) {
		throw new Error("Invalid API response: sandbox name is missing");
	}
	return {
		name,
		workspace,
		status: parseStatus(stringField(data, "status", "phase"), defaultStatus),
		image: stringField(data, "image"),
		pool: stringField(data, "poolName", "pool"),
		createdAt: stringField(data, "createdAt", "created_at"),
		autoIdleTimeoutSeconds: numberField(
			data,
			"autoIdleTimeoutSeconds",
			"auto_idle_timeout_seconds",
		),
		lastError: stringField(data, "lastError", "last_error"),
	};
}

/** First key present as a non-empty string, mirroring the backend's aliases. */
function stringField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

/** First key present as a real number; booleans and NaN are rejected. */
function numberField(data: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function parseCodeResult(data: Record<string, unknown>): CodeResult {
	const timedOut = isTimeoutExecutionResponse(data);
	return {
		stdout: (data.stdout as string) ?? "",
		stderr: (data.stderr as string) ?? "",
		success: data.success === true && !timedOut,
		executionTimeMs: ((data.durationMs ?? data.execution_time_ms) as number) ?? 0,
		errorName: (data.errorName ?? data.error_name) as string | undefined,
		errorValue: (data.errorValue ?? data.error_value) as string | undefined,
		traceback: data.traceback as string[] | undefined,
		sessionId: data.session_id as string | undefined,
	};
}

export function parseCommandResult(data: Record<string, unknown>): CommandResult {
	const timedOut = isTimeoutExecutionResponse(data);
	const exitCode = ((data.exitCode ?? data.exit_code) as number | undefined) ?? -1;
	return {
		stdout: (data.stdout as string) ?? "",
		stderr: (data.stderr as string) ?? "",
		exitCode: timedOut ? -1 : exitCode,
		durationMs: ((data.durationMs ?? data.duration_ms) as number) ?? 0,
	};
}

function isTimeoutExecutionResponse(data: Record<string, unknown>): boolean {
	const errorNames = [data.error_name, data.errorName];
	if (errorNames.some((value) => typeof value === "string" && /timeout/i.test(value))) {
		return true;
	}

	const structuredValues = [data.error_value, data.errorValue, data.detail];
	if (
		structuredValues.some(
			(value) => typeof value === "string" && /\btime(?:d)?\s*out\b/i.test(value),
		)
	) {
		return true;
	}

	return typeof data.stderr === "string" && isTimeoutStderr(data.stderr);
}

function isTimeoutStderr(value: string): boolean {
	return (
		/^\s*\[?timeout\b/i.test(value) || /\b(?:execution|command|code)\s+timed\s+out\b/i.test(value)
	);
}

export function parseFileInfo(data: Record<string, unknown>): FileInfo {
	return {
		name: data.name as string,
		path: data.path as string,
		isDir: ((data.isDir ?? data.is_dir) as boolean) ?? false,
		size: (data.size as number) ?? 0,
		modified: data.modified as string | undefined,
	};
}

export function parseBatchFileWriteResponse(data: Record<string, unknown>): BatchFileWriteResponse {
	if (data.results !== undefined && !Array.isArray(data.results)) {
		throw new Error("Invalid API response: batch results must be an array");
	}

	const rawResults = (data.results ?? []) as unknown[];
	const results = rawResults.map((item, index) => {
		if (typeof item !== "object" || item === null) {
			throw new Error(`Invalid API response: batch result ${index} must be an object`);
		}
		const result = item as Record<string, unknown>;

		const path = result.path;
		if (typeof path !== "string" || path.length === 0) {
			throw new Error(`Invalid API response: batch result ${index} is missing path`);
		}

		const resultIndex = result.index;
		if (typeof resultIndex !== "number" || !Number.isInteger(resultIndex)) {
			throw new Error(
				`Invalid API response: batch result ${index} is missing or has invalid index`,
			);
		}

		return {
			index: resultIndex,
			path,
			success: result.success === true,
			error: typeof result.error === "string" ? result.error : undefined,
		};
	});

	const total = typeof data.total === "number" ? data.total : results.length;
	const successCount =
		typeof data.successCount === "number"
			? data.successCount
			: typeof data.success_count === "number"
				? data.success_count
				: results.filter((item) => item.success).length;
	const failureCount =
		typeof data.failureCount === "number"
			? data.failureCount
			: typeof data.failure_count === "number"
				? data.failure_count
				: Math.max(total - successCount, 0);

	return {
		success: data.success === true,
		total,
		successCount: successCount,
		failureCount,
		results,
	};
}

export function parsePoolInfo(data: Record<string, unknown>, workspace: string): PoolInfo {
	const name = (data.name ?? data.poolName) as string | undefined;
	if (!name) {
		throw new Error("Invalid API response: pool name is missing");
	}
	const status = (data.status ?? {}) as Record<string, unknown>;
	return {
		name,
		workspace,
		replicas: (data.replicas ?? data.poolSize ?? 0) as number,
		readyReplicas: (status.warmPods ??
			status.availablePods ??
			data.readyReplicas ??
			data.ready_replicas ??
			0) as number,
		image: data.image as string | undefined,
		cpu: data.cpu as string | undefined,
		memory: data.memory as string | undefined,
		autoIdleTimeoutSeconds: (data.autoIdleTimeoutSeconds ?? data.auto_idle_timeout_seconds) as
			| number
			| undefined,
	};
}

/** Convenience: check if a CommandResult succeeded (exit code 0). */
export function commandSuccess(result: CommandResult): boolean {
	return result.exitCode === 0;
}

/** Convenience: combined stdout + stderr. */
export function combinedOutput(result: CodeResult | CommandResult): string {
	return result.stdout + result.stderr;
}
