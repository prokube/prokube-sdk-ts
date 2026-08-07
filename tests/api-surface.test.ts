import { describe, expect, it, vi } from "vitest";
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

	it("keeps SandboxClient.pause/resume resolving to void, with *Info for the body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ name: "sb-1", phase: "Pausing" }), {
					status: 202,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const client = new sdk.SandboxClient(
				new sdk.Config({
					apiUrl: "https://example.com",
					workspace: "ws",
					userId: "user@test.com",
				}),
				false,
			);

			// Type-level pin: these signatures fail to compile if the return
			// type widens away from Promise<void>, which is what pre-0.8 call
			// sites were written against.
			const pause: (name: string) => Promise<void> = client.pause.bind(client);
			const resume: (name: string) => Promise<void> = client.resume.bind(client);
			expect(await pause("sb-1")).toBeUndefined();
			expect(await resume("sb-1")).toBeUndefined();

			// The admission bodies live on the *Info variants.
			expect((await client.pauseInfo("sb-1")).name).toBe("sb-1");
			expect((await client.resumeInfo("sb-1")).name).toBe("sb-1");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps Sandbox.pause/resume/kill resolving to void", () => {
		// Type-level pin: assigning the method to a void-returning signature
		// fails to compile if the return type widens.
		const pause: (options?: sdk.PauseOptions) => Promise<void> = sdk.Sandbox.prototype.pause;
		const resume: () => Promise<void> = sdk.Sandbox.prototype.resume;
		const kill: (options?: sdk.KillOptions) => Promise<void> = sdk.Sandbox.prototype.kill;
		expect([pause, resume, kill].every((fn) => typeof fn === "function")).toBe(true);
	});

	it("reports the SDK version the compatibility warning quotes", () => {
		expect(sdk.getSdkVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
