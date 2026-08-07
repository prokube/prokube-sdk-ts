/**
 * Side-effect-free environment parsing for the live Sandbox E2E suite.
 *
 * Mirrors `pk-sandbox/tests/e2e/live_sandbox_config.py` so the TypeScript and
 * Python acceptance suites read exactly the same environment contract. Importing
 * this module never touches the network and never reads `process.env`: parsing
 * happens when {@link loadLiveSandboxConfig} is called, against the map you pass
 * in (defaulting to `process.env`).
 */

import type { ConfigOptions } from "../../src/index.js";

/** Environment variables without which no live test can run. */
export const REQUIRED_ENV = ["PROKUBE_API_URL", "PROKUBE_WORKSPACE", "PROKUBE_API_KEY"] as const;

/** Same default image the Python live suite uses. */
export const DEFAULT_SANDBOX_IMAGE =
	"europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/pk-sandbox-base:v14-05-2026";

/** A read-only view of an environment, so tests can pass literals. */
export type Environ = Readonly<Record<string, string | undefined>>;

/** Configuration shared by the live Sandbox test modules. */
export interface LiveSandboxConfig {
	/** Required variables that were absent or empty, in declaration order. */
	readonly missingRequiredEnv: readonly string[];
	readonly apiUrl: string;
	readonly workspace: string;
	readonly apiKey: string;
	readonly sandboxImage: string;
	/** Pre-existing warm pool to reuse; `undefined` means "create an ephemeral one". */
	readonly poolName: string | undefined;
	readonly poolSize: number;
	readonly poolReadyTimeout: number;
	/** Options accepted by every SDK entry point (`Sandbox.create`, ...). */
	readonly sdkOptions: Required<Pick<ConfigOptions, "apiUrl" | "workspace" | "apiKey">>;
}

/**
 * Read a positive integer environment variable.
 *
 * @throws Error naming the variable when the value is not a positive integer.
 */
export function positiveIntEnv(name: string, defaultValue: string, environ: Environ): number {
	const rawValue = environ[name] ?? defaultValue;
	// Mirror Python's int(): whole decimal integers only. Number() alone would
	// accept "0x10", " ", "1e3" and "" — none of which int() parses.
	if (!/^[+-]?\d+$/.test(rawValue.trim())) {
		throw new Error(`${name} must be a positive integer, got: ${rawValue}`);
	}
	const value = Number(rawValue);
	if (value <= 0) {
		throw new Error(`${name} must be greater than 0, got: ${rawValue}`);
	}
	return value;
}

/** Parse the shared live Sandbox settings without creating runtime resources. */
export function loadLiveSandboxConfig(environ: Environ = process.env): LiveSandboxConfig {
	const apiUrl = environ.PROKUBE_API_URL ?? "";
	const workspace = environ.PROKUBE_WORKSPACE ?? "";
	const apiKey = environ.PROKUBE_API_KEY ?? "";

	return {
		missingRequiredEnv: REQUIRED_ENV.filter((name) => !environ[name]),
		apiUrl,
		workspace,
		apiKey,
		sandboxImage: environ.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
		poolName: environ.SANDBOX_POOL,
		poolSize: positiveIntEnv("SANDBOX_POOL_SIZE", "5", environ),
		poolReadyTimeout: positiveIntEnv("SANDBOX_POOL_READY_TIMEOUT", "120", environ),
		sdkOptions: { apiUrl, workspace, apiKey },
	};
}

/** Human-readable reason to print when the live suite is skipped. */
export function skipReason(config: LiveSandboxConfig): string {
	return `live Sandbox E2E tests require ${config.missingRequiredEnv.join(", ")}`;
}
