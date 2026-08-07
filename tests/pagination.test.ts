import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxStatus } from "../src/sandbox/models.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { apiCalls, mockResponse, versionResponse } from "./helpers.js";

const defaultConfig = {
	apiUrl: "https://example.com/pkui",
	workspace: "test-ns",
	userId: "user@test.com",
};

const SANDBOXES_PATH = "/pkui/_platform/sandbox/test-ns/sandboxes";

function listingRequest(mockFetch: { mock: { calls: unknown[][] } }): URL {
	const calls = apiCalls(mockFetch);
	expect(calls).toHaveLength(1);
	return new URL(String(calls[0][0]));
}

describe("Sandbox.listPage", () => {
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

	it("forwards the limit and continuation token and preserves page metadata", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [{ name: "paused-1", phase: "Paused", createdAt: "2026-01-01T00:00:00Z" }],
				loaded: 1,
				hasMore: true,
				continueToken: "next-token",
			}),
		);

		const page = await Sandbox.listPage({
			...defaultConfig,
			limit: 10,
			continueToken: "opaque-token",
		});

		const url = listingRequest(mockFetch);
		expect(url.pathname).toBe(SANDBOXES_PATH);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "10",
			continueToken: "opaque-token",
		});
		expect(page.sandboxes.map((sbx) => sbx.name)).toEqual(["paused-1"]);
		expect(page.sandboxes[0].status).toBe(SandboxStatus.Paused);
		expect(page.loaded).toBe(1);
		expect(page.hasMore).toBe(true);
		expect(page.continueToken).toBe("next-token");
	});

	it("requests 25 items by default and sends no token", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(mockResponse({ sandboxes: [], loaded: 0, hasMore: false }));

		const page = await Sandbox.listPage(defaultConfig);

		expect(Object.fromEntries(listingRequest(mockFetch).searchParams)).toEqual({ limit: "25" });
		expect(page.sandboxes).toEqual([]);
		expect(page.loaded).toBe(0);
		expect(page.hasMore).toBe(false);
		expect(page.continueToken).toBeUndefined();
	});

	it("omits an empty continuation token, which the backend rejects with 422", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(mockResponse({ sandboxes: [], loaded: 0, hasMore: false }));

		await Sandbox.listPage({ ...defaultConfig, continueToken: "" });

		expect(Object.fromEntries(listingRequest(mockFetch).searchParams)).toEqual({ limit: "25" });
	});

	it.each([0, 101, -1])("rejects an out-of-range limit (%i) before any request", async (limit) => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(versionResponse());

		await expect(Sandbox.listPage({ ...defaultConfig, limit })).rejects.toThrow(
			/limit must be between 1 and 100/,
		);
		expect(apiCalls(mockFetch)).toHaveLength(0);
	});

	it("accepts the legacy {sandboxes,total} listing shape", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", status: "Running" },
					{ name: "sb-2", status: "Pending" },
				],
				total: 2,
			}),
		);

		const page = await Sandbox.listPage(defaultConfig);

		expect(page.sandboxes.map((sbx) => sbx.name)).toEqual(["sb-1", "sb-2"]);
		expect(page.loaded).toBe(2);
		expect(page.hasMore).toBe(false);
		expect(page.continueToken).toBeUndefined();
	});

	it("filters by phase client-side without sending a phase query param", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", phase: "Running" },
					{ name: "sb-2", phase: "Paused" },
					{ name: "sb-3", phase: "Pausing" },
				],
				loaded: 3,
				hasMore: false,
			}),
		);

		const page = await Sandbox.listPage({ ...defaultConfig, phase: SandboxStatus.Paused });

		expect(page.sandboxes.map((sbx) => sbx.name)).toEqual(["sb-2"]);
		expect(listingRequest(mockFetch).searchParams.has("phase")).toBe(false);
		// `loaded`/`hasMore` describe the backend page, not the filtered view,
		// so paging stays correct while filtering.
		expect(page.loaded).toBe(3);
	});

	it("parses the v0.8 transitional phases and lastError on a page", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", phase: "Resuming" },
					{ name: "sb-2", phase: "Deleting" },
					{ name: "sb-3", phase: "Failed", lastError: "node evicted" },
				],
				loaded: 3,
				hasMore: false,
			}),
		);

		const page = await Sandbox.listPage(defaultConfig);

		expect(page.sandboxes.map((sbx) => sbx.status)).toEqual([
			SandboxStatus.Resuming,
			SandboxStatus.Deleting,
			SandboxStatus.Failed,
		]);
	});

	it("checks backend compatibility once, not once per sandbox on the page", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", phase: "Running" },
					{ name: "sb-2", phase: "Running" },
				],
				loaded: 2,
				hasMore: false,
			}),
		);

		await Sandbox.listPage(defaultConfig);

		const versionCalls = mockFetch.mock.calls.filter((call) =>
			String(call[0]).endsWith("/api/version"),
		);
		expect(versionCalls).toHaveLength(1);
	});

	it("gives every sandbox on the page a working client", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", phase: "Running" },
					{ name: "sb-2", phase: "Running" },
				],
				loaded: 2,
				hasMore: false,
			}),
		);

		const page = await Sandbox.listPage(defaultConfig);

		// Killing one page member must not disturb the other.
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
		await page.sandboxes[0].kill();
		expect(page.sandboxes[0].status).toBe(SandboxStatus.Succeeded);

		mockFetch.mockResolvedValueOnce(mockResponse({ name: "sb-2", phase: "Paused" }));
		await page.sandboxes[1].refresh();
		expect(page.sandboxes[1].status).toBe(SandboxStatus.Paused);
	});
});

describe("Sandbox.list", () => {
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

	it("keeps its unpaginated contract and sends no pagination params", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValueOnce(versionResponse());
		mockFetch.mockResolvedValueOnce(
			mockResponse({
				sandboxes: [
					{ name: "sb-1", status: "Running" },
					{ name: "sb-2", status: "Paused" },
				],
				total: 2,
			}),
		);

		const sandboxes = await Sandbox.list(defaultConfig);

		expect(sandboxes.map((sbx) => sbx.name)).toEqual(["sb-1", "sb-2"]);
		expect([...listingRequest(mockFetch).searchParams.keys()]).toEqual([]);
	});
});
