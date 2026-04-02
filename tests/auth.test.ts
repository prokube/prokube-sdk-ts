import { describe, expect, it } from "vitest";
import { getAuthHeaders } from "../src/common/auth.js";
import { Config } from "../src/common/config.js";
import { AuthenticationError } from "../src/common/errors.js";

describe("getAuthHeaders", () => {
	it("returns x-api-key header when api_key is set", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			apiKey: "test-key",
		});
		expect(getAuthHeaders(config)).toEqual({ "x-api-key": "test-key" });
	});

	it("returns kubeflow-userid header when user_id is set", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			userId: "user@test.com",
		});
		expect(getAuthHeaders(config)).toEqual({
			"kubeflow-userid": "user@test.com",
		});
	});

	it("api_key takes precedence over user_id", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			apiKey: "my-key",
			userId: "user@test.com",
		});
		expect(getAuthHeaders(config)).toEqual({ "x-api-key": "my-key" });
	});

	it("throws AuthenticationError when no credentials", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
			userId: "placeholder",
		});
		// Manually remove userId to simulate missing credentials
		Object.defineProperty(config, "userId", { value: undefined });
		Object.defineProperty(config, "apiKey", { value: undefined });
		expect(() => getAuthHeaders(config)).toThrow(AuthenticationError);
	});
});
