import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolExhaustedError, SandboxError } from "../src/common/errors.js";
import { SandboxStatus } from "../src/sandbox/models.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import {
	apiCalls,
	mockResponse,
	pingResponse,
	versionResponse,
	warmupProbeResponse,
} from "./helpers.js";

const defaultConfig = {
	apiUrl: "https://example.com/pkui",
	workspace: "test-ns",
	userId: "user@test.com",
};

describe("Sandbox", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.PROKUBE_API_URL = undefined;
		process.env.PROKUBE_WORKSPACE = undefined;
		process.env.PROKUBE_USER_ID = undefined;
		process.env.PROKUBE_API_KEY = undefined;
		process.env.KF_USER = undefined;
		process.env.KUBERNETES_SERVICE_HOST = undefined;
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	describe("fromPool", () => {
		it("claims sandbox from pool", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({ name: "sb-pool-1", status: "Running" }),
			);

			const sbx = await Sandbox.fromPool("gpu-pool", defaultConfig);
			expect(sbx.name).toBe("sb-pool-1");
			expect(sbx.status).toBe(SandboxStatus.Running);
		});

		it("claims from Agent Gateway in Kubernetes without SDK auth", async () => {
			process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
			process.env.PROKUBE_WORKSPACE = "test-ns";
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({ name: "sb-pool-1", status: "Running" }),
			);

			const sbx = await Sandbox.fromPool("gpu-pool");

			const claim = apiCalls(mockFetch)[0];
			const headers = claim[1]?.headers as Record<string, string>;
			expect(sbx.name).toBe("sb-pool-1");
			expect(String(claim[0])).toBe(
				"http://agentgateway-proxy.agentgateway-system.svc.cluster.local/_platform/sandbox/test-ns/sandboxes/claim",
			);
			expect(headers["x-api-key"]).toBeUndefined();
			expect(headers["kubeflow-userid"]).toBeUndefined();
		});

		it("sends volumeSize when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Running" }));

			await Sandbox.fromPool("pool", { ...defaultConfig, volumeSize: "20Gi" });
			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body.volumeSize).toBe("20Gi");
		});

		it("sends autoIdleTimeoutSeconds when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Running" }));

			const sbx = await Sandbox.fromPool("pool", { ...defaultConfig, autoIdleTimeoutSeconds: 900 });
			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body.autoIdleTimeoutSeconds).toBe(900);
			expect(sbx.autoIdleTimeoutSeconds).toBe(900);
		});

		it("surfaces retryable pool exhaustion distinctly", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({
							reason: "pool_exhausted",
							detail: "No warm pool capacity is currently available",
						}),
						{
							status: 429,
							headers: { "content-type": "application/json", "retry-after": "20" },
						},
					),
			);

			try {
				await Sandbox.fromPool("pool", defaultConfig);
				throw new Error("Expected PoolExhaustedError");
			} catch (error) {
				expect(error).toBeInstanceOf(PoolExhaustedError);
				const poolError = error as PoolExhaustedError;
				expect(poolError.statusCode).toBe(429);
				expect(poolError.reason).toBe("pool_exhausted");
				expect(poolError.retryAfter).toBe("20");
				expect(poolError.message).toContain("No warm pool capacity");
			}
		});
	});

	describe("create", () => {
		it("creates sandbox with image", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "my-sb", status: "Pending" }));

			const sbx = await Sandbox.create("python:3.10", {
				...defaultConfig,
				name: "my-sb",
			});
			expect(sbx.name).toBe("my-sb");
			expect(sbx.status).toBe(SandboxStatus.Pending);
		});

		it("sends volumeSize when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

			await Sandbox.create("python:3.10", {
				...defaultConfig,
				volumeSize: "10Gi",
			});
			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body.volumeSize).toBe("10Gi");
		});

		it("omits new optional fields when not provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

			await Sandbox.create("python:3.10", {
				...defaultConfig,
				name: "sb-1",
			});

			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body).not.toHaveProperty("cpu");
			expect(body).not.toHaveProperty("memory");
			expect(body).not.toHaveProperty("resources");
			expect(body).not.toHaveProperty("allowInternetAccess");
			expect(body).not.toHaveProperty("autoIdleTimeoutSeconds");
			expect(body).not.toHaveProperty("envVars");
			expect(body).not.toHaveProperty("secretRefs");
		});

		it("forwards resources, allowInternetAccess, envVars, and secretRefs", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

			await Sandbox.create("python:3.10", {
				...defaultConfig,
				name: "sb-1",
				resources: { cpu: "2", memory: "4Gi" },
				allowInternetAccess: true,
				envVars: [
					{ name: "FOO", value: "bar" },
					{ name: "BAZ", value: "qux" },
				],
				secretRefs: ["my-secret"],
			});

			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			// Both wire shapes: the internal route reads the nested `resources`
			// object, the external API-key route reads the flat keys. Sending
			// only one silently drops sizing on the other route.
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
			expect(body.resources).toEqual({ cpu: "2", memory: "4Gi" });
			expect(body.allowInternetAccess).toBe(true);
			expect(body.envVars).toEqual([
				{ name: "FOO", value: "bar" },
				{ name: "BAZ", value: "qux" },
			]);
			expect(body.secretRefs).toEqual(["my-secret"]);
		});

		it("forwards a partially specified resources object in both shapes", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

			await Sandbox.create("python:3.10", {
				...defaultConfig,
				resources: { cpu: "500m" },
			});

			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body.cpu).toBe("500m");
			expect(body.resources).toEqual({ cpu: "500m" });
			expect(body).not.toHaveProperty("memory");
		});

		it("forwards autoIdleTimeoutSeconds", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

			const sbx = await Sandbox.create("python:3.10", {
				...defaultConfig,
				autoIdleTimeoutSeconds: 1800,
			});

			const body = JSON.parse(apiCalls(mockFetch)[0][1]?.body as string);
			expect(body.autoIdleTimeoutSeconds).toBe(1800);
			expect(sbx.autoIdleTimeoutSeconds).toBe(1800);
		});
	});

	describe("get / connect", () => {
		it("gets existing sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({
					name: "existing-sb",
					status: "Running",
					image: "python:3.10",
				}),
			);

			const sbx = await Sandbox.get("existing-sb", defaultConfig);
			expect(sbx.name).toBe("existing-sb");
			expect(sbx.status).toBe(SandboxStatus.Running);
		});

		it("connect is alias for get", () => {
			expect(Sandbox.connect).toBe(Sandbox.get);
		});
	});

	describe("list", () => {
		it("returns empty list", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () => mockResponse({ sandboxes: [], total: 0 }));

			const result = await Sandbox.list(defaultConfig);
			expect(result).toEqual([]);
		});

		it("returns multiple sandboxes", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({
					sandboxes: [
						{ name: "sb-1", status: "Running" },
						{ name: "sb-2", status: "Paused" },
					],
					total: 2,
				}),
			);

			const result = await Sandbox.list(defaultConfig);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("sb-1");
			expect(result[1].name).toBe("sb-2");
		});

		it("filters by phase", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({
					sandboxes: [
						{ name: "sb-1", status: "Running" },
						{ name: "sb-2", status: "Paused" },
						{ name: "sb-3", status: "Paused" },
					],
					total: 3,
				}),
			);

			const result = await Sandbox.list({
				...defaultConfig,
				phase: SandboxStatus.Paused,
			});
			expect(result).toHaveLength(2);
			expect(result.every((s) => s.status === SandboxStatus.Paused)).toBe(true);
		});

		it("filters by a transitional phase", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockImplementation(async () =>
				mockResponse({
					sandboxes: [
						{ name: "sb-1", phase: "Pausing" },
						{ name: "sb-2", phase: "Resuming" },
						{ name: "sb-3", phase: "Deleting" },
					],
					total: 3,
				}),
			);

			const result = await Sandbox.list({ ...defaultConfig, phase: SandboxStatus.Resuming });
			expect(result.map((s) => s.name)).toEqual(["sb-2"]);
		});
	});

	describe("runCode", () => {
		it("executes code and returns result", async () => {
			const mockFetch = vi.mocked(fetch);
			// First call for fromPool
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// Second call for exec
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					stdout: "42\n",
					stderr: "",
					success: true,
					durationMs: 50,
					session_id: "sess-1",
				}),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const result = await sbx.runCode("print(42)");
			expect(result.stdout).toBe("42\n");
			expect(result.success).toBe(true);
			expect(result.sessionId).toBe("sess-1");
		});

		it("maintains session across calls", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "", success: true, session_id: "sess-1" }),
			);
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "42\n", success: true, session_id: "sess-1" }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.runCode("x = 42");
			await sbx.runCode("print(x)");

			const secondExecBody = JSON.parse(apiCalls(mockFetch)[2][1]?.body as string);
			expect(secondExecBody.session_id).toBe("sess-1");
		});

		it("reset_session sends flag", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "", success: true, session_id: "sess-1" }),
			);
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "", success: true, session_id: "sess-2" }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.runCode("x = 42");
			sbx.resetSession();
			await sbx.runCode("print(1)");

			const resetBody = JSON.parse(apiCalls(mockFetch)[2][1]?.body as string);
			expect(resetBody.reset_session).toBe(true);
		});
	});

	describe("commands", () => {
		it("runs shell command", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "hello\n", stderr: "", exitCode: 0, durationMs: 50 }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const result = await sbx.commands.run("echo hello");
			expect(result.stdout).toBe("hello\n");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("files", () => {
		it("writes file", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({}));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.files.write("/workspace/test.txt", "hello");

			const url = apiCalls(mockFetch)[1][0] as string;
			expect(url).toContain("/files");
		});

		it("writes multiple files in a batch", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					success: true,
					total: 2,
					successCount: 2,
					failureCount: 0,
					results: [
						{ index: 0, path: "/workspace/a.txt", success: true },
						{ index: 1, path: "/workspace/b.bin", success: true },
					],
				}),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const result = await sbx.files.writeBatch([
				{ path: "/workspace/a.txt", content: "hello" },
				{ path: "/workspace/b.bin", content: new Uint8Array([0x00, 0xff]) },
			]);

			expect(result.success).toBe(true);
			expect(result.results.map((item) => item.path)).toEqual([
				"/workspace/a.txt",
				"/workspace/b.bin",
			]);

			const url = apiCalls(mockFetch)[1][0] as string;
			expect(url).toContain("/files/batch");

			const body = JSON.parse(apiCalls(mockFetch)[1][1]?.body as string);
			expect(body.items).toEqual([
				{
					path: "/workspace/a.txt",
					content: Buffer.from("hello").toString("base64"),
					encoding: "base64",
				},
				{
					path: "/workspace/b.bin",
					content: Buffer.from([0x00, 0xff]).toString("base64"),
					encoding: "base64",
				},
			]);
		});

		it("returns partial failures from batch writes", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					success: false,
					total: 2,
					successCount: 1,
					failureCount: 1,
					results: [
						{ index: 0, path: "/workspace/a.txt", success: true },
						{
							index: 1,
							path: "/workspace/b.txt",
							success: false,
							error: "Sandbox is not running",
						},
					],
				}),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const result = await sbx.files.writeBatch([
				{ path: "/workspace/a.txt", content: "hello" },
				{ path: "/workspace/b.txt", content: "world" },
			]);

			expect(result.success).toBe(false);
			expect(result.failureCount).toBe(1);
			expect(result.results[1]?.error).toBe("Sandbox is not running");
		});

		it("reads file", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([104, 105]), { status: 200 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const content = await sbx.files.read("/workspace/test.txt");
			expect(content).toBeInstanceOf(Uint8Array);
		});

		it("lists files", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					files: [{ name: "a.txt", path: "/workspace/a.txt", isDir: false, size: 10 }],
				}),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const files = await sbx.files.list();
			expect(files).toHaveLength(1);
			expect(files[0].name).toBe("a.txt");
		});
	});

	describe("kill", () => {
		it("kills sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();

			const url = apiCalls(mockFetch)[1][0] as string;
			expect(url).toContain("/sandboxes/sb-1");
			expect(apiCalls(mockFetch)[1][1]?.method).toBe("DELETE");
		});

		it("is idempotent", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();
			await sbx.kill(); // Should not throw
			// Only one DELETE call
			expect(apiCalls(mockFetch).filter((c) => c[1]?.method === "DELETE")).toHaveLength(1);
		});

		it("prevents further operations after kill", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();

			await expect(sbx.runCode("x")).rejects.toThrow(SandboxError);
			expect(() => sbx.commands).toThrow(SandboxError);
			expect(() => sbx.files).toThrow(SandboxError);
		});
	});

	describe("pause / resume", () => {
		it("pauses running sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			expect(sbx.status).toBe(SandboxStatus.Paused);
		});

		it("resumes paused sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			await sbx.resume();
			// v0.8 resume is admission-only: it reports Resuming and does not
			// block. Call waitUntilReady() to reach Running.
			expect(sbx.status).toBe(SandboxStatus.Resuming);
		});

		it("resume preserves backend status", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pending" }, 202));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			await sbx.resume();
			expect(sbx.status).toBe(SandboxStatus.Pending);
		});

		it("resume preserves known autoIdleTimeoutSeconds when response omits it", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));

			const sbx = await Sandbox.fromPool("pool", { ...defaultConfig, autoIdleTimeoutSeconds: 900 });
			await sbx.pause();
			await sbx.resume();
			expect(sbx.autoIdleTimeoutSeconds).toBe(900);
		});

		it("pause on killed sandbox throws", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();
			await expect(sbx.pause()).rejects.toThrow(SandboxError);
		});
	});

	describe("refresh", () => {
		it("preserves known autoIdleTimeoutSeconds when response omits it", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));

			const sbx = await Sandbox.fromPool("pool", { ...defaultConfig, autoIdleTimeoutSeconds: 900 });
			await sbx.refresh();
			expect(sbx.autoIdleTimeoutSeconds).toBe(900);
		});
	});

	describe("waitUntilReady", () => {
		it("returns immediately if already running", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh call
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// kernel-ready ping: this agent has no such endpoint
			mockFetch.mockResolvedValueOnce(pingResponse());
			// warmup probe call
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(5);
		});

		it("throws on terminal state", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Failed" }));

			const sbx = await Sandbox.create("img", {
				...defaultConfig,
				name: "sb-1",
			});
			await expect(sbx.waitUntilReady(5)).rejects.toThrow(SandboxError);
		});

		it("times out while sandbox remains Pending", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);

			try {
				const mockFetch = vi.mocked(fetch);
				mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

				const sbx = await Sandbox.create("img", { ...defaultConfig, name: "sb-1" });
				const wait = sbx.waitUntilReady(3);
				const assertion = expect(wait).rejects.toThrow(
					"Sandbox 'sb-1' did not become ready within 3s (last phase: Pending)",
				);

				await vi.advanceTimersByTimeAsync(3000);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		});

		it("uses one timeout budget after resume returns Pending", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);

			try {
				const mockFetch = vi.mocked(fetch);
				mockFetch.mockResolvedValueOnce(versionResponse());
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pending" }, 202));
				mockFetch.mockImplementation(async () => mockResponse({ name: "sb-1", status: "Pending" }));

				const sbx = await Sandbox.fromPool("pool", defaultConfig);
				await sbx.pause();
				await sbx.resume();
				const wait = sbx.waitUntilReady(3);
				const assertion = expect(wait).rejects.toThrow(
					"Sandbox 'sb-1' did not become ready within 3s (last phase: Pending)",
				);

				await vi.advanceTimersByTimeAsync(3000);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		});

		it("becomes ready when Pending transitions to Running before timeout", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);

			try {
				const mockFetch = vi.mocked(fetch);
				mockFetch.mockResolvedValueOnce(versionResponse());
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
				mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
				mockFetch.mockResolvedValueOnce(pingResponse());
				mockFetch.mockImplementationOnce(async (_url, init) =>
					warmupProbeResponse((init as RequestInit).body as string),
				);

				const sbx = await Sandbox.create("img", { ...defaultConfig, name: "sb-1" });
				const wait = sbx.waitUntilReady(5);

				await vi.advanceTimersByTimeAsync(2000);
				await expect(wait).resolves.toBeUndefined();
				expect(sbx.status).toBe(SandboxStatus.Running);
			} finally {
				vi.useRealTimers();
			}
		});

		it("waitUntilReady_warms_kernel_on_cold_start", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			// create (Pending)
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			// first refresh: still Pending
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			// second refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// kernel-ready ping: unsupported, so warmup probes through exec
			mockFetch.mockResolvedValueOnce(pingResponse());
			// first probe: empty stdout (kernel cold)
			mockFetch.mockResolvedValueOnce(
				mockResponse({
					stdout: "",
					stderr: "",
					success: true,
					durationMs: 5,
					session_id: "sess-warm",
				}),
			);
			// second probe: marker echoed back
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.create("img", { ...defaultConfig, name: "sb-1" });
			await sbx.waitUntilReady(30);

			const execCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/exec"));
			expect(execCalls.length).toBeGreaterThanOrEqual(2);
			const retryBody = JSON.parse(execCalls[1][1]?.body as string);
			expect(retryBody.session_id).toBeUndefined();
			expect(retryBody.reset_session).toBe(true);
		});

		it("waitUntilReady_warm_kernel_no_extra_latency", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			// single probe returning marker
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(30);

			expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("/exec"))).toHaveLength(1);
		});

		it("always warms the kernel after a resume", async () => {
			// v0.8 dropped the `resumedFromPool` hint, so there is no longer a
			// "skip the warmup once" fast path: a resumed sandbox always gets a
			// fresh pod and therefore a cold Jupyter kernel.
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Paused" }));
			mockFetch.mockResolvedValueOnce(
				mockResponse({ name: "sb-1", phase: "Running", resumedFromPool: true }, 202),
			);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			await sbx.resume();
			await sbx.waitUntilReady(5);

			expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("/exec"))).toHaveLength(1);
		});

		it("warms the kernel after a fromPool claim", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(5);

			expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("/exec"))).toHaveLength(1);
		});

		it("waitUntilReady_warmup_accepts_extra_stdout", async () => {
			// Regression test for issue #51: the kernel may append unrelated
			// warnings (e.g. IPython's history-thread SQLite error) alongside
			// the marker. That session is live and must not be discarded.
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			mockFetch.mockImplementationOnce(async (_url, init) => {
				const code = JSON.parse((init as RequestInit).body as string).code as string;
				const match = code.match(/print\("(__pk_warmup_[a-f0-9]+__)"\)/);
				if (!match) throw new Error(`Unexpected warmup probe request body: ${code}`);
				return mockResponse({
					stdout: `${match[1]}\nThe history saving thread hit an unexpected error (OperationalError('attempt to write a readonly database')). History will not be written to the database.\n`,
					stderr: "",
					success: true,
					durationMs: 5,
					session_id: "sess-warm",
				});
			});

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(5);

			expect(mockFetch.mock.calls.filter((c) => String(c[0]).includes("/exec"))).toHaveLength(1);
		});

		it("waitUntilReady_warmup_timeout_does_not_throw", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// all subsequent calls return empty stdout (probe never sees marker).
			// Use mockImplementation so each call gets a fresh Response object.
			mockFetch.mockImplementation(async () =>
				mockResponse({
					stdout: "",
					stderr: "",
					success: true,
					durationMs: 5,
					session_id: "sess-warm",
				}),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			// Silence the expected warning from the unresolved probe.
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await expect(sbx.waitUntilReady(2)).resolves.toBeUndefined();
			} finally {
				warnSpy.mockRestore();
			}
		}, 10000);

		it("waitUntilReady_retries_warmup_gateway_timeout", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			// first warmup probe times out at Agent Gateway, second succeeds
			mockFetch.mockResolvedValueOnce(mockResponse("upstream request timeout", 504));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await expect(sbx.waitUntilReady(30)).resolves.toBeUndefined();
		});

		it("waitUntilReady_propagates_runCode_errors_from_probe", async () => {
			// If runCode itself throws (e.g., backend unreachable), the warmup
			// probe must propagate the exception rather than swallow it — that
			// is a real failure, not a cold-kernel race.
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(pingResponse());
			// First probe call fails with a network error.
			mockFetch.mockRejectedValueOnce(new Error("network unreachable"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await expect(sbx.waitUntilReady(30)).rejects.toThrow(/network unreachable/);
		});
	});

	describe("Symbol.asyncDispose", () => {
		it("kills sandbox on dispose", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx[Symbol.asyncDispose]();

			expect(apiCalls(mockFetch).filter((c) => c[1]?.method === "DELETE")).toHaveLength(1);
		});
	});
});
