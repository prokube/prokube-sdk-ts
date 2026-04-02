import { getAuthHeaders } from "./auth.js";
import type { Config } from "./config.js";
import { AuthenticationError, NotFoundError, ProKubeError } from "./errors.js";

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

	async get(path: string, params?: Record<string, string>): Promise<unknown> {
		return this.request("GET", path, undefined, params);
	}

	async post(path: string, body?: unknown): Promise<unknown> {
		return this.request("POST", path, body);
	}

	async delete(path: string): Promise<unknown | null> {
		const url = this.buildUrl(path);
		const response = await fetch(url, {
			method: "DELETE",
			headers: this.headers,
		});
		await this.handleError(response);
		if (response.status === 204) return null;
		const text = await response.text();
		return text ? JSON.parse(text) : null;
	}

	async getBytes(path: string, params?: Record<string, string>): Promise<Uint8Array> {
		const url = this.buildUrl(path, params);
		const response = await fetch(url, {
			method: "GET",
			headers: this.headers,
		});
		await this.handleError(response);
		return new Uint8Array(await response.arrayBuffer());
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
	): Promise<unknown> {
		const url = this.buildUrl(path, params);
		const response = await fetch(url, {
			method,
			headers: this.headers,
			body: body != null ? JSON.stringify(body) : undefined,
		});
		await this.handleError(response);
		const text = await response.text();
		return text ? JSON.parse(text) : {};
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

		let detail: string;
		try {
			const data = (await response.json()) as { detail?: string };
			detail = data.detail ?? response.statusText;
		} catch {
			detail = response.statusText;
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
