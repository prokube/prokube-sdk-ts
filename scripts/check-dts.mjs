import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const declarationFiles = ["dist/index.d.ts", "dist/index.d.cts"];
const relativeImportPattern = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

for (const file of declarationFiles) {
	if (!existsSync(file)) {
		throw new Error(
			`Missing declaration file: ${file}. Ensure the build produced the expected declaration output before running this check.`,
		);
	}

	const source = readFileSync(file, "utf8");
	const baseDir = dirname(resolve(file));

	for (const match of source.matchAll(relativeImportPattern)) {
		const specifier = match[1];
		const candidate = resolve(baseDir, specifier);
		const includesDeclarationExtension = /\.d\.(?:cts|ts)$/.test(specifier);
		const strippedCandidate = candidate.replace(/\.(?:mjs|cjs|js)$/, "");
		const hasRuntimeExtension = strippedCandidate !== candidate;
		const paths = [
			...(includesDeclarationExtension ? [candidate] : []),
			`${candidate}.d.ts`,
			`${candidate}.d.cts`,
			resolve(candidate, "index.d.ts"),
			resolve(candidate, "index.d.cts"),
			...(hasRuntimeExtension
				? [
						`${strippedCandidate}.d.ts`,
						`${strippedCandidate}.d.cts`,
						resolve(strippedCandidate, "index.d.ts"),
						resolve(strippedCandidate, "index.d.cts"),
					]
				: []),
		];

		if (![...new Set(paths)].some((path) => existsSync(path))) {
			throw new Error(`Broken declaration import in ${file}: ${specifier}`);
		}
	}
}

console.log("Declaration imports resolve correctly.");
