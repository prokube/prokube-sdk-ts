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
				// Opt out of the post-create warmup probe for this unit
				// test; the probe path is covered by dedicated tests
				// below.
				waitUntilReady: false,
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
				waitUntilReady: false,
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
				waitUntilReady: false,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.allowInternetAccess).toBe(true);
			expect(body.envVars).toEqual([{ name: "FOO", value: "bar" }]);
			expect(body.secretRefs).toEqual(["my-secret"]);
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
		});

		describe("warmup", () => {
			// Helper: respond to a probe /exec call by echoing back the marker.
			// See tests/sandbox.test.ts for the same helper used against
			// Sandbox.waitUntilReady directly.
			function probeRespond(body: string): Response {
				const parsed = JSON.parse(body);
				const code = parsed.code as string;
				const match = code.match(/print\("(__pk_warmup_[a-f0-9]+__)"\)/);
				if (!match) {
					throw new Error(`Unexpected probe request body: ${body}`);
				}
				return mockResponse({
					stdout: `${match[1]}\n`,
					stderr: "",
					success: true,
					durationMs: 5,
					session_id: "sess-warm",
				});
			}

			const readyPoolData = {
				name: "warm-pool",
				replicas: 1,
				readyReplicas: 1,
				image: "python:3.10",
				cpu: "1",
				memory: "1Gi",
			};

			it("warms pool pods when waitUntilReady is true (default)", async () => {
				const mockFetch = vi.mocked(fetch);
				// 1. POST create pool — already has ready replicas.
				mockFetch.mockResolvedValueOnce(mockResponse(readyPoolData));
				// 2. GET pool — warmPoolPods refreshes BEFORE the first
				//    sleep so an already-ready pool is detected immediately
				//    without burning a 2s poll interval.
				mockFetch.mockResolvedValueOnce(mockResponse(readyPoolData));
				// 3. POST claim sandbox from pool.
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-warm", status: "Running" }));
				// 4. GET sandbox (waitUntilReady -> refresh).
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-warm", status: "Running" }));
				// 5. POST /exec — warmup probe echoing marker.
				mockFetch.mockImplementationOnce(async (_url, init) =>
					probeRespond((init as RequestInit).body as string),
				);
				// 6. DELETE sandbox (kill probe sbx).
				mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

				const pool = await SandboxPool.create({
					...defaultConfig,
					name: "warm-pool",
					image: "python:3.10",
					poolSize: 1,
					readyTimeout: 10,
				});

				expect(pool.name).toBe("warm-pool");

				// Must have made exactly one /exec call (the warmup probe)
				// before returning from create.
				const execCalls = mockFetch.mock.calls.filter((c) => {
					const url = c[0] as string;
					return url.includes("/exec");
				});
				expect(execCalls.length).toBe(1);

				// And must have claimed one sandbox from the pool.
				const claimCalls = mockFetch.mock.calls.filter((c) => {
					const url = c[0] as string;
					return url.includes("/sandboxes/claim");
				});
				expect(claimCalls.length).toBe(1);
			});

			it("opts out of warmup when waitUntilReady=false", async () => {
				const mockFetch = vi.mocked(fetch);
				mockFetch.mockResolvedValueOnce(mockResponse(readyPoolData));

				await SandboxPool.create({
					...defaultConfig,
					name: "warm-pool",
					image: "python:3.10",
					poolSize: 1,
					waitUntilReady: false,
				});

				// No probe exec and no claim — just the one create call.
				expect(mockFetch.mock.calls.length).toBe(1);
				const execCalls = mockFetch.mock.calls.filter((c) => {
					const url = c[0] as string;
					return url.includes("/exec");
				});
				expect(execCalls.length).toBe(0);
				const claimCalls = mockFetch.mock.calls.filter((c) => {
					const url = c[0] as string;
					return url.includes("/sandboxes/claim");
				});
				expect(claimCalls.length).toBe(0);
			});

			it("does not throw if warmup probe times out", async () => {
				const mockFetch = vi.mocked(fetch);
				// 1. POST create pool — already ready.
				mockFetch.mockResolvedValueOnce(mockResponse(readyPoolData));
				// 2+. Every subsequent call routes by URL/method:
				//   - GET on a sandbox-pools URL → return the ready pool
				//     (warmPoolPods refreshes before claiming).
				//   - POST claim → return a Running sandbox.
				//   - GET on a sandbox URL → return Running for the
				//     waitUntilReady refresh inside the probe.
				//   - POST /exec → return empty stdout so the probe never
				//     sees its marker and the warmup deadline trips.
				//   - DELETE → 204 for kill().
				// The probe should time out but the outer create must
				// still resolve.
				mockFetch.mockImplementation(async (url, init) => {
					const u = url as string;
					const method = (init as RequestInit | undefined)?.method ?? "GET";
					if (method === "DELETE") {
						return new Response(null, { status: 204 });
					}
					if (u.includes("/exec")) {
						return mockResponse({
							stdout: "",
							stderr: "",
							success: true,
							durationMs: 5,
							session_id: "sess-warm",
						});
					}
					if (u.includes("/sandbox-pools")) {
						return mockResponse(readyPoolData);
					}
					if (u.includes("/sandboxes/claim")) {
						return mockResponse({ name: "sb-warm", status: "Running" });
					}
					// GET on a sandbox URL — used by Sandbox.refresh().
					return mockResponse({ name: "sb-warm", status: "Running" });
				});

				// Silence expected warnings from the unresolved probe and
				// from the best-effort warmup wrapper.
				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await expect(
						SandboxPool.create({
							...defaultConfig,
							name: "warm-pool",
							image: "python:3.10",
							poolSize: 1,
							readyTimeout: 2,
						}),
					).resolves.toBeDefined();
				} finally {
					warnSpy.mockRestore();
				}
			}, 10000);

			it("does not throw if pool readiness never reaches the desired count", async () => {
				// Pool is created but readyReplicas stays below replicas for the
				// entire readyTimeout window. warmPoolPods must:
				//   - log a warning,
				//   - return the pool anyway (best-effort),
				//   - NOT attempt a claim or /exec probe (the probe phase is
				//     gated on readiness succeeding).
				const notReadyPoolData = {
					name: "warm-pool",
					replicas: 1,
					readyReplicas: 0,
					image: "python:3.10",
					cpu: "1",
					memory: "1Gi",
				};

				const mockFetch = vi.mocked(fetch);
				// 1. POST create pool — desired=1, ready=0.
				mockFetch.mockResolvedValueOnce(mockResponse(notReadyPoolData));
				// 2+. Every refresh keeps the pool below desired so the
				//     readiness loop eventually trips its readyTimeout.
				//     Any other call (claim, /exec) would mean the probe
				//     phase ran — which is what this test asserts must NOT
				//     happen.
				mockFetch.mockImplementation(async (url, init) => {
					const u = url as string;
					const method = (init as RequestInit | undefined)?.method ?? "GET";
					if (u.includes("/sandbox-pools")) {
						return mockResponse(notReadyPoolData);
					}
					throw new Error(
						`unexpected ${method} ${u} — readiness never succeeded so no claim/probe should run`,
					);
				});

				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					await expect(
						SandboxPool.create({
							...defaultConfig,
							name: "warm-pool",
							image: "python:3.10",
							poolSize: 1,
							readyTimeout: 1,
						}),
					).resolves.toBeDefined();
				} finally {
					warnSpy.mockRestore();
				}

				// Must not have made a claim or /exec call.
				const claimCalls = mockFetch.mock.calls.filter((c) =>
					(c[0] as string).includes("/sandboxes/claim"),
				);
				const execCalls = mockFetch.mock.calls.filter((c) =>
					(c[0] as string).includes("/exec"),
				);
				expect(claimCalls.length).toBe(0);
				expect(execCalls.length).toBe(0);
			}, 10000);
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
