import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxError, SandboxTimeoutError } from "../src/common/errors.js";
import { SandboxStatus } from "../src/sandbox/models.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import {
	type FetchCall,
	abortTimeoutError,
	callsTo,
	captureRequestTimeouts,
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

/**
 * v0.8 admits every mutation with 202 and returns the full Sandbox body, so
 * the claim response looks exactly like a GET.
 */
function claimResponse(phase = "Running"): Response {
	return mockResponse({ name: "sb-1", namespace: "test-ns", phase, poolName: "pool" }, 202);
}

function getResponse(phase: string, extra: Record<string, unknown> = {}): Response {
	return mockResponse({ name: "sb-1", phase, ...extra });
}

/**
 * The pause and deletion waits poll on a 2s interval, so every test that
 * exercises more than one poll drives fake timers. Advancing exactly
 * `(polls - 1) * 2000` keeps the queued response list and the loop in step.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * Readiness waiting long-polls instead, and paces a round the backend
 * answered instantly (an old backend ignoring `wait_phase`) by 1s.
 */
const DEGRADED_POLL_MS = 1000;

/** Query parameters of a recorded call. */
function queryOf(call: FetchCall): URLSearchParams {
	return new URL(String(call[0])).searchParams;
}

/** Recorded status GETs, in order (the long-poll query is not part of the path). */
function statusGets(mockFetch: { mock: { calls: unknown[][] } }): FetchCall[] {
	return callsTo(mockFetch, "/sandboxes/sb-1", "GET");
}

