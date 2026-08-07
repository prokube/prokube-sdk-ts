import { getAuthHeaders } from "./auth.js";
import type { Config } from "./config.js";
import {
	AuthenticationError,
	NotFoundError,
	PoolExhaustedError,
	ProKubeError,
	RequestTimeoutError,
} from "./errors.js";

interface ErrorResponseBody {
	detail?: unknown;
	error?: unknown;
	message?: unknown;
	reason?: unknown;
}

export class HttpClient {
	readonly config: Config;
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(config: Config) {
		this.config = config;
		this.headers = {
			...getAuthHeaders(config),
			"content-type": "application/json",
		};

		if (config.useApiKey) {
			// External: use origin only (strip path)
			const url = new URL(config.apiUrl);
			this.baseUrl = url.origin;
		} else {
			// Internal: use full URL with path prefix
			this.baseUrl = config.apiUrl;
		}
	}

	/**
	 * @param timeout Per-request timeout override in seconds. Defaults to
	 *   `config.timeout`. Callers polling toward a deadline (e.g.
	 *   `waitUntilReady`) should pass the remaining budget so a single
	 *   stalled request cannot outlast the caller's overall timeout.
	 */
	async get(path: string, params?: Record<string, string>, timeout?: number): Promise<unknown> {
		return this.request("GET", path, undefined, params, timeout);
	}

	/** @param timeout Per-request timeout override in seconds. See {@link get}. */
	async post(path: string, body?: unknown, timeout?: number): Promise<unknown> {
		return this.request("POST", path, body, undefined, timeout);
	}

	/** @param timeout Per-request timeout override in seconds. See {@link get}. */
	async delete(path: string, timeout?: number): Promise<unknown | null> {
		return this.perform(
			this.buildUrl(path),
			{ method: "DELETE", headers: this.headers },
			timeout,
			async (response) => {
				if (response.status === 204) return null;
				const text = await response.text();
				return text ? JSON.parse(text) : null;
			},
		);
	}

	/** @param timeout Per-request timeout override in seconds. See {@link get}. */
	async getBytes(
		path: string,
		params?: Record<string, string>,
		timeout?: number,
	): Promise<Uint8Array> {
		return this.perform(
			this.buildUrl(path, params),
			{ method: "GET", headers: this.headers },
			timeout,
			async (response) => new Uint8Array(await response.arrayBuffer()),
		);
	}

	close(): void {
		// No persistent connections to clean up with native fetch.
		// Provided for API compatibility with the Python SDK.
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
		timeout?: number,
	): Promise<unknown> {
		return this.perform(
			this.buildUrl(path, params),
			{
				method,
				headers: this.headers,
				body: body != null ? JSON.stringify(body) : undefined,
			},
			timeout,
			async (response) => {
				const text = await response.text();
				return text ? JSON.parse(text) : {};
			},
		);
	}

	/**
	 * Run one request under a timeout budget, then hand the response to
	 * `consume`.
	 *
	 * The abort signal stays armed while the body is read, so a response that
	 * stalls mid-stream is bounded too. Abort-by-timeout is normalized into
	 * {@link RequestTimeoutError} so lifecycle polling loops can retry it
	 * without swallowing genuine transport failures.
	 */
	private async perform<T>(
		url: string,
		init: RequestInit,
		timeout: number | undefined,
		consume: (response: Response) => Promise<T>,
	): Promise<T> {
		const seconds = timeout ?? this.config.timeout;
		// AbortSignal.timeout takes milliseconds and rejects immediately at 0,
		// so a sub-millisecond remaining budget is floored to 1ms rather than
		// silently becoming "no timeout".
		const signal = AbortSignal.timeout(Math.max(1, Math.ceil(seconds * 1000)));
		try {
			const response = await fetch(url, { ...init, signal });
			await this.handleError(response);
			return await consume(response);
		} catch (error) {
			if (isTimeoutAbort(error)) {
				throw new RequestTimeoutError(`Request to ${url} timed out after ${seconds}s`);
			}
			throw error;
		}
	}

	private buildUrl(path: string, params?: Record<string, string>): string {
		const normalized = path.startsWith("/") ? path : `/${path}`;
		const url = new URL(`${this.baseUrl}${normalized}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}
		return url.toString();
	}

	private async handleError(response: Response): Promise<void> {
		if (response.ok) return;

		let body: ErrorResponseBody = {};
		let detail: string;
		try {
			body = (await response.json()) as ErrorResponseBody;
			const detailBody = objectValue(body.detail);
			detail =
				stringValue(body.detail) ??
				stringValue(body.message) ??
				stringValue(detailBody?.message) ??
				response.statusText;
		} catch {
			detail = response.statusText;
		}
		const detailBody = objectValue(body.detail);
		const reason =
			stringValue(body.reason) ??
			stringValue(body.error) ??
			stringValue(detailBody?.reason) ??
			stringValue(detailBody?.error);

		if (response.status === 429 && reason === "pool_exhausted") {
			throw new PoolExhaustedError(
				detail || "No warm pool capacity is currently available; retry the claim later.",
				response.headers.get("retry-after") ?? undefined,
			);
		}

		const message = `HTTP ${response.status}: ${detail}`;

		if (response.status === 401 || response.status === 403) {
			throw new AuthenticationError(message, response.status);
		}
		if (response.status === 404) {
			throw new NotFoundError(message, response.status);
		}
		throw new ProKubeError(message, response.status);
	}
}

/**
 * Detect a fetch rejection caused by our own {@link AbortSignal.timeout}.
 *
 * Runtimes disagree on how the abort reason surfaces: undici rejects with the
 * `TimeoutError` DOMException directly, others wrap it as an `AbortError` or
 * bury it in `cause`. Walk a bounded slice of the cause chain to cover all
 * three without risking a cycle.
 */
function isTimeoutAbort(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current != null && depth < 5; depth++) {
		if (typeof current !== "object") return false;
		if ("name" in current) {
			const name = current.name;
			if (name === "TimeoutError" || name === "AbortError") return true;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
