/**
 * Live acceptance suite for the TypeScript SDK.
 *
 * This file talks to a real pk-sandbox deployment and creates real, billable
 * resources. It is excluded from `npm test`; run it explicitly with
 * `npm run test:e2e` and real credentials. Without the required environment
 * every describe below skips cleanly (exit 0), so the command is safe to run
 * anywhere.
 *
 * Mirrors the scenarios of `pk-sandbox/tests/e2e/` against the public SDK
 * surface only — nothing here reaches past `src/index.js`.
 */

import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	NotFoundError,
	Sandbox,
	SandboxError,
	SandboxNotFoundError,
	SandboxPool,
	SandboxStatus,
} from "../../src/index.js";
import { loadLiveSandboxConfig, skipReason } from "./live-config.js";
import { printTimingReport, timed } from "./timing.js";

const config = loadLiveSandboxConfig();
const SKIP = config.missingRequiredEnv.length > 0;

if (SKIP) {
	console.warn(`[e2e] skipped: ${skipReason(config)}`);
}

const { sdkOptions, sandboxImage } = config;

/** Unique per run so concurrent runs against one cluster cannot collide. */
const RUN_ID = `ts-e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 4096).toString(36)}`;

afterAll(() => {
	printTimingReport(`Live E2E timings — single round (run ${RUN_ID})`);
});

/** Seconds to wait for a cold sandbox to become Running. */
const READY_TIMEOUT = 300;
/** Seconds to wait for pause/delete to settle. */
const LIFECYCLE_TIMEOUT = 300;

/**
 * Ephemeral pools are created only to prove the claim path works, so they stay
 * deliberately small regardless of the Python-parity `SANDBOX_POOL_SIZE`
 * default of 5. Setting `SANDBOX_POOL_SIZE=1` shrinks it further.
 */
const ephemeralPoolSize = Math.min(config.poolSize, 2);

const decoder = new TextDecoder();

/** Kill a sandbox during cleanup: never throws, tolerates an already-gone row. */
async function safeKill(sandbox: Sandbox | undefined): Promise<void> {
	if (!sandbox) return;
	try {
		await sandbox.kill({ wait: true, timeout: LIFECYCLE_TIMEOUT });
	} catch (error) {
		if (error instanceof SandboxNotFoundError || error instanceof NotFoundError) return;
		console.warn(`[e2e] cleanup: failed to kill '${sandbox.name}': ${String(error)}`);
	}
}

/** Delete a pool during cleanup: never throws, tolerates an already-gone pool. */
async function safeDeletePool(pool: SandboxPool | undefined): Promise<void> {
	if (!pool) return;
	try {
		await pool.delete();
	} catch (error) {
		if (error instanceof SandboxNotFoundError || error instanceof NotFoundError) return;
		console.warn(`[e2e] cleanup: failed to delete pool '${pool.name}': ${String(error)}`);
	}
}

// ===========================================================================
// 1. Direct create path: full lifecycle against a cold-started sandbox
// ===========================================================================

