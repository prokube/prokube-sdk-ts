import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--run", "build"], {
	stdio: "inherit",
});

if (result.status !== 0) {
	throw new Error(
		"Prepare failed while running the build script. Ensure the git-based install includes the required build toolchain.",
	);
}
