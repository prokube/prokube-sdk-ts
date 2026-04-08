import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxError } from "../src/common/errors.js";
import { SandboxStatus } from "../src/sandbox/models.js";
import { Sandbox } from "../src/sandbox/sandbox.js";

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

describe("Sandbox", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("fromPool", () => {
		it("claims sandbox from pool", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-pool-1", status: "Running" }));

			const sbx = await Sandbox.fromPool("gpu-pool", defaultConfig);
			expect(sbx.name).toBe("sb-pool-1");
			expect(sbx.status).toBe(SandboxStatus.Running);
		});

		it("sends volumeSize when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1", status: "Running" }));

			await Sandbox.fromPool("pool", { ...defaultConfig, volumeSize: "20Gi" });
			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.volumeSize).toBe("20Gi");
		});
	});

	describe("create", () => {
		it("creates sandbox with image", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "my-sb", status: "Pending" }));

			const sbx = await Sandbox.create("python:3.10", {
				...defaultConfig,
				name: "my-sb",
			});
			expect(sbx.name).toBe("my-sb");
			expect(sbx.status).toBe(SandboxStatus.Pending);
		});

		it("sends volumeSize when provided", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(mockResponse({ name: "sb-1", status: "Pending" }));

			await Sandbox.create("python:3.10", {
				...defaultConfig,
				volumeSize: "10Gi",
			});
			const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
			expect(body.volumeSize).toBe("10Gi");
		});
	});

	describe("get / connect", () => {
		it("gets existing sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
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
			mockFetch.mockResolvedValue(mockResponse({ sandboxes: [], total: 0 }));

			const result = await Sandbox.list(defaultConfig);
			expect(result).toEqual([]);
		});

		it("returns multiple sandboxes", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValue(
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
			mockFetch.mockResolvedValue(
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
	});

	describe("runCode", () => {
		it("executes code and returns result", async () => {
			const mockFetch = vi.mocked(fetch);
			// First call for fromPool
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

			const secondExecBody = JSON.parse(mockFetch.mock.calls[2][1]?.body as string);
			expect(secondExecBody.session_id).toBe("sess-1");
		});

		it("reset_session sends flag", async () => {
			const mockFetch = vi.mocked(fetch);
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

			const resetBody = JSON.parse(mockFetch.mock.calls[2][1]?.body as string);
			expect(resetBody.reset_session).toBe(true);
		});
	});

	describe("commands", () => {
		it("runs shell command", async () => {
			const mockFetch = vi.mocked(fetch);
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
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({}));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.files.write("/workspace/test.txt", "hello");

			const url = mockFetch.mock.calls[1][0] as string;
			expect(url).toContain("/files");
		});

		it("reads file", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([104, 105]), { status: 200 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const content = await sbx.files.read("/workspace/test.txt");
			expect(content).toBeInstanceOf(Uint8Array);
		});

		it("lists files", async () => {
			const mockFetch = vi.mocked(fetch);
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
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();

			const url = mockFetch.mock.calls[1][0] as string;
			expect(url).toContain("/sandboxes/sb-1");
			expect(mockFetch.mock.calls[1][1]?.method).toBe("DELETE");
		});

		it("is idempotent", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();
			await sbx.kill(); // Should not throw
			// Only one DELETE call
			expect(mockFetch.mock.calls.filter((c) => c[1]?.method === "DELETE")).toHaveLength(1);
		});

		it("prevents further operations after kill", async () => {
			const mockFetch = vi.mocked(fetch);
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
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({}));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			expect(sbx.status).toBe(SandboxStatus.Paused);
		});

		it("resumes paused sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(mockResponse({})); // pause
			mockFetch.mockResolvedValueOnce(mockResponse({})); // resume

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause();
			await sbx.resume();
			expect(sbx.status).toBe(SandboxStatus.Running);
		});

		it("pause on killed sandbox throws", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();
			await expect(sbx.pause()).rejects.toThrow(SandboxError);
		});
	});

	describe("waitUntilReady", () => {
		// Helper: respond to a probe call by echoing back the marker.
		// The probe sends code like `print("__pk_warmup_<uuid>__")`.
		// We parse the marker out of the request body and echo it back as
		// stdout so the warmup loop's `stdout.trim() === marker` check passes.
		// If the regex doesn't match we throw rather than fall back to an empty
		// string — an empty marker would silently make the probe succeed
		// (since both sides of `stdout.trim() === marker` would be "") and
		// mask regressions in the probe request format.
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

		it("returns immediately if already running", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh call
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// warmup probe call
			mockFetch.mockImplementationOnce(async (_url, init) =>
				probeRespond((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(5);
		});

		it("throws on terminal state", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Failed" }));

			const sbx = await Sandbox.create("img", {
				...defaultConfig,
				name: "sb-1",
			});
			await expect(sbx.waitUntilReady(5)).rejects.toThrow(SandboxError);
		});

		it("waitUntilReady_warms_kernel_on_cold_start", async () => {
			const mockFetch = vi.mocked(fetch);
			// create (Pending)
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			// first refresh: still Pending
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Pending" }));
			// second refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
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
				probeRespond((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.create("img", { ...defaultConfig, name: "sb-1" });
			await sbx.waitUntilReady(30);

			// Count code execution calls (probes). Exec calls are POST to /exec.
			const execCalls = mockFetch.mock.calls.filter((c) => {
				const url = c[0] as string;
				return url.includes("/exec");
			});
			expect(execCalls.length).toBeGreaterThanOrEqual(2);
		});

		it("waitUntilReady_warm_kernel_no_extra_latency", async () => {
			const mockFetch = vi.mocked(fetch);
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// single probe returning marker
			mockFetch.mockImplementationOnce(async (_url, init) =>
				probeRespond((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(30);

			const execCalls = mockFetch.mock.calls.filter((c) => {
				const url = c[0] as string;
				return url.includes("/exec");
			});
			expect(execCalls.length).toBe(1);
		});

		it("waitUntilReady_warmup_timeout_does_not_throw", async () => {
			const mockFetch = vi.mocked(fetch);
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

		it("waitUntilReady_propagates_runCode_errors_from_probe", async () => {
			// If runCode itself throws (e.g., backend unreachable), the warmup
			// probe must propagate the exception rather than swallow it — that
			// is a real failure, not a cold-kernel race.
			const mockFetch = vi.mocked(fetch);
			// fromPool
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// refresh: Running
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			// First probe call fails with a network error.
			mockFetch.mockRejectedValueOnce(new Error("network unreachable"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await expect(sbx.waitUntilReady(30)).rejects.toThrow(/network unreachable/);
		});
	});

	describe("Symbol.asyncDispose", () => {
		it("kills sandbox on dispose", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", status: "Running" }));
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx[Symbol.asyncDispose]();

			expect(mockFetch.mock.calls.filter((c) => c[1]?.method === "DELETE")).toHaveLength(1);
		});
	});
});
