import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const checkDtsScript = fileURLToPath(new URL("./check-dts.mjs", import.meta.url));

function resolvePackageBin(packageName, binName) {
	let packageJsonPath;

	try {
		packageJsonPath = require.resolve(`${packageName}/package.json`);
	} catch {
		throw new Error(
			`Missing required build dependency: ${packageName}. Install dependencies with optional packages enabled before running build/prepare.`,
		);
	}

	const packageJson = require(packageJsonPath);
	const binField = packageJson.bin;
	const relativeBinPath =
		typeof binField === "string" ? binField : binField?.[binName] ?? binField?.[packageName];

	if (!relativeBinPath) {
		throw new Error(`Could not resolve binary ${binName} from ${packageName}.`);
	}

	return resolve(dirname(packageJsonPath), relativeBinPath);
}

const tsupCli = resolvePackageBin("tsup", "tsup");
const tscCli = resolvePackageBin("typescript", "tsc");

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

		if (result.status === null && !result.error && !result.signal) {
			details.push("no exit status returned");
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
	const dtsSource = readFileSync("dist/index.d.ts", "utf8").replace(
		"//# sourceMappingURL=index.d.ts.map",
		"//# sourceMappingURL=index.d.cts.map",
	);
	writeFileSync("dist/index.d.cts", dtsSource);
}

if (existsSync("dist/index.d.ts.map")) {
	const dtsMap = JSON.parse(readFileSync("dist/index.d.ts.map", "utf8"));
	dtsMap.file = "index.d.cts";
	writeFileSync("dist/index.d.cts.map", `${JSON.stringify(dtsMap)}\n`);
}

runNodeScript(checkDtsScript, [], "check-dts");
