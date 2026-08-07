import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE, REQUIRED_ENV, loadLiveSandboxConfig } from "./e2e/live-config.js";

/**
 * Unit coverage for the live E2E environment contract. This file deliberately
 * lives outside `tests/e2e/` so it runs in the normal suite: the live suite is
 * excluded from `npm test`, but its env parsing still has to be verified in CI.
 *
 * Mirrors `pk-sandbox/tests/e2e/test_live_sandbox_config.py`.
 */
describe("loadLiveSandboxConfig", () => {
	it("reports the required environment and applies defaults without side effects", () => {
		const config = loadLiveSandboxConfig({});

		expect(config.missingRequiredEnv).toEqual([
			"PROKUBE_API_URL",
			"PROKUBE_WORKSPACE",
			"PROKUBE_API_KEY",
		]);
		expect(config.missingRequiredEnv).toEqual([...REQUIRED_ENV]);
		expect(config.apiUrl).toBe("");
		expect(config.workspace).toBe("");
		expect(config.apiKey).toBe("");
		expect(config.sandboxImage).toBe(DEFAULT_SANDBOX_IMAGE);
		expect(config.poolName).toBeUndefined();
		expect(config.poolSize).toBe(5);
		expect(config.poolReadyTimeout).toBe(120);
		expect(config.sdkOptions).toEqual({ apiUrl: "", workspace: "", apiKey: "" });
	});

	it("parses configured values and maps them onto SDK options", () => {
		const config = loadLiveSandboxConfig({
			PROKUBE_API_URL: "https://example.test/api",
			PROKUBE_WORKSPACE: "test-workspace",
			PROKUBE_API_KEY: "test-key",
			SANDBOX_IMAGE: "example.test/sandbox:test",
			SANDBOX_POOL: "test-pool",
			SANDBOX_POOL_SIZE: "3",
			SANDBOX_POOL_READY_TIMEOUT: "45",
		});

		expect(config.missingRequiredEnv).toEqual([]);
		expect(config.sandboxImage).toBe("example.test/sandbox:test");
		expect(config.poolName).toBe("test-pool");
		expect(config.poolSize).toBe(3);
		expect(config.poolReadyTimeout).toBe(45);
		expect(config.sdkOptions).toEqual({
			apiUrl: "https://example.test/api",
			workspace: "test-workspace",
			apiKey: "test-key",
		});
	});

	it.each(["invalid", "0", "-1", "1.5", ""])(
		"rejects the non-positive-integer SANDBOX_POOL_SIZE %j",
		(value) => {
			expect(() => loadLiveSandboxConfig({ SANDBOX_POOL_SIZE: value })).toThrow(
				/SANDBOX_POOL_SIZE/,
			);
		},
	);

	it("names SANDBOX_POOL_READY_TIMEOUT when that variable is the invalid one", () => {
		expect(() => loadLiveSandboxConfig({ SANDBOX_POOL_READY_TIMEOUT: "nope" })).toThrow(
			"SANDBOX_POOL_READY_TIMEOUT must be a positive integer, got: nope",
		);
	});
});
