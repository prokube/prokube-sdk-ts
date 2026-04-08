export enum SandboxStatus {
	Pending = "Pending",
	Running = "Running",
	Paused = "Paused",
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

export interface PoolInfo {
	name: string;
	workspace: string;
	replicas: number;
	readyReplicas: number;
	image?: string;
	cpu?: string;
	memory?: string;
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
	envVars?: EnvVar[];
	secretRefs?: string[];
}

// ---- Internal request models ----

export interface ClaimRequest {
	poolName: string;
	volumeSize?: string;
}

export interface CreateRequest {
	image: string;
	name?: string;
	volumeSize?: string;
	cpu?: string;
	memory?: string;
	allowInternetAccess?: boolean;
	envVars?: EnvVar[];
	secretRefs?: string[];
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
	encoding: string;
}

// ---- Parsing helpers ----

export function parseStatus(value: string | undefined): SandboxStatus {
	if (!value) return SandboxStatus.Unknown;
	const match = Object.values(SandboxStatus).find((s) => s === value);
	return match ?? SandboxStatus.Unknown;
}

export function parseSandboxInfo(data: Record<string, unknown>, workspace: string): SandboxInfo {
	const name = (data.sandboxName ?? data.name) as string | undefined;
	if (!name) {
		throw new Error("Invalid API response: sandbox name is missing");
	}
	return {
		name,
		workspace,
		status: parseStatus((data.status ?? data.phase) as string | undefined),
		image: data.image as string | undefined,
		pool: (data.poolName ?? data.pool) as string | undefined,
		createdAt: (data.createdAt ?? data.created_at) as string | undefined,
	};
}

export function parseCodeResult(data: Record<string, unknown>): CodeResult {
	return {
		stdout: (data.stdout as string) ?? "",
		stderr: (data.stderr as string) ?? "",
		success: data.success === true,
		executionTimeMs: ((data.durationMs ?? data.execution_time_ms) as number) ?? 0,
		errorName: data.error_name as string | undefined,
		errorValue: data.error_value as string | undefined,
		traceback: data.traceback as string[] | undefined,
		sessionId: data.session_id as string | undefined,
	};
}

export function parseCommandResult(data: Record<string, unknown>): CommandResult {
	return {
		stdout: (data.stdout as string) ?? "",
		stderr: (data.stderr as string) ?? "",
		exitCode: ((data.exitCode ?? data.exit_code) as number) ?? -1,
		durationMs: ((data.durationMs ?? data.duration_ms) as number) ?? 0,
	};
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
