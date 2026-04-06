import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/common/config.js";
import { PoolNotFoundError } from "../src/common/errors.js";
import { PoolClient } from "../src/sandbox/pool-client.js";

function makeConfig(overrides: Partial<{ apiKey: string; userId: string }> = {}): Config {
	return new Config({
		apiUrl: "https://example.com/pkui",
		workspace: "test-ns",
		userId: "user@test.com",
		...overrides,
	});
}

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("PoolClient", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("path routing", () => {
		it("uses internal paths for user_id auth", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ pools: [], total: 0 }));

			const client = new PoolClient(makeConfig());
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/api/namespaces/test-ns/sandbox-pools");
		});

		it("uses external paths for api_key auth", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ pools: [], total: 0 }));

			const client = new PoolClient(makeConfig({ apiKey: "key-123", userId: undefined }));
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/sandbox/test-ns/sandbox-pools");
		});
	});

	describe("create", () => {
		it("sends correct body", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({ name: "my-pool", replicas: 3, readyReplicas: 0 }),
			);

			const client = new PoolClient(makeConfig());
			const info = await client.create("my-pool", "python:3.10", 3, "2", "4Gi");

			expect(info.name).toBe("my-pool");
			expect(info.replicas).toBe(3);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.name).toBe("my-pool");
			expect(body.image).toBe("python:3.10");
			expect(body.poolSize).toBe(3);
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
		});

		it("omits optional cpu and memory when not provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({ name: "my-pool", replicas: 2, readyReplicas: 0 }),
			);

			const client = new PoolClient(makeConfig());
			await client.create("my-pool", "python:3.10", 2);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.cpu).toBeUndefined();
			expect(body.memory).toBeUndefined();
		});
	});

	describe("list", () => {
		it("returns empty list", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ pools: [] }));

			const client = new PoolClient(makeConfig());
			const result = await client.list();
			expect(result).toEqual([]);
		});

		it("parses multiple pools", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					pools: [
						{ name: "pool-1", replicas: 3, readyReplicas: 2, image: "python:3.10" },
						{ name: "pool-2", replicas: 5, readyReplicas: 5, image: "node:18" },
					],
				}),
			);

			const client = new PoolClient(makeConfig());
			const result = await client.list();
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("pool-1");
			expect(result[0].replicas).toBe(3);
			expect(result[1].name).toBe("pool-2");
			expect(result[1].readyReplicas).toBe(5);
		});

		it("handles sandboxPools key", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					sandboxPools: [{ name: "pool-a", replicas: 1, readyReplicas: 0 }],
				}),
			);

			const client = new PoolClient(makeConfig());
			const result = await client.list();
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("pool-a");
		});
	});

	describe("get", () => {
		it("returns pool info", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					name: "my-pool",
					replicas: 3,
					readyReplicas: 2,
					image: "python:3.10",
				}),
			);

			const client = new PoolClient(makeConfig());
			const info = await client.get("my-pool");
			expect(info.name).toBe("my-pool");
			expect(info.replicas).toBe(3);
			expect(info.readyReplicas).toBe(2);
		});

		it("throws PoolNotFoundError on 404", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ detail: "Not found" }, 404));

			const client = new PoolClient(makeConfig());
			await expect(client.get("missing-pool")).rejects.toThrow(PoolNotFoundError);
		});
	});

	describe("delete", () => {
		it("sends DELETE request to pool path", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

			const client = new PoolClient(makeConfig());
			await client.delete("my-pool");

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/sandbox-pools/my-pool");
			expect(mockFetch.mock.calls[0][1]?.method).toBe("DELETE");
		});
	});
});