describe.skipIf(SKIP)("live sandbox: direct create lifecycle", () => {
	const name = `${RUN_ID}-direct`;
	const textPath = "/workspace/e2e-text.txt";
	const binaryPath = "/workspace/e2e-binary.bin";
	const textContent = `hello from ${name}`;
	const binaryContent = new Uint8Array(256).map((_unused, index) => index);

	let sandbox: Sandbox | undefined;
	/** Set once the sandbox has been deleted, so afterAll does not re-kill it. */
	let killed = false;

	/**
	 * The sandbox every step below operates on. Narrows the shared `undefined`
	 * slot (needed by cleanup) and fails loudly rather than skipping silently
	 * when creation in `beforeAll` did not happen.
	 */
	function activeSandbox(): Sandbox {
		if (!sandbox) throw new Error(`live sandbox '${name}' was never created`);
		return sandbox;
	}

	beforeAll(async () => {
		sandbox = await timed("Sandbox.create (admission)", () =>
			Sandbox.create(sandboxImage, { ...sdkOptions, name }),
		);
		await timed("waitUntilReady after create", () => activeSandbox().waitUntilReady(READY_TIMEOUT));
		expect(sandbox.name).toBe(name);
		expect(await sandbox.getPhase()).toBe(SandboxStatus.Running);
	});

	afterAll(async () => {
		if (killed) return;
		await safeKill(sandbox);
	});

	it("keeps Jupyter session state across runCode calls", async () => {
		const first = await timed("first runCode", () =>
			activeSandbox().runCode("e2e_marker = 41 + 1"),
		);
		expect(first.success, `stderr: ${first.stderr}`).toBe(true);
		const sessionId = activeSandbox().sessionId;
		expect(sessionId).toBeTruthy();

		const second = await timed("runCode (cached session)", () =>
			activeSandbox().runCode("print(e2e_marker)"),
		);
		expect(second.success, `stderr: ${second.stderr}`).toBe(true);
		expect(second.stdout).toContain("42");
		expect(activeSandbox().sessionId).toBe(sessionId);
	});

	it("drops that state after resetSession()", async () => {
		const previousSessionId = activeSandbox().sessionId;
		activeSandbox().resetSession();
		expect(activeSandbox().sessionId).toBeUndefined();

		const result = await timed("runCode after resetSession", () =>
			activeSandbox().runCode("print(e2e_marker)"),
		);
		expect(result.success).toBe(false);
		expect(`${result.errorName ?? ""}${result.stderr}`).toContain("NameError");
		// A fresh kernel means a different session id.
		expect(activeSandbox().sessionId).toBeTruthy();
		expect(activeSandbox().sessionId).not.toBe(previousSessionId);
	});

	it("runs shell commands and reports exit codes", async () => {
		const ok = await timed("commands.run (echo)", () =>
			activeSandbox().commands.run("echo e2e-shell-ok"),
		);
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout).toContain("e2e-shell-ok");

		const failed = await activeSandbox().commands.run("exit 3");
		expect(failed.exitCode).toBe(3);
	});

	it("round-trips text and binary files", async () => {
		await timed("files.write (text)", () => activeSandbox().files.write(textPath, textContent));
		expect(
			decoder.decode(await timed("files.read (text)", () => activeSandbox().files.read(textPath))),
		).toBe(textContent);

		await activeSandbox().files.write(binaryPath, binaryContent);
		const readBack = await activeSandbox().files.read(binaryPath);
		expect(Array.from(readBack)).toEqual(Array.from(binaryContent));
	});

	it("writes a batch and lists the directory", async () => {
		const batch = await timed("files.writeBatch (2 items)", () =>
			activeSandbox().files.writeBatch([
				{ path: "/workspace/e2e-batch-1.txt", content: "batch-one" },
				{ path: "/workspace/e2e-batch-2.txt", content: new Uint8Array([98, 116, 119, 111]) },
			]),
		);
		expect(batch.total).toBe(2);
		expect(batch.successCount, JSON.stringify(batch.results)).toBe(2);
		expect(batch.failureCount).toBe(0);
		expect(batch.success).toBe(true);

		const entries = await timed("files.list", () => activeSandbox().files.list("/workspace"));
		const names = entries.map((entry) => entry.name);
		expect(names).toContain("e2e-batch-1.txt");
		expect(names).toContain("e2e-batch-2.txt");
		expect(names).toContain("e2e-text.txt");
	});

	it("finds the sandbox via get, list and listPage", async () => {
		const fetched = await timed("Sandbox.get", () => Sandbox.get(name, sdkOptions));
		expect(fetched.name).toBe(name);
		expect(fetched.status).toBe(SandboxStatus.Running);

		const all = await timed("Sandbox.list", () => Sandbox.list(sdkOptions));
		expect(all.map((entry) => entry.name)).toContain(name);

		const page = await timed("Sandbox.listPage (limit 1)", () =>
			Sandbox.listPage({ ...sdkOptions, limit: 1 }),
		);
		expect(page.loaded).toBeLessThanOrEqual(1);
		expect(page.sandboxes.length).toBeLessThanOrEqual(page.loaded);
		expect(typeof page.hasMore).toBe("boolean");

		if (page.hasMore) {
			expect(page.continueToken).toBeTruthy();
			const next = await Sandbox.listPage({
				...sdkOptions,
				limit: 1,
				continueToken: page.continueToken,
			});
			expect(next.loaded).toBeLessThanOrEqual(1);
			const firstNames = page.sandboxes.map((entry) => entry.name);
			for (const entry of next.sandboxes) {
				expect(firstNames).not.toContain(entry.name);
			}
		} else {
			expect(page.continueToken).toBeUndefined();
		}
	});

	it("pauses the sandbox", async () => {
		// Re-establish kernel state so the resume step can prove it is lost.
		const seeded = await activeSandbox().runCode("pause_marker = 'survives-nothing'");
		expect(seeded.success, `stderr: ${seeded.stderr}`).toBe(true);

		await timed("pause (wait=true)", () =>
			activeSandbox().pause({ wait: true, timeout: LIFECYCLE_TIMEOUT }),
		);
		expect(activeSandbox().status).toBe(SandboxStatus.Paused);
		expect(await activeSandbox().getPhase()).toBe(SandboxStatus.Paused);
	});

	it("resumes with /workspace intact and the Jupyter session gone", async () => {
		await timed("resume (admission)", () => activeSandbox().resume());
		await timed("waitUntilReady after resume", () => activeSandbox().waitUntilReady(READY_TIMEOUT));
		expect(await activeSandbox().getPhase()).toBe(SandboxStatus.Running);

		// Persisted volume survives.
		expect(decoder.decode(await activeSandbox().files.read(textPath))).toBe(textContent);

		// Kernel state does not: the pod was torn down and rebuilt.
		const result = await activeSandbox().runCode("print(pause_marker)");
		expect(result.success).toBe(false);
		expect(`${result.errorName ?? ""}${result.stderr}`).toContain("NameError");
	});

	it("kills the sandbox and then reports it as not found", async () => {
		await timed("kill (wait=true)", () =>
			activeSandbox().kill({ wait: true, timeout: LIFECYCLE_TIMEOUT }),
		);
		killed = true;

		await expect(Sandbox.get(name, sdkOptions)).rejects.toBeInstanceOf(SandboxNotFoundError);
	});
});

