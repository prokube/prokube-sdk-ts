import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MIN_BACKEND_VERSION,
	checkBackendCompatibility,
	parseVersion,
} from "../src/common/compat.js";
import { Config } from "../src/common/config.js";
import { HttpClient } from "../src/common/http.js";
import { mockResponse, versionResponse } from "./helpers.js";

const baseConfig = {
	apiUrl: "https://example.com",
	workspace: "test-ns",
	userId: "user@test.com",
};

describe("parseVersion", () => {
	it("parses a plain three-part version", () => {
		expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
	});

	it("drops pre-release and build suffixes", () => {
		expect(parseVersion("1.2.3-dev")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.3-alpha.1")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.3+build.123")).toEqual([1, 2, 3]);
	});

	it("normalizes short versions to three components", () => {
		expect(parseVersion("1.0")).toEqual([1, 0, 0]);
		expect(parseVersion("1")).toEqual([1, 0, 0]);
	});

	it("tolerates a v prefix in either case", () => {
		expect(parseVersion("v0.1.0")).toEqual([0, 1, 0]);
		expect(parseVersion("V1.2.3")).toEqual([1, 2, 3]);
	});

	it("keeps the leading digits of an rc/beta/alpha component", () => {
		expect(parseVersion("1.2.3rc1")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.3beta2")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.0a1")).toEqual([1, 2, 0]);
	});
});

describe("MIN_BACKEND_VERSION", () => {
	it("pins the v0.8 async lifecycle backend", () => {
		expect(MIN_BACKEND_VERSION).toBe("0.8.0");
	});
});

describe("checkBackendCompatibility", () => {
	let warn: MockInstance<(...args: unknown[]) => void>;

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("queries /api/version on the configured API URL", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(versionResponse("0.8.0"));

		await checkBackendCompatibility(new HttpClient(new Config(baseConfig)));

		expect(new URL(String(mockFetch.mock.calls[0][0])).pathname).toBe("/api/version");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns when the backend is older than the minimum", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(versionResponse("0.7.9"));

		await checkBackendCompatibility(new HttpClient(new Config(baseConfig)));

		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0][0]);
		expect(message).toContain("0.7.9");
		expect(message).toContain("Minimum required backend version: 0.8.0");
	});

	it("stays silent for a newer backend", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(versionResponse("0.9.1"));

		await checkBackendCompatibility(new HttpClient(new Config(baseConfig)));

		expect(warn).not.toHaveBeenCalled();
	});

	it("stays silent when the backend does not report a version", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(mockResponse({}));

		await checkBackendCompatibility(new HttpClient(new Config(baseConfig)));

		expect(warn).not.toHaveBeenCalled();
	});

	it("skips the check entirely under API key auth", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(versionResponse("0.1.0"));

		await checkBackendCompatibility(
			new HttpClient(new Config({ ...baseConfig, apiKey: "secret" })),
		);

		expect(mockFetch).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("swallows an unreachable backend", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockRejectedValue(new Error("connection refused"));

		await expect(
			checkBackendCompatibility(new HttpClient(new Config(baseConfig))),
		).resolves.toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it("swallows a backend without a version endpoint", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(mockResponse({ detail: "Not Found" }, 404));

		await expect(
			checkBackendCompatibility(new HttpClient(new Config(baseConfig))),
		).resolves.toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});
});
