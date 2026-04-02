import { describe, expect, it } from "vitest";
import {
	SandboxStatus,
	combinedOutput,
	commandSuccess,
	parseCodeResult,
	parseCommandResult,
	parseFileInfo,
	parseSandboxInfo,
	parseStatus,
} from "../src/sandbox/models.js";

describe("SandboxStatus", () => {
	it("has correct enum values", () => {
		expect(SandboxStatus.Pending).toBe("Pending");
		expect(SandboxStatus.Running).toBe("Running");
		expect(SandboxStatus.Paused).toBe("Paused");
		expect(SandboxStatus.Bound).toBe("Bound");
		expect(SandboxStatus.Succeeded).toBe("Succeeded");
		expect(SandboxStatus.Failed).toBe("Failed");
		expect(SandboxStatus.Unknown).toBe("Unknown");
	});
});

describe("parseStatus", () => {
	it("parses valid statuses", () => {
		expect(parseStatus("Running")).toBe(SandboxStatus.Running);
		expect(parseStatus("Pending")).toBe(SandboxStatus.Pending);
		expect(parseStatus("Paused")).toBe(SandboxStatus.Paused);
	});

	it("returns Unknown for unrecognized values", () => {
		expect(parseStatus("SomethingWeird")).toBe(SandboxStatus.Unknown);
	});

	it("returns Unknown for undefined", () => {
		expect(parseStatus(undefined)).toBe(SandboxStatus.Unknown);
	});

	it("returns Unknown for empty string", () => {
		expect(parseStatus("")).toBe(SandboxStatus.Unknown);
	});
});

describe("parseSandboxInfo", () => {
	it("parses minimal sandbox info", () => {
		const info = parseSandboxInfo({ name: "test-sb" }, "my-ns");
		expect(info.name).toBe("test-sb");
		expect(info.workspace).toBe("my-ns");
		expect(info.status).toBe(SandboxStatus.Unknown);
	});

	it("parses full sandbox info with camelCase fields", () => {
		const info = parseSandboxInfo(
			{
				name: "test-sb",
				status: "Running",
				image: "python:3.10",
				poolName: "gpu-pool",
				createdAt: "2025-01-01T00:00:00Z",
			},
			"my-ns",
		);
		expect(info.status).toBe(SandboxStatus.Running);
		expect(info.image).toBe("python:3.10");
		expect(info.pool).toBe("gpu-pool");
		expect(info.createdAt).toBe("2025-01-01T00:00:00Z");
	});

	it("handles alternative field names (phase, pool, created_at, sandboxName)", () => {
		const info = parseSandboxInfo(
			{
				sandboxName: "alt-name",
				phase: "Paused",
				pool: "cpu-pool",
				created_at: "2025-06-01",
			},
			"ns",
		);
		expect(info.name).toBe("alt-name");
		expect(info.status).toBe(SandboxStatus.Paused);
		expect(info.pool).toBe("cpu-pool");
		expect(info.createdAt).toBe("2025-06-01");
	});
});

describe("parseCodeResult", () => {
	it("parses successful code result", () => {
		const result = parseCodeResult({
			stdout: "42\n",
			stderr: "",
			success: true,
			durationMs: 50,
			session_id: "sess-123",
		});
		expect(result.success).toBe(true);
		expect(result.stdout).toBe("42\n");
		expect(result.executionTimeMs).toBe(50);
		expect(result.sessionId).toBe("sess-123");
	});

	it("parses failed code result", () => {
		const result = parseCodeResult({
			stdout: "",
			stderr: "",
			success: false,
			execution_time_ms: 10,
			error_name: "ValueError",
			error_value: "oops",
			traceback: ["line 1", "line 2"],
		});
		expect(result.success).toBe(false);
		expect(result.errorName).toBe("ValueError");
		expect(result.errorValue).toBe("oops");
		expect(result.traceback).toEqual(["line 1", "line 2"]);
	});
});

describe("parseCommandResult", () => {
	it("parses successful command", () => {
		const result = parseCommandResult({
			stdout: "hello\n",
			stderr: "",
			exitCode: 0,
			durationMs: 100,
		});
		expect(result.exitCode).toBe(0);
		expect(commandSuccess(result)).toBe(true);
	});

	it("parses failed command", () => {
		const result = parseCommandResult({
			stdout: "",
			stderr: "error\n",
			exit_code: 1,
			duration_ms: 200,
		});
		expect(result.exitCode).toBe(1);
		expect(commandSuccess(result)).toBe(false);
	});
});

describe("parseFileInfo", () => {
	it("parses regular file", () => {
		const info = parseFileInfo({
			name: "test.txt",
			path: "/workspace/test.txt",
			isDir: false,
			size: 1024,
			modified: "2025-01-01T00:00:00Z",
		});
		expect(info.name).toBe("test.txt");
		expect(info.isDir).toBe(false);
		expect(info.size).toBe(1024);
	});

	it("parses directory with snake_case fields", () => {
		const info = parseFileInfo({
			name: "src",
			path: "/workspace/src",
			is_dir: true,
			size: 0,
		});
		expect(info.isDir).toBe(true);
		expect(info.size).toBe(0);
	});
});

describe("combinedOutput", () => {
	it("combines stdout and stderr", () => {
		expect(
			combinedOutput({ stdout: "out", stderr: "err", success: true, executionTimeMs: 0 }),
		).toBe("outerr");
	});
});
