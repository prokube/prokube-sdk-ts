import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Config } from "../src/common/config.js";

describe("Config", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.PROKUBE_API_URL = undefined;
		process.env.PROKUBE_WORKSPACE = undefined;
		process.env.PROKUBE_USER_ID = undefined;
		process.env.PROKUBE_API_KEY = undefined;
		process.env.PROKUBE_TIMEOUT = undefined;
		process.env.KF_USER = undefined;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("creates config from explicit params", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "test-ns",
			userId: "user@test.com",
			timeout: 60,
		});
		expect(config.apiUrl).toBe("https://example.com");
		expect(config.workspace).toBe("test-ns");
		expect(config.userId).toBe("user@test.com");
		expect(config.timeout).toBe(60);
	});

	it("strips trailing slash from API URL", () => {
		const config = new Config({
			apiUrl: "https://example.com/pkui/",
			workspace: "ns",
			userId: "u",
		});
		expect(config.apiUrl).toBe("https://example.com/pkui");
	});

	it("reads config from env vars", () => {
		process.env.PROKUBE_API_URL = "https://env.example.com";
		process.env.PROKUBE_WORKSPACE = "env-ns";
		process.env.PROKUBE_USER_ID = "env-user@test.com";
		process.env.PROKUBE_TIMEOUT = "120";

		const config = new Config();
		expect(config.apiUrl).toBe("https://env.example.com");
		expect(config.workspace).toBe("env-ns");
		expect(config.userId).toBe("env-user@test.com");
		expect(config.timeout).toBe(120);
	});

	it("falls back to KF_USER for user_id", () => {
		process.env.KF_USER = "kf-user@test.com";
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
		});
		expect(config.userId).toBe("kf-user@test.com");
	});

	it("throws when api_url is missing", () => {
		expect(() => new Config({ workspace: "ns" })).toThrow("api_url is required");
	});

	it("throws when workspace is missing", () => {
		expect(() => new Config({ apiUrl: "https://example.com" })).toThrow("workspace is required");
	});

	it("uses default timeout when invalid", () => {
		process.env.PROKUBE_TIMEOUT = "not-a-number";
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			userId: "u",
		});
		expect(config.timeout).toBe(300);
	});

	it("has useApiKey true when api_key is set", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			apiKey: "test-key",
		});
		expect(config.useApiKey).toBe(true);
	});

	it("has useApiKey false when only user_id is set", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			userId: "user@test.com",
		});
		expect(config.useApiKey).toBe(false);
	});

	it("reads api_key from env", () => {
		process.env.PROKUBE_API_KEY = "env-api-key";
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
		});
		expect(config.apiKey).toBe("env-api-key");
		expect(config.useApiKey).toBe(true);
	});
});