// ===========================================================================
// 2. Pool path: claim a warm sandbox
// ===========================================================================

describe.skipIf(SKIP)("live sandbox: warm pool claim", () => {
	const ephemeralPoolName = `${RUN_ID}-pool`;
	/** Only set when this suite created the pool, so cleanup deletes only ours. */
	let ephemeralPool: SandboxPool | undefined;
	let poolName: string;
	let claimed: Sandbox | undefined;

	beforeAll(async () => {
		if (config.poolName) {
			poolName = config.poolName;
		} else {
			ephemeralPool = await timed("SandboxPool.create (admission)", () =>
				SandboxPool.create({
					...sdkOptions,
					name: ephemeralPoolName,
					image: sandboxImage,
					poolSize: ephemeralPoolSize,
				}),
			);
			poolName = ephemeralPool.name;
		}

		const pool = ephemeralPool ?? (await SandboxPool.get(poolName, sdkOptions));
		await timed("pool ready (poll readyReplicas>0)", async () => {
			const deadline = Date.now() + config.poolReadyTimeout * 1000;
			while (pool.readyReplicas < 1) {
				if (Date.now() >= deadline) {
					throw new Error(
						`pool '${poolName}' had no ready replica within ${config.poolReadyTimeout}s ` +
							`(replicas=${pool.replicas}, readyReplicas=${pool.readyReplicas})`,
					);
				}
				// Real delay on purpose: pool readiness is a cluster-side convergence
				// with no client-side signal to await, so there is no clock to fake.
				await delay(2000);
				await pool.refresh();
			}
		});
		expect(pool.readyReplicas).toBeGreaterThan(0);
	});

	afterAll(async () => {
		await safeKill(claimed);
		await safeDeletePool(ephemeralPool);
	});

	it("claims a sandbox from the pool and runs code in it", async () => {
		claimed = await timed("Sandbox.fromPool (claim)", () => Sandbox.fromPool(poolName, sdkOptions));
		const claimedSandbox = claimed;
		await timed("waitUntilReady after claim", () => claimedSandbox.waitUntilReady(READY_TIMEOUT));
		expect(await claimed.getPhase()).toBe(SandboxStatus.Running);

		const result = await timed("runCode in claimed sandbox", () =>
			claimedSandbox.runCode("print(6 * 7)"),
		);
		expect(result.success, `stderr: ${result.stderr}`).toBe(true);
		expect(result.stdout).toContain("42");

		await timed("kill claimed (wait=true)", () =>
			claimedSandbox.kill({ wait: true, timeout: LIFECYCLE_TIMEOUT }),
		);
		claimed = undefined;
	});
});

// ===========================================================================
// 3. Error surface
// ===========================================================================

describe.skipIf(SKIP)("live sandbox: error surface", () => {
	it("rejects Sandbox.get for a name that does not exist", async () => {
		await expect(Sandbox.get(`${RUN_ID}-absent`, sdkOptions)).rejects.toBeInstanceOf(
			SandboxNotFoundError,
		);
	});

	it("rejects pause on an already-killed sandbox", async () => {
		const name = `${RUN_ID}-doomed`;
		const sandbox = await Sandbox.create(sandboxImage, { ...sdkOptions, name });
		try {
			await sandbox.kill({ wait: true, timeout: LIFECYCLE_TIMEOUT });
			await expect(sandbox.pause({ wait: false })).rejects.toBeInstanceOf(SandboxError);
		} finally {
			await safeKill(sandbox);
		}
	});
});
