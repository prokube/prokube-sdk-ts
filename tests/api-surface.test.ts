import { describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";

/**
 * The 0.2.0 surface contract: everything the SDK supports stays exported and
 * behaving, and the three maintainer-approved pre-0.8 removals (see PR #40
 * comments 5218339682 / 5218412469) stay removed — `SandboxStatus.Bound`,
 * `SandboxInfo.resumedFromPool`, and `SandboxClient.resumeInfo()`, matching
 * the Python SDK 0.2.0. These tests fail loudly if a symbol is renamed,
 * dropped, or a removed one sneaks back.
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

	it("carries the supported SandboxStatus members and not the retired Bound", () => {
		expect(Object.values(sdk.SandboxStatus).sort()).toEqual(
			[
				"Pending",
				"Running",
				"Paused",
				"Succeeded",
				"Failed",
				"Unknown",
				"Pausing",
				"Resuming",
				"Deleting",
			].sort(),
		);
	});

	it("keeps the Sandbox statics that existing call sites use", () => {
		for (const name of ["fromPool", "create", "get", "connect", "list", "listPage"]) {
			expect(typeof (sdk.Sandbox as unknown as Record<string, unknown>)[name]).toBe("function");
		}
	});

	it("SandboxClient.pause/resume return the admission body (Python parity; typed-void wrappers must migrate)", async () => {
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

			// v0.8 deliberate break, mirroring the Python SDK's
			// `pause/resume -> SandboxInfo` change in its 0.2.0 release:
			// callers that only `await` are unaffected; wrappers annotated as
			// `Promise<void>` must drop the annotation or ignore the body.
			const pauseSig: (name: string) => Promise<sdk.SandboxInfo> = client.pause.bind(client);
			const resumeSig: (name: string) => Promise<sdk.SandboxInfo> = client.resume.bind(client);
			expect((await pauseSig("sb-1")).name).toBe("sb-1");
			expect((await resumeSig("sb-1")).name).toBe("sb-1");
			// The pre-0.8 resumeInfo alias is gone in 0.2.0, like in Python.
			expect("resumeInfo" in client).toBe(false);
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
