import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The v0.8 adaptation is a breaking change on the wire, not in the SDK's
 * TypeScript surface: every symbol that existed before must still be exported
 * and still behave. These tests fail loudly if a rename or removal slips in.
 */
describe("public API surface", () => {
	it("still exports every pre-0.8 runtime value", () => {
		for (const name of [
			"Sandbox",
			"SandboxPool",
			"SandboxClient",
			"PoolClient",
			"CodeRunner",
			"CommandRunner",
			"FileManager",
			"SandboxStatus",
			"Config",
			"commandSuccess",
			"combinedOutput",
			"ProKubeError",
			"AuthenticationError",
			"NotFoundError",
			"SandboxError",
			"SandboxNotFoundError",
			"SandboxTimeoutError",
			"SandboxExecutionError",
			"PoolNotFoundError",
			"PoolExhaustedError",
		]) {
			expect(sdk, `missing pre-0.8 export ${name}`).toHaveProperty(name);
		}
	});

	it("exports the new v0.8 values", () => {
		expect(sdk.MIN_BACKEND_VERSION).toBe("0.8.0");
		expect(typeof sdk.parseVersion).toBe("function");
		expect(typeof sdk.checkBackendCompatibility).toBe("function");
		expect(typeof sdk.getSdkVersion).toBe("function");
		expect(typeof sdk.RequestTimeoutError).toBe("function");
		expect(typeof sdk.HttpClient).toBe("function");
	});

	it("keeps RequestTimeoutError inside the ProKubeError hierarchy", () => {
		const error = new sdk.RequestTimeoutError("stalled");
		expect(error).toBeInstanceOf(sdk.ProKubeError);
		expect(error.name).toBe("RequestTimeoutError");
	});

	it("keeps every pre-0.8 SandboxStatus member and adds the transitional ones", () => {
		expect(Object.values(sdk.SandboxStatus)).toEqual(
			expect.arrayContaining([
				"Pending",
				"Running",
				"Paused",
				"Bound",
				"Succeeded",
				"Failed",
				"Unknown",
				"Pausing",
				"Resuming",
				"Deleting",
			]),
		);
	});

	it("keeps the Sandbox statics that existing call sites use", () => {
		for (const name of ["fromPool", "create", "get", "connect", "list", "listPage"]) {
			expect(typeof (sdk.Sandbox as unknown as Record<string, unknown>)[name]).toBe("function");
		}
	});

	it("reports the SDK version the compatibility warning quotes", () => {
		expect(sdk.getSdkVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
