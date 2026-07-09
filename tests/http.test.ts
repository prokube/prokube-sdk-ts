import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/common/config.js";
import {
	AuthenticationError,
	NotFoundError,
	PoolExhaustedError,
	ProKubeError,
} from "../src/common/errors.js";
import { HttpClient } from "../src/common/http.js";

function makeConfig(overrides: Partial<{ apiKey: string; userId: string }> = {}): Config {
	return new Config({
		apiUrl: "https://example.com/pkui",
		workspace: "test-ns",
		userId: "user@test.com",
		...overrides,
	});
}

describe("HttpClient", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("makes GET request and returns JSON", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: "ok" }), { status: 200 }));

		const client = new HttpClient(makeConfig());
		const result = await client.get("/api/test");
		expect(result).toEqual({ data: "ok" });
		expect(mockFetch).toHaveBeenCalledOnce();

		const call = mockFetch.mock.calls[0];
		expect(call[0]).toBe("https://example.com/pkui/api/test");
	});

	it("makes POST request with JSON body", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: "123" }), { status: 200 }));

		const client = new HttpClient(makeConfig());
		const result = await client.post("/api/create", { name: "test" });
		expect(result).toEqual({ id: "123" });

		const call = mockFetch.mock.calls[0];
		expect(call[1]?.body).toBe(JSON.stringify({ name: "test" }));
	});

	it("DELETE returns null on 204", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

		const client = new HttpClient(makeConfig());
		const result = await client.delete("/api/resource/1");
		expect(result).toBeNull();
	});

	it("getBytes returns binary content", async () => {
		const mockFetch = vi.mocked(fetch);
		const data = new Uint8Array([1, 2, 3]);
		mockFetch.mockResolvedValue(new Response(data, { status: 200 }));

		const client = new HttpClient(makeConfig());
		const result = await client.getBytes("/api/download");
		expect(result).toBeInstanceOf(Uint8Array);
	});

	it("throws NotFoundError on 404", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ detail: "Not found" }), { status: 404 }),
		);

		const client = new HttpClient(makeConfig());
		await expect(client.get("/api/missing")).rejects.toThrow(NotFoundError);
	});

	it("throws ProKubeError on 500", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ detail: "Internal error" }), { status: 500 }),
		);

		const client = new HttpClient(makeConfig());
		await expect(client.get("/api/error")).rejects.toThrow(ProKubeError);
	});

	it("throws AuthenticationError on 401", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 }),
		);

		const client = new HttpClient(makeConfig());
		await expect(client.get("/api/secure")).rejects.toThrow(AuthenticationError);
	});

	it("throws PoolExhaustedError for retryable pool exhaustion", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					reason: "pool_exhausted",
					detail: "No warm pool capacity is currently available",
				}),
				{
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "10" },
				},
			),
		);

		const client = new HttpClient(makeConfig());
		try {
			await client.post("/_platform/sandbox/test-ns/sandboxes/claim", { poolName: "pool" });
			throw new Error("Expected PoolExhaustedError");
		} catch (error) {
			expect(error).toBeInstanceOf(PoolExhaustedError);
			const poolError = error as PoolExhaustedError;
			expect(poolError.statusCode).toBe(429);
			expect(poolError.reason).toBe("pool_exhausted");
			expect(poolError.retryAfter).toBe("10");
			expect(poolError.message).toContain("No warm pool capacity");
		}
	});

	it("supports pool exhaustion responses using error field", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: "pool_exhausted", message: "Pool is empty" }), {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = new HttpClient(makeConfig());
		await expect(client.post("/claim", {})).rejects.toThrow(PoolExhaustedError);
	});

	it("supports FastAPI nested detail pool exhaustion responses", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					detail: {
						reason: "pool_exhausted",
						message: "Warm pool has no ready capacity.",
						poolName: "python-pool",
					},
				}),
				{
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "1" },
				},
			),
		);

		const client = new HttpClient(makeConfig());
		try {
			await client.post("/claim", { poolName: "python-pool" });
			throw new Error("Expected PoolExhaustedError");
		} catch (error) {
			expect(error).toBeInstanceOf(PoolExhaustedError);
			const poolError = error as PoolExhaustedError;
			expect(poolError.reason).toBe("pool_exhausted");
			expect(poolError.retryAfter).toBe("1");
			expect(poolError.message).toContain("Warm pool has no ready capacity");
		}
	});

	it("includes kubeflow-userid header for internal auth", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

		const client = new HttpClient(makeConfig());
		await client.get("/api/test");

		const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["kubeflow-userid"]).toBe("user@test.com");
	});

	it("does not require SDK auth headers without api_key or user_id", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

		const client = new HttpClient(makeConfig({ userId: undefined }));
		await client.get("/_platform/sandbox/ns/sandboxes");

		const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers["kubeflow-userid"]).toBeUndefined();
		expect(headers["content-type"]).toBe("application/json");
	});

	it("uses origin-only base URL for API key auth", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

		const client = new HttpClient(makeConfig({ apiKey: "key-123", userId: undefined }));
		await client.get("/sandbox/ns/test");

		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toBe("https://example.com/sandbox/ns/test");
		expect(url).not.toContain("/pkui");
	});

	it("preserves path prefix for no-api-key access", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

		const client = new HttpClient(makeConfig());
		await client.get("/_platform/sandbox/ns/sandboxes");

		const url = mockFetch.mock.calls[0][0] as string;
		expect(url).toBe("https://example.com/pkui/_platform/sandbox/ns/sandboxes");
	});
});
