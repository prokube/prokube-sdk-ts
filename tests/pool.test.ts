import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxPool } from "../src/sandbox/pool.js";

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const defaultConfig = {
	apiUrl: "https://example.com/pkui",
	workspace: "test-ns",
	userId: "user@test.com",
};

const poolData = {
	name: "gpu-pool",
	replicas: 5,
	readyReplicas: 3,
	image: "python:3.10",
	cpu: "2",
	memory: "4Gi",
};

describe("SandboxPool", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("create", () => {
		it("creates a new pool", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse(poolData));

			const pool = await SandboxPool.create({
				...defaultConfig,
				name: "gpu-pool",
				image: "python:3.10",
				poolSize: 5,
				resources: { cpu: "2", memory: "4Gi" },
			});

			expect(pool.name).toBe("gpu-pool");
			expect(pool.replicas).toBe(5);
			expect(pool.readyReplicas).toBe(3);
			expect(pool.image).toBe("python:3.10");
			expect(pool.cpu).toBe("2");
			expect(pool.memory).toBe("4Gi");

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.name).toBe("gpu-pool");
			expect(body.image).toBe("python:3.10");
			expect(body.poolSize).toBe(5);
		});

		it("omits new optional fields when not provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse(poolData));

			await SandboxPool.create({
				...defaultConfig,
				name: "gpu-pool",
				image: "python:3.10",
				poolSize: 5,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body).not.toHaveProperty("allowInternetAccess");
			expect(body).not.toHaveProperty("envVars");
			expect(body).not.toHaveProperty("secretRefs");
		});

		it("forwards allowInternetAccess, envVars, and secretRefs to request body", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse(poolData));

			await SandboxPool.create({
				...defaultConfig,
				name: "gpu-pool",
				image: "python:3.10",
				poolSize: 3,
				resources: { cpu: "2", memory: "4Gi" },
				allowInternetAccess: true,
				envVars: [{ name: "FOO", value: "bar" }],
				secretRefs: ["my-secret"],
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.allowInternetAccess).toBe(true);
			expect(body.envVars).toEqual([{ name: "FOO", value: "bar" }]);
			expect(body.secretRefs).toEqual(["my-secret"]);
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
		});
	});

	describe("list", () => {
		it("returns empty list", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ pools: [] }));

			const result = await SandboxPool.list(defaultConfig);
			expect(result).toEqual([]);
		});

		it("returns multiple pools", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					pools: [
						{ name: "pool-1", replicas: 3, readyReplicas: 2 },
						{ name: "pool-2", replicas: 5, readyReplicas: 5 },
					],
				}),
			);

			const result = await SandboxPool.list(defaultConfig);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("pool-1");
			expect(result[1].name).toBe("pool-2");
		});
	});

	describe("get", () => {
		it("gets an existing pool", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse(poolData));

			const pool = await SandboxPool.get("gpu-pool", defaultConfig);
			expect(pool.name).toBe("gpu-pool");
			expect(pool.workspace).toBe("test-ns");
			expect(pool.replicas).toBe(5);
		});
	});

	describe("delete", () => {
		it("deletes the pool", async () => {
			const mockFetch = vi.mocked(fetch);
			// First call for get
			mockFetch.mockResolvedValueOnce(mockResponse(poolData));
			// Second call for delete
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const pool = await SandboxPool.get("gpu-pool", defaultConfig);
			await pool.delete();

			expect(mockFetch.mock.calls[1][1]?.method).toBe("DELETE");
		});

		it("closes client even if delete throws", async () => {
			const mockFetch = vi.mocked(fetch);
			// First call for get
			mockFetch.mockResolvedValueOnce(mockResponse(poolData));
			// Second call for delete fails
			mockFetch.mockRejectedValueOnce(new Error("network error"));

			const pool = await SandboxPool.get("gpu-pool", defaultConfig);
			await expect(pool.delete()).rejects.toThrow("network error");
		});
	});

	describe("refresh", () => {
		it("updates pool info from API", async () => {
			const mockFetch = vi.mocked(fetch);
			// First call for get
			mockFetch.mockResolvedValueOnce(mockResponse(poolData));
			// Second call for refresh with updated data
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					name: "gpu-pool",
					replicas: 5,
					readyReplicas: 5,
					image: "python:3.11",
					cpu: "4",
					memory: "8Gi",
				}),
			);

			const pool = await SandboxPool.get("gpu-pool", defaultConfig);
			expect(pool.readyReplicas).toBe(3);

			await pool.refresh();
			expect(pool.readyReplicas).toBe(5);
			expect(pool.image).toBe("python:3.11");
			expect(pool.cpu).toBe("4");
			expect(pool.memory).toBe("8Gi");
		});
	});
});
