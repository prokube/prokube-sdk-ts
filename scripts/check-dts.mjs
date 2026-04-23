import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const declarationFiles = ["dist/index.d.ts", "dist/index.d.cts"];
const relativeImportPattern = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

for (const file of declarationFiles) {
	const source = readFileSync(file, "utf8");
	const baseDir = dirname(resolve(file));

	for (const match of source.matchAll(relativeImportPattern)) {
		const specifier = match[1];
		const candidate = resolve(baseDir, specifier);
		const paths = [
			candidate,
			`${candidate}.d.ts`,
			`${candidate}.d.cts`,
			resolve(candidate, "index.d.ts"),
			resolve(candidate, "index.d.cts"),
		];

		if (!paths.some((path) => existsSync(path))) {
			throw new Error(`Broken declaration import in ${file}: ${specifier}`);
		}
	}
}

console.log("Declaration imports resolve correctly.");
