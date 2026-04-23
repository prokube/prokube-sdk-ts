import { spawnSync } from "node:child_process";

const packageManagerExec = process.env.npm_execpath;

if (!packageManagerExec) {
	throw new Error(
		"Prepare failed because the package manager executable could not be determined from npm_execpath.",
	);
}

const isNodeEntrypoint = /\.(?:c|m)?js$/i.test(packageManagerExec);
const command = isNodeEntrypoint ? process.execPath : packageManagerExec;
const args = isNodeEntrypoint
	? [packageManagerExec, "run", "build"]
	: ["run", "build"];

const result = spawnSync(command, args, {
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

	throw new Error(
		`Prepare failed while running the build script${detailMessage}. Ensure the git-based install includes the required build toolchain.`,
	);
}
