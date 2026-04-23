import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(repoRoot, ".artifacts");
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
const tarballPath = path.join(artifactsDir, tarballName);

mkdirSync(artifactsDir, { recursive: true });

execFileSync("npm", ["run", "pack:release"], {
  cwd: repoRoot,
  stdio: "inherit",
});

execFileSync(
  "docker",
  [
    "build",
    "--no-cache",
    "--build-arg",
    `PACKAGE_TGZ=${path.relative(repoRoot, tarballPath)}`,
    "-f",
    path.join("tests", "smoke", "release-consumer", "Dockerfile"),
    "-t",
    `prokube-sdk-smoke:${Date.now()}`,
    ".",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT ?? "1",
    },
  },
);
