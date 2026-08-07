import { vi } from "vitest";

/** A single recorded `fetch` invocation: `[input, init]`. */
export type FetchCall = [input: unknown, init?: RequestInit];

export function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Body served by `GET /api/version`.
 *
 * Every `Sandbox.*` / `SandboxPool.*` static factory awaits
 * `SandboxClient.ensureCompatibility()` first, so this is the *first* fetch
 * of any factory-driven flow. Tests that chain `mockResolvedValueOnce` must
 * enqueue it explicitly; tests using a persistent `mockResolvedValue` get
 * their generic body served here too (no `version` key means the check is a
 * silent no-op).
 */
export function versionResponse(version = "0.8.0"): Response {
	return mockResponse({ version });
}

/**
 * Recorded fetch calls with the compatibility probe filtered out, so
 * positional assertions stay stable regardless of whether a given flow
 * performed a version check.
 */
export function apiCalls(mockFetch: { mock: { calls: unknown[][] } }): FetchCall[] {
	return (mockFetch.mock.calls as FetchCall[]).filter(
		(call) => !new URL(String(call[0])).pathname.endsWith("/api/version"),
	);
}

/** Recorded calls whose path ends in `suffix` (e.g. `sb-1`, `sb-1/pause`). */
export function callsTo(
	mockFetch: { mock: { calls: unknown[][] } },
	suffix: string,
	method?: string,
): FetchCall[] {
	return apiCalls(mockFetch).filter(
		(call) =>
			new URL(String(call[0])).pathname.endsWith(suffix) &&
			(method === undefined || (call[1]?.method ?? "GET") === method),
	);
}

/**
 * Answer a kernel warmup probe by echoing its marker back.
 *
 * `waitUntilReady` proves the Jupyter pipeline is live by running
 * `print("__pk_warmup_<uuid>__")` until that exact marker shows up in stdout.
 * Throwing on an unrecognized body is deliberate: echoing an empty marker
 * would make the probe succeed vacuously and hide format regressions.
 */
export function warmupProbeResponse(requestBody: string): Response {
	const code = JSON.parse(requestBody).code as string;
	const match = code.match(/print\("(__pk_warmup_[a-f0-9]+__)"\)/);
	if (!match) {
		throw new Error(`Unexpected warmup probe request body: ${requestBody}`);
	}
	return mockResponse({
		stdout: `${match[1]}\n`,
		stderr: "",
		success: true,
		durationMs: 5,
		session_id: "sess-warm",
	});
}

/**
 * Reject the way `AbortSignal.timeout` does, so `HttpClient` can map it onto
 * `RequestTimeoutError` (the TS stand-in for `httpx.TimeoutException`).
 */
export function abortTimeoutError(): DOMException {
	return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * Capture the millisecond budgets handed to `AbortSignal.timeout`, which is
 * how `HttpClient` bounds a single request. Returns the (live) array the spy
 * appends to.
 */
export function captureRequestTimeouts(): number[] {
	const captured: number[] = [];
	const original = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		captured.push(ms);
		return original(ms);
	});
	return captured;
}
