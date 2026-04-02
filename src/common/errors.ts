/**
 * Base error for all prokube.ai SDK errors.
 */
export class ProKubeError extends Error {
	readonly statusCode: number | undefined;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "ProKubeError";
		this.statusCode = statusCode;
	}
}

/**
 * Raised when authentication fails or credentials are missing.
 */
export class AuthenticationError extends ProKubeError {
	constructor(message: string, statusCode?: number) {
		super(message, statusCode);
		this.name = "AuthenticationError";
	}
}

/**
 * Raised when a resource is not found (HTTP 404).
 */
export class NotFoundError extends ProKubeError {
	constructor(message: string, statusCode?: number) {
		super(message, statusCode ?? 404);
		this.name = "NotFoundError";
	}
}

/**
 * Base error for sandbox-related failures.
 */
export class SandboxError extends ProKubeError {
	constructor(message: string, statusCode?: number) {
		super(message, statusCode);
		this.name = "SandboxError";
	}
}

/**
 * Raised when a specific sandbox cannot be found.
 */
export class SandboxNotFoundError extends SandboxError {
	constructor(message: string) {
		super(message, 404);
		this.name = "SandboxNotFoundError";
	}
}

/**
 * Raised when waiting for a sandbox exceeds the timeout.
 */
export class SandboxTimeoutError extends SandboxError {
	constructor(message: string) {
		super(message);
		this.name = "SandboxTimeoutError";
	}
}

/**
 * Raised when code or command execution fails at the infrastructure level.
 */
export class SandboxExecutionError extends SandboxError {
	constructor(message: string) {
		super(message);
		this.name = "SandboxExecutionError";
	}
}

/**
 * Raised when the requested warm pool does not exist.
 */
export class PoolNotFoundError extends SandboxError {
	constructor(message: string) {
		super(message, 404);
		this.name = "PoolNotFoundError";
	}
}

/**
 * Raised when no sandboxes are available in the warm pool.
 */
export class PoolExhaustedError extends SandboxError {
	constructor(message: string) {
		super(message);
		this.name = "PoolExhaustedError";
	}
}
