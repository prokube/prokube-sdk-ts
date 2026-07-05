import { describe, expect, it } from "vitest";
import { getAuthHeaders } from "../src/common/auth.js";
import { Config } from "../src/common/config.js";

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

	it("returns no auth headers when no credentials are configured", () => {
		const config = new Config({
			apiUrl: "https://example.com",
			workspace: "ns",
		});
		expect(getAuthHeaders(config)).toEqual({});
	});
});
