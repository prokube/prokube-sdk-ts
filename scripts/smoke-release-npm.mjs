import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(repoRoot, ".artifacts");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;
const packageInstallPath = packageName.split("/");
const packedName = packageName.replace(/^@/, "").replaceAll("/", "-");
const tarballPath = path.join(artifactsDir, `${packedName}-${packageJson.version}.tgz`);

mkdirSync(artifactsDir, { recursive: true });

execFileSync("npm", ["run", "pack:release"], {
	cwd: repoRoot,
	stdio: "inherit",
});

if (!existsSync(tarballPath)) {
	throw new Error(`Expected release tarball at ${tarballPath}`);
}

const consumerDir = mkdtempSync(path.join(os.tmpdir(), "prokube-sdk-consumer-"));

writeFileSync(
	path.join(consumerDir, "package.json"),
	`${JSON.stringify(
		{
			name: "prokube-sdk-release-consumer-smoke",
			private: true,
			type: "module",
			dependencies: {
				[packageName]: `file:${tarballPath}`,
			},
		},
		null,
		2,
	)}\n`,
);

writeFileSync(
	path.join(consumerDir, "index.mjs"),
	`import { Config, Sandbox, commandSuccess } from ${JSON.stringify(packageName)};

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
`,
);

writeFileSync(
	path.join(consumerDir, "index.cjs"),
	`const { Config, Sandbox, commandSuccess } = require(${JSON.stringify(packageName)});

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
`,
);

execFileSync("npm", ["install", "--omit=dev"], {
	cwd: consumerDir,
	stdio: "inherit",
});

execFileSync("node", ["index.mjs"], { cwd: consumerDir, stdio: "inherit" });
execFileSync("node", ["index.cjs"], { cwd: consumerDir, stdio: "inherit" });

const installedPackageDir = path.join(consumerDir, "node_modules", ...packageInstallPath);
const installedPackageJson = JSON.parse(
	readFileSync(path.join(installedPackageDir, "package.json"), "utf8"),
);

if (installedPackageJson.scripts?.prepare) {
	throw new Error("Release package must not include a consumer-install prepare script");
}

for (const distFile of ["index.js", "index.cjs", "index.d.ts", "index.d.cts"]) {
	if (!existsSync(path.join(installedPackageDir, "dist", distFile))) {
		throw new Error(`Release package is missing dist/${distFile}`);
	}
}

const forbiddenRuntimePackages = ["tsup", "typescript", "@types/node", "esbuild"];

function dependencyTreeIncludesPackage(dependencies, dependencyName) {
	if (!dependencies) {
		return false;
	}

	for (const [installedName, dependency] of Object.entries(dependencies)) {
		if (installedName === dependencyName) {
			return true;
		}

		if (dependencyTreeIncludesPackage(dependency.dependencies, dependencyName)) {
			return true;
		}
	}

	return false;
}

function listRuntimeDependency(dependencyName) {
	let output;

	try {
		output = execFileSync("npm", ["ls", dependencyName, "--all", "--omit=dev", "--json"], {
			cwd: consumerDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (!(error instanceof Error) || !("stdout" in error)) {
			throw error;
		}

		output = error.stdout?.toString();
		if (!output) {
			throw new Error(
				`Unable to inspect runtime dependency ${dependencyName}: npm ls returned no JSON`,
			);
		}
	}

	try {
		return JSON.parse(output);
	} catch (error) {
		throw new Error(`Unable to parse npm ls output for ${dependencyName}: ${error.message}`);
	}
}

for (const dependencyName of forbiddenRuntimePackages) {
	const dependencyTree = listRuntimeDependency(dependencyName);

	if (dependencyTreeIncludesPackage(dependencyTree.dependencies, dependencyName)) {
		throw new Error(`Build-only package ${dependencyName} was installed as a runtime dependency`);
	}
}

console.log(`npm production install smoke test passed in ${consumerDir}`);
