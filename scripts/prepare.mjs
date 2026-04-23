import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const tsupCli = resolve("node_modules/tsup/dist/cli-default.js");
const checkDtsScript = resolve("scripts/check-dts.mjs");

if (!existsSync(tsupCli)) {
	throw new Error(
		"Prepare failed because tsup is not installed. Git installs require the build toolchain to be available in dependencies.",
	);
}

function runNodeScript(scriptPath, label) {
	const result = spawnSync(process.execPath, [scriptPath], {
		stdio: "inherit",
	});

	if (result.error || result.signal || result.status !== 0) {
		const details = [];

		if (result.error) {
			details.push(`spawn error: ${result.error.message}`);
		}

		if (result.signal) {
			details.push(`terminated by signal: ${result.signal}`);
		}

		if (result.status !== null && result.status !== 0) {
			details.push(`exit status: ${result.status}`);
		}

		const detailMessage = details.length > 0 ? ` (${details.join(", ")})` : "";

		throw new Error(`Prepare failed while running ${label}${detailMessage}.`);
	}
}

runNodeScript(tsupCli, "tsup");
runNodeScript(checkDtsScript, "check-dts");
