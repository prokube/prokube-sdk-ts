import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/common/config.js";
import { SandboxError } from "../src/common/errors.js";
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
		it("uses internal paths for user_id auth", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const client = new SandboxClient(makeConfig());
			await client.list();

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/api/namespaces/test-ns/sandboxes");
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

	describe("pause/resume", () => {
		it("pause sends POST to /pause", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({}));

			const client = new SandboxClient(makeConfig());
			await client.pause("sb-1");

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/sandboxes/sb-1/pause");
		});

		it("resume sends POST to /resume", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({}));

			const client = new SandboxClient(makeConfig());
			await client.resume("sb-1");

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("/sandboxes/sb-1/resume");
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
					content: Buffer.from("alpha").toString("base64"),
					encoding: "base64",
				},
				{
					path: "/workspace/b.bin",
					content: Buffer.from([0x00, 0xff]).toString("base64"),
					encoding: "base64",
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
					content: Buffer.from("alpha").toString("base64"),
				},
				{
					path: "/workspace/b.txt",
					content: Buffer.from("beta").toString("base64"),
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
				},
				{
					path: "/workspace/b.txt",
					content: Buffer.from("beta").toString("base64"),
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
