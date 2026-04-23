import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsupCli = require.resolve("tsup/dist/cli-default.js");
const tscCli = require.resolve("typescript/bin/tsc");
const checkDtsScript = fileURLToPath(new URL("./check-dts.mjs", import.meta.url));

function runNodeScript(scriptPath, args, label) {
	const result = spawnSync(process.execPath, [scriptPath, ...args], {
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

		throw new Error(`Build failed while running ${label}${detailMessage}.`);
	}
}

runNodeScript(tsupCli, [], "tsup");
runNodeScript(
	tscCli,
	["--emitDeclarationOnly", "--project", "tsconfig.json", "--outDir", "dist"],
	"tsc",
);

if (existsSync("dist/index.d.ts")) {
	copyFileSync("dist/index.d.ts", "dist/index.d.cts");
}

if (existsSync("dist/index.d.ts.map")) {
	copyFileSync("dist/index.d.ts.map", "dist/index.d.cts.map");
}

runNodeScript(checkDtsScript, [], "check-dts");
