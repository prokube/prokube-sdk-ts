import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/common/config.js";
import { PoolExhaustedError, SandboxError } from "../src/common/errors.js";
import { SandboxClient } from "../src/sandbox/client.js";
import { SandboxStatus } from "../src/sandbox/models.js";

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

describe("SandboxClient", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("path routing", () => {
		it("uses Agent Gateway platform paths for no-api-key auth", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const client = new SandboxClient(makeConfig());
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/_platform/sandbox/test-ns/sandboxes");
		});

		it("uses Agent Gateway platform paths without auth headers", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const client = new SandboxClient(makeConfig({ userId: undefined }));
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
			expect(url).toContain("/_platform/sandbox/test-ns/sandboxes");
			expect(headers["x-api-key"]).toBeUndefined();
			expect(headers["kubeflow-userid"]).toBeUndefined();
		});

		it("uses external paths for api_key auth", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const client = new SandboxClient(makeConfig({ apiKey: "key-123", userId: undefined }));
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/sandbox/test-ns/sandboxes");
		});
	});

	describe("claimFromPool", () => {
		it("claims sandbox from pool", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-123", status: "Running" }));

			const client = new SandboxClient(makeConfig());
			const info = await client.claimFromPool("gpu-pool");

			expect(info.name).toBe("sb-123");
			expect(info.status).toBe(SandboxStatus.Running);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.poolName).toBe("gpu-pool");
		});

		it("sends volumeSize when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-123", status: "Running" }));

			const client = new SandboxClient(makeConfig());
			await client.claimFromPool("pool", "20Gi");

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.volumeSize).toBe("20Gi");
		});

		it("sends autoIdleTimeoutSeconds when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-123", status: "Running" }));

			const client = new SandboxClient(makeConfig());
			await client.claimFromPool("pool", undefined, 900);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.autoIdleTimeoutSeconds).toBe(900);
		});

		it("throws PoolExhaustedError for retryable 429 pool exhaustion", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				new Response(
					JSON.stringify({
						reason: "pool_exhausted",
						detail: "No warm pool capacity is currently available",
					}),
					{
						status: 429,
						headers: { "content-type": "application/json", "retry-after": "15" },
					},
				),
			);

			const client = new SandboxClient(makeConfig());
			try {
				await client.claimFromPool("pool");
				throw new Error("Expected PoolExhaustedError");
			} catch (error) {
				expect(error).toBeInstanceOf(PoolExhaustedError);
				const poolError = error as PoolExhaustedError;
				expect(poolError.reason).toBe("pool_exhausted");
				expect(poolError.retryAfter).toBe("15");
			}
		});

		it("parses the v0.8 claim body like every other Sandbox response", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse(
					{
						name: "claim-abc",
						namespace: "test-ns",
						phase: "Pending",
						poolName: "python-pool",
						claimName: "claim-abc-claim",
						lastError: null,
					},
					202,
				),
			);

			const client = new SandboxClient(makeConfig());
			const info = await client.claimFromPool("python-pool");

			expect(info.name).toBe("claim-abc");
			expect(info.workspace).toBe("test-ns");
			expect(info.status).toBe(SandboxStatus.Pending);
			expect(info.pool).toBe("python-pool");
			expect(info.lastError).toBeUndefined();
		});

		it("defaults a phase-less claim body to Pending", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "claim-abc" }, 202));

			const client = new SandboxClient(makeConfig());
			const info = await client.claimFromPool("python-pool");

			expect(info.status).toBe(SandboxStatus.Pending);
			expect(info.pool).toBe("python-pool");
		});
	});

	describe("create", () => {
		it("creates a sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			const info = await client.create({ image: "python:3.10", name: "my-sb" });

			expect(info.name).toBe("my-sb");
			expect(info.status).toBe(SandboxStatus.Pending);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.image).toBe("python:3.10");
			expect(body.name).toBe("my-sb");
		});

		it("omits optional fields when not provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({ image: "python:3.10" });

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body).not.toHaveProperty("volumeSize");
			expect(body).not.toHaveProperty("cpu");
			expect(body).not.toHaveProperty("memory");
			expect(body).not.toHaveProperty("allowInternetAccess");
			expect(body).not.toHaveProperty("autoIdleTimeoutSeconds");
			expect(body).not.toHaveProperty("envVars");
			expect(body).not.toHaveProperty("secretRefs");
		});

		it("sends cpu, memory, allowInternetAccess, envVars, and secretRefs when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({
				image: "python:3.10",
				name: "my-sb",
				cpu: "2",
				memory: "4Gi",
				allowInternetAccess: true,
				envVars: [{ name: "FOO", value: "bar" }],
				secretRefs: ["my-secret"],
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
			expect(body.allowInternetAccess).toBe(true);
			expect(body.envVars).toEqual([{ name: "FOO", value: "bar" }]);
			expect(body.secretRefs).toEqual(["my-secret"]);
		});

		it("sends autoIdleTimeoutSeconds when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({
				image: "python:3.10",
				autoIdleTimeoutSeconds: 1800,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.autoIdleTimeoutSeconds).toBe(1800);
		});

		it("sends allowInternetAccess=false explicitly", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({
				image: "python:3.10",
				allowInternetAccess: false,
			});

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.allowInternetAccess).toBe(false);
		});

		it("sends resources in both wire shapes so sizing is never dropped", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({ image: "python:3.10", cpu: "2", memory: "4Gi" });

			// The internal route reads the nested `resources` object and ignores
			// the flat keys; the external API-key route does the opposite.
			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.cpu).toBe("2");
			expect(body.memory).toBe("4Gi");
			expect(body.resources).toEqual({ cpu: "2", memory: "4Gi" });
		});

		it("sends a partial resources object when only one dimension is set", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({ image: "python:3.10", memory: "8Gi" });

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.resources).toEqual({ memory: "8Gi" });
			expect(body).not.toHaveProperty("cpu");
		});

		it("omits resources entirely when neither cpu nor memory is set", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const client = new SandboxClient(makeConfig());
			await client.create({ image: "python:3.10" });

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body).not.toHaveProperty("resources");
		});
	});

	describe("list", () => {
		it("returns empty list", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const client = new SandboxClient(makeConfig());
			const result = await client.list();
			expect(result).toEqual([]);
		});

		it("parses multiple sandboxes", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					sandboxes: [
						{ name: "sb-1", phase: "Running", poolName: "pool-a" },
						{ name: "sb-2", status: "Paused", image: "python:3.10" },
					],
					total: 2,
				}),
			);

			const client = new SandboxClient(makeConfig());
			const result = await client.list();
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("sb-1");
			expect(result[0].status).toBe(SandboxStatus.Running);
			expect(result[0].pool).toBe("pool-a");
			expect(result[1].name).toBe("sb-2");
			expect(result[1].status).toBe(SandboxStatus.Paused);
		});
	});

	describe("listPage", () => {
		it("preserves pagination metadata and echoes the requested token", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					sandboxes: [{ name: "paused-1", phase: "Paused" }],
					loaded: 1,
					hasMore: true,
					continueToken: "next-token",
				}),
			);

			const client = new SandboxClient(makeConfig());
			const page = await client.listPage({ limit: 10, continueToken: "opaque-token" });

			const url = new URL(mockFetch.mock.calls[0][0] as string);
			expect(url.pathname).toBe("/pkui/_platform/sandbox/test-ns/sandboxes");
			expect(Object.fromEntries(url.searchParams)).toEqual({
				limit: "10",
				continueToken: "opaque-token",
			});
			expect(page.sandboxes[0].status).toBe(SandboxStatus.Paused);
			expect(page.loaded).toBe(1);
			expect(page.hasMore).toBe(true);
			expect(page.continueToken).toBe("next-token");
		});

		it("derives loaded and hasMore from a legacy listing body", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({ sandboxes: [{ name: "sb-1", phase: "Running" }], total: 1 }),
			);

			const client = new SandboxClient(makeConfig());
			const page = await client.listPage();

			expect(page.loaded).toBe(1);
			expect(page.hasMore).toBe(false);
			expect(page.continueToken).toBeUndefined();
		});

		it("never sends an empty continuation token", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], loaded: 0, hasMore: false }));

			const client = new SandboxClient(makeConfig());
			await client.listPage({ continueToken: "" });

			const url = new URL(mockFetch.mock.calls[0][0] as string);
			expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "25" });
		});

		it.each([0, 101])("rejects limit %i without issuing a request", async (limit) => {
			const mockFetch = vi.mocked(fetch);
			const client = new SandboxClient(makeConfig());

			await expect(client.listPage({ limit })).rejects.toThrow(RangeError);
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("ensureCompatibility", () => {
		it("probes /api/version at most once per client", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ version: "0.8.0" }));

			const client = new SandboxClient(makeConfig());
			await client.ensureCompatibility();
			await client.ensureCompatibility();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(mockFetch.mock.calls[0][0] as string).toBe("https://example.com/pkui/api/version");
		});

		it("does nothing when the client opted out of the check", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ version: "0.1.0" }));

			await new SandboxClient(makeConfig(), false).ensureCompatibility();

			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("does nothing under API key auth, where /api/version does not exist", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ version: "0.1.0" }));

			await new SandboxClient(makeConfig({ apiKey: "key-123" })).ensureCompatibility();

			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("pause/resume", () => {
		it("pause sends POST to /pause and returns the accepted Sandbox body", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));

			const client = new SandboxClient(makeConfig());
			const info = await client.pause("sb-1");

			expect(mockFetch.mock.calls[0][0] as string).toContain("/sandboxes/sb-1/pause");
			expect(info.name).toBe("sb-1");
			expect(info.status).toBe(SandboxStatus.Pausing);
		});

		it("pause defaults to Pausing when the body omits the phase", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1" }, 202));

			const client = new SandboxClient(makeConfig());
			expect((await client.pause("sb-1")).status).toBe(SandboxStatus.Pausing);
		});

		it("resume sends POST to /resume and returns the accepted Sandbox body", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));

			const client = new SandboxClient(makeConfig());
			const info = await client.resume("sb-1");

			expect(mockFetch.mock.calls[0][0] as string).toContain("/sandboxes/sb-1/resume");
			expect(info.status).toBe(SandboxStatus.Resuming);
		});

		it("resume defaults to Resuming when the body omits the phase", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1" }, 202));

			const client = new SandboxClient(makeConfig());
			expect((await client.resume("sb-1")).status).toBe(SandboxStatus.Resuming);
		});

		it("resume carries lastError through", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({ name: "sb-1", phase: "Failed", lastError: "pvc restore failed" }, 202),
			);

			const client = new SandboxClient(makeConfig());
			expect((await client.resume("sb-1")).lastError).toBe("pvc restore failed");
		});

		it("resumeInfo stays available as an alias for resume", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));

			const client = new SandboxClient(makeConfig());
			const info = await client.resumeInfo("sb-1");

			expect(info.name).toBe("sb-1");
			expect(info.status).toBe(SandboxStatus.Resuming);
		});

		it("pause throws SandboxError on 409", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ detail: "Not running" }, 409));

			const client = new SandboxClient(makeConfig());
			await expect(client.pause("sb-1")).rejects.toThrow(SandboxError);
		});

		it("resume throws SandboxError on 409", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ detail: "Not paused" }, 409));

			const client = new SandboxClient(makeConfig());
			await expect(client.resume("sb-1")).rejects.toThrow(SandboxError);
		});
	});

	describe("execCode", () => {
		it("sends code execution request", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					stdout: "42\n",
					stderr: "",
					success: true,
					durationMs: 50,
					session_id: "sess-1",
				}),
			);

			const client = new SandboxClient(makeConfig());
			const result = await client.execCode("sb-1", "print(42)");

			expect(result.stdout).toBe("42\n");
			expect(result.success).toBe(true);
			expect(result.sessionId).toBe("sess-1");

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.code).toBe("print(42)");
			expect(body.use_jupyter).toBe(true);
			expect(body.language).toBe("python");
		});
	});

	describe("execCommand", () => {
		it("sends shell command request", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					stdout: "hello\n",
					stderr: "",
					exitCode: 0,
					durationMs: 100,
				}),
			);

			const client = new SandboxClient(makeConfig());
			const result = await client.execCommand("sb-1", "echo hello");

			expect(result.stdout).toBe("hello\n");
			expect(result.exitCode).toBe(0);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.use_jupyter).toBe(false);
		});
	});

	describe("files", () => {
		it("writes file with base64 content", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({}));

			const client = new SandboxClient(makeConfig());
			const content = new TextEncoder().encode("hello world");
			await client.writeFile("sb-1", "/workspace/test.txt", content);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.path).toBe("/workspace/test.txt");
			expect(body.content).toBe(Buffer.from("hello world").toString("base64"));
			expect(body.encoding).toBe("base64");
		});

		it("writes multiple files with one batch request", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
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

			const client = new SandboxClient(makeConfig());
			const result = await client.writeFilesBatch("sb-1", [
				{
					path: "/workspace/a.txt",
					content: "alpha",
				},
				{
					path: "/workspace/b.bin",
					content: new Uint8Array([0x00, 0xff]),
				},
			]);

			expect(result.success).toBe(true);
			expect(result.successCount).toBe(2);
			expect(result.failureCount).toBe(0);
			expect(result.results.map((item) => item.path)).toEqual([
				"/workspace/a.txt",
				"/workspace/b.bin",
			]);

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/files/batch");

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.items).toEqual([
				{
					path: "/workspace/a.txt",
					content: Buffer.from("alpha").toString("base64"),
					encoding: "base64",
				},
				{
					path: "/workspace/b.bin",
					content: Buffer.from([0x00, 0xff]).toString("base64"),
					encoding: "base64",
				},
			]);
		});

		it("accepts omitted encoding and preserves partial failures", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
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

			const client = new SandboxClient(makeConfig());
			const result = await client.writeFilesBatch("sb-1", [
				{
					path: "/workspace/a.txt",
					content: "alpha",
				},
				{
					path: "/workspace/b.txt",
					content: "beta",
				},
			]);

			expect(result.success).toBe(false);
			expect(result.successCount).toBe(1);
			expect(result.failureCount).toBe(1);
			expect(result.results[1]?.error).toBe("Sandbox is not running");

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.items).toEqual([
				{
					path: "/workspace/a.txt",
					content: Buffer.from("alpha").toString("base64"),
					encoding: "base64",
				},
				{
					path: "/workspace/b.txt",
					content: Buffer.from("beta").toString("base64"),
					encoding: "base64",
				},
			]);
		});

		it("writes binary file with encoding=base64", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({}));

			const client = new SandboxClient(makeConfig());
			// Non-UTF8 bytes to ensure we're not relying on text encoding.
			const content = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
			await client.writeFile("sb-1", "/workspace/bin.dat", content);

			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.encoding).toBe("base64");
			expect(body.content).toBe(Buffer.from(content).toString("base64"));
			// Decoding the request content should recover the original bytes.
			const decoded = new Uint8Array(Buffer.from(body.content, "base64"));
			expect(Array.from(decoded)).toEqual(Array.from(content));
		});

		it("roundtrips bytes through write then read", async () => {
			const mockFetch = vi.mocked(fetch);
			const original = new TextEncoder().encode("hello world");

			// First call: writeFile POST (JSON response).
			mockFetch.mockResolvedValueOnce(mockResponse({}));
			// Second call: readFile returns raw bytes (post pkui#1728 backend).
			mockFetch.mockResolvedValueOnce(new Response(original, { status: 200 }));

			const client = new SandboxClient(makeConfig());
			await client.writeFile("sb-1", "/workspace/x", original);

			const writeBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(writeBody.encoding).toBe("base64");
			expect(writeBody.content).toBe(Buffer.from(original).toString("base64"));

			const read = await client.readFile("sb-1", "/workspace/x");
			expect(read).toBeInstanceOf(Uint8Array);
			expect(Array.from(read)).toEqual(Array.from(original));
		});

		it("reads file from download endpoint", async () => {
			const mockFetch = vi.mocked(fetch);
			const data = new Uint8Array([104, 101, 108, 108, 111]);
			mockFetch.mockResolvedValue(new Response(data, { status: 200 }));

			const client = new SandboxClient(makeConfig());
			const result = await client.readFile("sb-1", "/workspace/test.txt");
			expect(result).toBeInstanceOf(Uint8Array);

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/files/download");
			expect(url).toContain("path=%2Fworkspace%2Ftest.txt");
		});

		it("lists files in directory", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
				mockResponse({
					files: [
						{ name: "file.txt", path: "/workspace/file.txt", isDir: false, size: 100 },
						{ name: "src", path: "/workspace/src", is_dir: true, size: 0 },
					],
				}),
			);

			const client = new SandboxClient(makeConfig());
			const files = await client.listFiles("sb-1");
			expect(files).toHaveLength(2);
			expect(files[0].name).toBe("file.txt");
			expect(files[0].isDir).toBe(false);
			expect(files[1].name).toBe("src");
			expect(files[1].isDir).toBe(true);
		});
	});
});
