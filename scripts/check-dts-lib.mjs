import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const declarationFiles = ["dist/index.d.ts", "dist/index.d.cts"];

const relativeImportPatterns = [
	/from\s+["'](\.{1,2}\/[^"']+)["']/g,
	/import\s+["'](\.{1,2}\/[^"']+)["']/g,
	/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

export function findRelativeSpecifiers(source) {
	const specifiers = new Set();

	for (const pattern of relativeImportPatterns) {
		for (const match of source.matchAll(pattern)) {
			specifiers.add(match[1]);
		}
	}

	return [...specifiers];
}

export function getDeclarationCandidatePaths(baseDir, specifier) {
	const candidate = resolve(baseDir, specifier);
	const includesDeclarationExtension = /\.d\.(?:cts|ts)$/.test(specifier);
	const strippedCandidate = candidate.replace(/\.(?:mjs|cjs|js)$/, "");
	const hasRuntimeExtension = strippedCandidate !== candidate;

	return [
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
}

export function validateDeclarationFile(file) {
	if (!existsSync(file)) {
		throw new Error(
			`Missing declaration file: ${file}. Ensure the build produced the expected declaration output before running this check.`,
		);
	}

	const source = readFileSync(file, "utf8");
	const baseDir = dirname(resolve(file));

	for (const specifier of findRelativeSpecifiers(source)) {
		const paths = getDeclarationCandidatePaths(baseDir, specifier);

		if (![...new Set(paths)].some((path) => existsSync(path))) {
			throw new Error(`Broken declaration import in ${file}: ${specifier}`);
		}
	}
}