describe("v0.8 lifecycle", () => {
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
		vi.useRealTimers();
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	describe("pause", () => {
		it("waits for Paused by default and polls the Pausing hop", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(getResponse("Pausing"));
			mockFetch.mockResolvedValueOnce(getResponse("Paused"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			expect(sbx.status).toBe(SandboxStatus.Running);

			// No arguments: the v0.7-era call site keeps its blocking semantics.
			const pausing = sbx.pause();
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			await pausing;

			expect(sbx.status).toBe(SandboxStatus.Paused);
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(2);
		});

		it("returns at Pausing without polling when wait is false", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.pause({ wait: false });

			expect(sbx.status).toBe(SandboxStatus.Pausing);
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(0);
		});

		it("raises the backend's lastError when the pause lands on Failed", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(getResponse("Pausing"));
			mockFetch.mockResolvedValueOnce(
				getResponse("Failed", { lastError: "pvc snapshot rejected by CSI driver" }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const pausing = sbx.pause();
			const settled = pausing.catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			const error = await settled;
			expect(error).toBeInstanceOf(SandboxError);
			expect(String(error)).toMatch(/failed to pause/);
			expect(String(error)).toMatch(/pvc snapshot rejected by CSI driver/);
			expect(String(error)).toMatch(/re-issue pause\(\)/);
		});

		it("times out when the sandbox never leaves Pausing", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockImplementation(async () => getResponse("Pausing"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const pausing = sbx.pause({ timeout: 3 });
			const assertion = expect(pausing).rejects.toThrow(SandboxTimeoutError);
			await vi.advanceTimersByTimeAsync(3000);
			await assertion;
			await expect(pausing).rejects.toThrow(/did not pause within 3s/);
		});

		it("stops waiting when a delete preempts the pause", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(getResponse("Pausing"));
			mockFetch.mockResolvedValueOnce(getResponse("Deleting"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const pausing = sbx.pause();
			const assertion = expect(pausing).rejects.toThrow(/is being deleted/);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			await assertion;
		});

		it("surfaces a concurrent delete that finished mid-wait", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockResolvedValueOnce(mockResponse({ detail: "not found" }, 404));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await expect(sbx.pause()).rejects.toThrow(/deleted while waiting/);
		});

		it("retries a stalled poll instead of failing the pause", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Pausing" }, 202));
			mockFetch.mockRejectedValueOnce(abortTimeoutError());
			mockFetch.mockResolvedValueOnce(getResponse("Paused"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const pausing = sbx.pause();
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			await pausing;

			expect(sbx.status).toBe(SandboxStatus.Paused);
		});

		it("rejects a pause on a killed sandbox", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();

			await expect(sbx.pause()).rejects.toThrow(/has been killed/);
		});
	});

	describe("resume", () => {
		it("does not block and reports Resuming", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Paused"));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.resume();

			expect(sbx.status).toBe(SandboxStatus.Resuming);
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(0);
		});
	});

	describe("waitUntilReady", () => {
		it("polls through Resuming and warms the kernel on arrival", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Paused"));
			mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-1", phase: "Resuming" }, 202));
			mockFetch.mockResolvedValueOnce(getResponse("Resuming"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse());
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.resume();
			const ready = sbx.waitUntilReady(30);
			await vi.advanceTimersByTimeAsync(DEGRADED_POLL_MS);
			await ready;

			expect(sbx.status).toBe(SandboxStatus.Running);
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(2);
			// resumedFromPool is gone in v0.8, so the warmup probe always runs.
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(1);
		});

		it("bounds every poll GET to the remaining readiness budget", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockImplementation(async () => getResponse("Pending"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const budgets = captureRequestTimeouts();

			const ready = sbx.waitUntilReady(3);
			const assertion = expect(ready).rejects.toThrow(SandboxTimeoutError);
			await vi.advanceTimersByTimeAsync(3000);
			await assertion;
			// Without a per-request override each poll would inherit
			// config.timeout (300s) and could outlast the caller's 3s budget.
			expect(budgets.length).toBeGreaterThanOrEqual(2);
			expect(budgets[0]).toBeLessThanOrEqual(3000);
			expect(budgets[budgets.length - 1]).toBeLessThanOrEqual(1000);
			for (const [index, budget] of budgets.entries()) {
				expect(budget).toBeLessThanOrEqual(budgets[0]);
				if (index > 0) expect(budget).toBeLessThan(budgets[index - 1]);
			}
		});

		it("reports SandboxTimeoutError when every poll stalls", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockRejectedValue(abortTimeoutError());

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(3);
			const assertion = expect(ready).rejects.toThrow(/did not become ready/);
			await vi.advanceTimersByTimeAsync(3000);
			await assertion;
		});

		it("includes lastError when the sandbox lands on Failed", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(
				getResponse("Failed", { lastError: "image pull backoff: manifest unknown" }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(30);
			await expect(ready).rejects.toBeInstanceOf(SandboxError);
			await expect(ready).rejects.toThrow(/image pull backoff: manifest unknown/);
			await expect(ready).rejects.toThrow(/terminal state/);
		});

		it("refuses a sandbox that is already being deleted", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Deleting"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(30);
			await expect(ready).rejects.toBeInstanceOf(SandboxError);
			await expect(ready).rejects.toThrow(/Deleting/);
		});
	});

	describe("waitUntilReady long-poll", () => {
		it("asks the backend to hold the status GET until Running", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const budgets = captureRequestTimeouts();
			await sbx.waitUntilReady(100);

			const [statusGet] = statusGets(mockFetch);
			expect(queryOf(statusGet).get("wait_phase")).toBe("Running");
			// The backend caps its hold at 30s; the SDK never asks for a
			// window the backend would silently shorten.
			expect(queryOf(statusGet).get("timeout")).toBe("20");
			// The request must outlast the server-side hold, otherwise a
			// long-poll answering at its cap looks like a stalled request.
			expect(budgets[0]).toBeGreaterThan(20_000);
		});

		it("clamps the hold to the remaining readiness budget", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const budgets = captureRequestTimeouts();
			await sbx.waitUntilReady(10);

			const hold = Number(queryOf(statusGets(mockFetch)[0]).get("timeout"));
			// A 10s budget leaves 5s of hold once the response margin is
			// reserved — the hold shrinks, not just the request timeout.
			expect(hold).toBeGreaterThanOrEqual(1);
			expect(hold).toBeLessThanOrEqual(5);
			expect(budgets[0]).toBeLessThanOrEqual(10_000);
			expect(hold * 1000).toBeLessThan(budgets[0]);
		});

		it("sends a plain GET when nothing is left to hold", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(3);

			expect([...queryOf(statusGets(mockFetch)[0]).keys()]).toEqual([]);
		});

		it("paces an instant round that did not report the target phase", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(30);
			let settled = false;
			void ready.then(() => {
				settled = true;
			});

			// An old backend ignores wait_phase and answers at once; without
			// client-side pacing the loop would spin as fast as the network.
			await vi.advanceTimersByTimeAsync(DEGRADED_POLL_MS - 1);
			expect(settled).toBe(false);
			expect(statusGets(mockFetch)).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(1);
			await ready;
			expect(statusGets(mockFetch)).toHaveLength(2);
			expect(sbx.status).toBe(SandboxStatus.Running);
		});
	});

	describe("kernel warmup ping", () => {
		it("converges in one marker run when the ping reports the kernel warm", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.waitUntilReady(300);

			const [ping] = callsTo(mockFetch, "/sandboxes/sb-1/ping", "GET");
			expect(queryOf(ping).get("wait")).toBe("kernel");
			// A huge readiness budget must not park a request on the agent
			// forever: the wait window is capped at 100s.
			expect(queryOf(ping).get("timeout")).toBe("100");
			// The ping already proved the kernel is warm, so the marker
			// verification converges on its first round-trip.
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(1);
		});

		it("shrinks the ping wait window with the remaining budget", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const budgets = captureRequestTimeouts();
			await sbx.waitUntilReady(10);

			const [ping] = callsTo(mockFetch, "/sandboxes/sb-1/ping", "GET");
			const waitSeconds = Number(queryOf(ping).get("timeout"));
			// The agent may never block past the caller's own deadline.
			expect(waitSeconds).toBeGreaterThanOrEqual(1);
			expect(waitSeconds).toBeLessThanOrEqual(5);
			// budgets[0] is the status GET, budgets[1] the ping.
			expect(budgets[1]).toBeLessThanOrEqual(10_000);
		});

		it.each([400, 404, 405])("falls back to the probe loop on ping %i", async (status) => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(status));
			// Cold kernel on the first probe, warm on the retry.
			mockFetch.mockResolvedValueOnce(
				mockResponse({ stdout: "", stderr: "", success: true, durationMs: 1 }),
			);
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(60);
			await vi.advanceTimersByTimeAsync(500);
			await ready;

			expect(callsTo(mockFetch, "/sandboxes/sb-1/ping", "GET")).toHaveLength(1);
			// An agent without the endpoint keeps the retrying marker probe.
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(2);
		});

		it("retries a 503 ping inside the deadline", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockResolvedValueOnce(pingResponse(503));
			mockFetch.mockResolvedValueOnce(pingResponse(200));
			mockFetch.mockImplementationOnce(async (_url, init) =>
				warmupProbeResponse((init as RequestInit).body as string),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const ready = sbx.waitUntilReady(60);
			// 503 means "still cold": the instant answer is paced, then retried.
			await vi.advanceTimersByTimeAsync(500);
			await ready;

			expect(callsTo(mockFetch, "/sandboxes/sb-1/ping", "GET")).toHaveLength(2);
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(1);
		});

		it("warns and returns when the budget expires before the kernel is warm", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse("Pending"));
			mockFetch.mockResolvedValueOnce(getResponse("Running"));
			mockFetch.mockImplementation(async () => pingResponse(503));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const ready = sbx.waitUntilReady(2);
			await vi.advanceTimersByTimeAsync(2000);

			// Warmup never throws: the sandbox is up, only its kernel is unproven.
			await expect(ready).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/did not observe marker/));
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(0);
		});
	});

	describe("kill", () => {
		it("does not poll by default", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			// No arguments: unchanged v0.7 fire-and-forget shape.
			await sbx.kill();

			expect(callsTo(mockFetch, "/sandboxes/sb-1", "DELETE")).toHaveLength(1);
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(0);
			expect(sbx.status).toBe(SandboxStatus.Succeeded);
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/has been killed/);
		});

		it("polls until the backend reports the name released", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
			mockFetch.mockResolvedValueOnce(getResponse("Deleting"));
			mockFetch.mockResolvedValueOnce(mockResponse({ detail: "not found" }, 404));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const killing = sbx.kill({ wait: true });
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
			await killing;

			expect(callsTo(mockFetch, "/sandboxes/sb-1", "GET")).toHaveLength(2);
			expect(sbx.status).toBe(SandboxStatus.Succeeded);
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/has been killed/);
		});

		it("surfaces a terminal delete failure with the backend's reason", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
			mockFetch.mockResolvedValueOnce(getResponse("Deleting"));
			mockFetch.mockResolvedValueOnce(
				getResponse("Failed", { lastError: "workspace purge could not be confirmed" }),
			);

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const settled = sbx.kill({ wait: true }).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

			const error = await settled;
			expect(error).toBeInstanceOf(SandboxError);
			expect(String(error)).toMatch(/failed to delete: workspace purge could not be confirmed/);
			expect(String(error)).toMatch(/re-issue kill\(\)/);

			// The delete was admitted and terminally failed: no more work, but
			// kill() stays re-issuable.
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/is being deleted/);
		});

		it("stays deletion-locked after a wait timeout and accepts a re-issued kill", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
			mockFetch.mockImplementation(async () => getResponse("Deleting"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const settled = sbx.kill({ wait: true, timeout: 1 }).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(1000);

			const error = await settled;
			expect(error).toBeInstanceOf(SandboxTimeoutError);
			expect(String(error)).toMatch(/was not deleted within 1s/);

			// Deletion-locked: every normal operation is refused...
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/is being deleted/);
			expect(() => sbx.commands).toThrow(SandboxError);
			expect(() => sbx.files).toThrow(SandboxError);
			await expect(sbx.refresh()).rejects.toThrow(/is being deleted/);

			// ...but kill() may be re-issued, and a 404 on the re-issued
			// DELETE means the backend finished the teardown meanwhile.
			mockFetch.mockImplementation(async () => mockResponse({ detail: "not found" }, 404));
			await sbx.kill({ wait: true });
			expect(sbx.status).toBe(SandboxStatus.Succeeded);
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/has been killed/);
		});

		it("refuses work through helpers cached before the deletion lock engaged", async () => {
			vi.useFakeTimers();
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
			mockFetch.mockImplementation(async () => getResponse("Deleting"));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			// Grab the helpers while the sandbox is still usable: the guard has
			// to live in the helper methods, not only in the property getter.
			const commands = sbx.commands;
			const files = sbx.files;

			const settled = sbx.kill({ wait: true, timeout: 1 }).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(1000);
			expect(await settled).toBeInstanceOf(SandboxTimeoutError);

			const deleteCalls = callsTo(mockFetch, "/sandboxes/sb-1", "DELETE").length;
			await expect(commands.run("echo hi")).rejects.toThrow(/is being deleted/);
			await expect(files.write("/workspace/a.txt", "hi")).rejects.toThrow(/is being deleted/);
			await expect(files.read("/workspace/a.txt")).rejects.toThrow(/is being deleted/);
			await expect(files.list()).rejects.toThrow(/is being deleted/);
			await expect(files.writeBatch([{ path: "/workspace/a.txt", content: "hi" }])).rejects.toThrow(
				/is being deleted/,
			);
			// Nothing reached the backend.
			expect(callsTo(mockFetch, "/sandboxes/sb-1", "DELETE")).toHaveLength(deleteCalls);
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(0);
			expect(callsTo(mockFetch, "/sandboxes/sb-1/files", "POST")).toHaveLength(0);
		});

		it("refuses work through helpers cached before kill() completed", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			const commands = sbx.commands;
			const files = sbx.files;
			await sbx.kill();

			await expect(commands.run("echo hi")).rejects.toThrow(/has been killed/);
			await expect(files.list()).rejects.toThrow(/has been killed/);
			expect(callsTo(mockFetch, "/sandboxes/sb-1/exec", "POST")).toHaveLength(0);
		});

		it("treats a 404 from DELETE as the sandbox already being gone", async () => {
			const mockFetch = vi.mocked(fetch);
			mockFetch.mockResolvedValueOnce(versionResponse());
			mockFetch.mockResolvedValueOnce(claimResponse());
			mockFetch.mockResolvedValueOnce(mockResponse({ detail: "not found" }, 404));

			const sbx = await Sandbox.fromPool("pool", defaultConfig);
			await sbx.kill();

			expect(sbx.status).toBe(SandboxStatus.Succeeded);
			await expect(sbx.runCode("print(1)")).rejects.toThrow(/has been killed/);
		});
	});
});
