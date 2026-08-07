import type { HttpClient } from "./http.js";

/**
 * Minimum pk-sandbox backend version this SDK targets.
 *
 * v0.8 made every sandbox mutation admission-only (202 + full Sandbox body)
 * and introduced the transitional phases `Pausing`, `Resuming` and
 * `Deleting`, which this SDK's lifecycle waits depend on.
 */
export const MIN_BACKEND_VERSION = "0.8.0";

/** Keep in sync with the `version` field in package.json. */
const SDK_VERSION = "0.2.0";

/** Get the current SDK version. */
export function getSdkVersion(): string {
	return SDK_VERSION;
}

/**
 * Parse a version string into a normalized `[major, minor, patch]` tuple.
 *
 * Accepts `"1.2.3"`, `"v0.1"`, `"0.1.0-dev"`, `"1.2.3rc1"` and friends:
 * a `v` prefix and any `-suffix`/`+build` are stripped, each component
 * contributes its leading digits, and missing components default to 0.
 */
export function parseVersion(version: string): [number, number, number] {
	const cleaned = version
		.replace(/^[vV]+/, "")
		.split("-")[0]
		.split("+")[0];
	const parts: number[] = [];
	for (const part of cleaned.split(".")) {
		const match = /^(\d+)/.exec(part);
		if (match) parts.push(Number.parseInt(match[1], 10));
	}
	return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Warn when the backend is older than {@link MIN_BACKEND_VERSION}.
 *
 * Never throws: an unreachable or version-less backend is not a reason to
 * fail the caller's actual operation, and a stale backend only degrades
 * gracefully. The check is skipped for API-key (external) auth because the
 * external routes do not expose `/api/version`.
 */
export async function checkBackendCompatibility(client: HttpClient): Promise<void> {
	if (client.config.useApiKey) return;

	try {
		const response = await client.get("/api/version");
		const version =
			response && typeof response === "object" && "version" in response
				? response.version
				: undefined;
		if (typeof version !== "string" || version === "" || version === "unknown") return;

		const backend = parseVersion(version);
		const minimum = parseVersion(MIN_BACKEND_VERSION);
		const isOlder =
			backend[0] !== minimum[0]
				? backend[0] < minimum[0]
				: backend[1] !== minimum[1]
					? backend[1] < minimum[1]
					: backend[2] < minimum[2];

		if (isOlder) {
			console.warn(
				`Backend version ${version} may be incompatible with SDK version ${SDK_VERSION}. Minimum required backend version: ${MIN_BACKEND_VERSION}. Some features may not work correctly.`,
			);
		}
	} catch {
		// The backend may not have a version endpoint yet, or may be
		// temporarily unreachable. Either way, don't block the caller.
	}
}
