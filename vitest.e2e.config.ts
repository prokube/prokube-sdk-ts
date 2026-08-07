import { defineConfig } from "vitest/config";

/**
 * Live acceptance suite. Talks to a real pk-sandbox deployment, so it is never
 * part of `npm test`; run it with `npm run test:e2e`.
 *
 * Sandbox lifecycle steps are slow (cold start, pause, resume, delete) and the
 * scenarios share cluster resources, so files run one at a time and each test
 * gets a generous budget. Coverage is off: this suite measures the backend
 * contract, not source-line coverage.
 */
export default defineConfig({
	test: {
		globals: true,
		include: ["tests/e2e/**/*.test.ts"],
		fileParallelism: false,
		sequence: { concurrent: false },
		testTimeout: 600_000,
		hookTimeout: 600_000,
		teardownTimeout: 600_000,
		coverage: { enabled: false },
	},
});
