import { describe, expect, it } from "vitest";
import {
	SandboxStatus,
	combinedOutput,
	commandSuccess,
	parseCodeResult,
	parseCommandResult,
	parseFileInfo,
	parsePoolInfo,
	parseSandboxInfo,
	parseStatus,
} from "../src/sandbox/models.js";

describe("SandboxStatus", () => {
	it("has correct enum values", () => {
		expect(SandboxStatus.Pending).toBe("Pending");
		expect(SandboxStatus.Running).toBe("Running");
		expect(SandboxStatus.Paused).toBe("Paused");
		expect(SandboxStatus.Succeeded).toBe("Succeeded");
		expect(SandboxStatus.Failed).toBe("Failed");
		expect(SandboxStatus.Unknown).toBe("Unknown");
	});

	it("exposes the v0.8 transitional phases", () => {
		expect(SandboxStatus.Pausing).toBe("Pausing");
		expect(SandboxStatus.Resuming).toBe("Resuming");
		expect(SandboxStatus.Deleting).toBe("Deleting");
	});

	it("no longer carries the pre-0.8 Bound member", () => {
		// Removed in 0.2.0 to match the Python SDK; v0.8 backends never
		// report it.
		expect("Bound" in SandboxStatus).toBe(false);
	});
});

describe("parseStatus", () => {
	it("parses valid statuses", () => {
		expect(parseStatus("Running")).toBe(SandboxStatus.Running);
		expect(parseStatus("Pending")).toBe(SandboxStatus.Pending);
		expect(parseStatus("Paused")).toBe(SandboxStatus.Paused);
	});

	it("parses the v0.8 transitional phases", () => {
		expect(parseStatus("Pausing")).toBe(SandboxStatus.Pausing);
		expect(parseStatus("Resuming")).toBe(SandboxStatus.Resuming);
		expect(parseStatus("Deleting")).toBe(SandboxStatus.Deleting);
	});

	it("maps the retired Bound phase to Unknown", () => {
		expect(parseStatus("Bound")).toBe(SandboxStatus.Unknown);
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
				autoIdleTimeoutSeconds: 1800,
			},
			"my-ns",
		);
		expect(info.status).toBe(SandboxStatus.Running);
		expect(info.image).toBe("python:3.10");
		expect(info.pool).toBe("gpu-pool");
		expect(info.createdAt).toBe("2025-01-01T00:00:00Z");
		expect(info.autoIdleTimeoutSeconds).toBe(1800);
	});

	it("handles alternative field names (phase, pool, created_at)", () => {
		const info = parseSandboxInfo(
			{
				name: "alt-name",
				phase: "Paused",
				pool: "cpu-pool",
				created_at: "2025-06-01",
				auto_idle_timeout_seconds: 900,
			},
			"ns",
		);
		expect(info.name).toBe("alt-name");
		expect(info.status).toBe(SandboxStatus.Paused);
		expect(info.pool).toBe("cpu-pool");
		expect(info.createdAt).toBe("2025-06-01");
		expect(info.autoIdleTimeoutSeconds).toBe(900);
	});

	it("parses a Failed sandbox's lastError in either spelling", () => {
		const camel = parseSandboxInfo(
			{ name: "sb", phase: "Failed", lastError: "pvc snapshot rejected" },
			"ns",
		);
		expect(camel.status).toBe(SandboxStatus.Failed);
		expect(camel.lastError).toBe("pvc snapshot rejected");

		const snake = parseSandboxInfo(
			{ name: "sb", phase: "Failed", last_error: "workspace purge unconfirmed" },
			"ns",
		);
		expect(snake.lastError).toBe("workspace purge unconfirmed");
	});

	it("leaves lastError undefined when the backend reports null or omits it", () => {
		expect(parseSandboxInfo({ name: "sb", phase: "Running" }, "ns").lastError).toBeUndefined();
		expect(
			parseSandboxInfo({ name: "sb", phase: "Running", lastError: null }, "ns").lastError,
		).toBeUndefined();
	});

	it("parses a Deleting sandbox", () => {
		expect(parseSandboxInfo({ name: "sb", phase: "Deleting" }, "ns").status).toBe(
			SandboxStatus.Deleting,
		);
	});

	it("ignores the retired resumedFromPool wire field", () => {
		// v0.8 stopped reporting warm-pool resume swaps; the field no longer
		// exists on SandboxInfo and stray backend payload keys are dropped.
		const info = parseSandboxInfo({ name: "sb", phase: "Running", resumedFromPool: true }, "ns");
		expect("resumedFromPool" in info).toBe(false);
	});

	it("honours the caller's default phase when the body has none", () => {
		expect(parseSandboxInfo({ name: "sb" }, "ns", SandboxStatus.Pending).status).toBe(
			SandboxStatus.Pending,
		);
	});

	it("throws when the body carries no name", () => {
		expect(() => parseSandboxInfo({ phase: "Running" }, "ns")).toThrow(/name is missing/);
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

	it("maps timeout code result to failure even if backend reports success", () => {
		const result = parseCodeResult({
			stdout: "",
			stderr: "Execution timed out after 5 seconds",
			success: true,
			durationMs: 5000,
		});

		expect(result.success).toBe(false);
		expect(result.stderr).toContain("timed out");
	});

	it("maps timeout error name to failed code result", () => {
		const result = parseCodeResult({
			stdout: "",
			stderr: "",
			success: true,
			error_name: "TimeoutError",
		});

		expect(result.success).toBe(false);
		expect(result.errorName).toBe("TimeoutError");
	});

	it("parses camelCase error fields", () => {
		const result = parseCodeResult({
			stdout: "",
			stderr: "",
			success: false,
			durationMs: 300,
			errorName: "TimeoutError",
			errorValue: "Code execution timed out",
		});

		expect(result.errorName).toBe("TimeoutError");
		expect(result.errorValue).toBe("Code execution timed out");
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

	it("maps timeout command result to non-zero exit even if backend reports exit 0", () => {
		const result = parseCommandResult({
			stdout: "",
			stderr: "[Timeout: no response after 15s]",
			exitCode: 0,
			durationMs: 15000,
		});

		expect(result.exitCode).toBe(-1);
		expect(commandSuccess(result)).toBe(false);
	});

	it("maps timeout command error name to non-zero exit", () => {
		const result = parseCommandResult({
			stdout: "",
			stderr: "",
			errorName: "ExecutionTimeout",
			exitCode: 0,
			durationMs: 15000,
		});

		expect(result.exitCode).toBe(-1);
		expect(commandSuccess(result)).toBe(false);
	});

	it("does not fail a successful command for ordinary stderr timeout text", () => {
		const result = parseCommandResult({
			stdout: "ok\n",
			stderr: "warning: timeout option ignored\n",
			exitCode: 0,
			durationMs: 10,
		});

		expect(result.exitCode).toBe(0);
		expect(commandSuccess(result)).toBe(true);
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

describe("parsePoolInfo", () => {
	it("parses minimal pool info", () => {
		const info = parsePoolInfo({ name: "my-pool" }, "test-ns");
		expect(info.name).toBe("my-pool");
		expect(info.workspace).toBe("test-ns");
		expect(info.replicas).toBe(0);
		expect(info.readyReplicas).toBe(0);
	});

	it("parses full pool info", () => {
		const info = parsePoolInfo(
			{
				name: "gpu-pool",
				replicas: 5,
				readyReplicas: 3,
				image: "python:3.10",
				cpu: "2",
				memory: "4Gi",
				autoIdleTimeoutSeconds: 1200,
			},
			"my-ns",
		);
		expect(info.name).toBe("gpu-pool");
		expect(info.workspace).toBe("my-ns");
		expect(info.replicas).toBe(5);
		expect(info.readyReplicas).toBe(3);
		expect(info.image).toBe("python:3.10");
		expect(info.cpu).toBe("2");
		expect(info.memory).toBe("4Gi");
		expect(info.autoIdleTimeoutSeconds).toBe(1200);
	});

	it("handles alternative field names (poolName, poolSize, ready_replicas)", () => {
		const info = parsePoolInfo(
			{
				poolName: "alt-pool",
				poolSize: 10,
				ready_replicas: 7,
				auto_idle_timeout_seconds: 600,
			},
			"ns",
		);
		expect(info.name).toBe("alt-pool");
		expect(info.replicas).toBe(10);
		expect(info.readyReplicas).toBe(7);
		expect(info.autoIdleTimeoutSeconds).toBe(600);
	});

	it("throws when name is missing", () => {
		expect(() => parsePoolInfo({}, "ns")).toThrow("pool name is missing");
	});
});

describe("combinedOutput", () => {
	it("combines stdout and stderr", () => {
		expect(
			combinedOutput({ stdout: "out", stderr: "err", success: true, executionTimeMs: 0 }),
		).toBe("outerr");
	});
});
