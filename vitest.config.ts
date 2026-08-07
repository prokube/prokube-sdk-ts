import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// The live acceptance suite needs real credentials and a real cluster;
		// it runs only via `npm run test:e2e` (vitest.e2e.config.ts).
		exclude: [...configDefaults.exclude, "tests/e2e/**"],
		coverage: {
			provider: "v8",
		},
	},
});
