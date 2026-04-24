import { Config, Sandbox, commandSuccess } from "prokube";

const config = new Config({
  apiUrl: "https://example.invalid/pkui",
  workspace: "smoke-test",
  apiKey: "test-key",
});

if (!config.useApiKey) {
  throw new Error("Expected Config.useApiKey to be true");
}

if (typeof Sandbox.fromPool !== "function") {
  throw new Error("Expected Sandbox.fromPool to be available");
}

if (!commandSuccess({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 })) {
  throw new Error("Expected commandSuccess helper to return true");
}

console.log("release consumer smoke test passed");
