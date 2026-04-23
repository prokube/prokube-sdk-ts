import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const relativeImportPatterns = [
	/from\s+["'](\.{1,2}\/[^"']+)["']/g,
	/import\s+["'](\.{1,2}\/[^"']+)["']/g,
	/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

function collectTypesFromExports(exportsField, declarationFiles) {
	if (!exportsField || typeof exportsField !== "object") {
		return;
	}

	if (Array.isArray(exportsField)) {
		for (const entry of exportsField) {
			collectTypesFromExports(entry, declarationFiles);
		}
		return;
	}

	for (const [key, value] of Object.entries(exportsField)) {
		if (key === "types" && typeof value === "string") {
			declarationFiles.add(value);
			continue;
		}

		collectTypesFromExports(value, declarationFiles);
	}
}

export function getDeclarationFilesFromPackageJson(packageJsonPath = resolve("package.json")) {
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const files = new Set();

	if (typeof packageJson.types === "string") {
		files.add(packageJson.types);
	}

	collectTypesFromExports(packageJson.exports, files);

	if (files.size === 0) {
		throw new Error(
			`No declaration entrypoints were found in ${packageJsonPath}. Declare them via "types" and/or "exports.*.types".`,
		);
	}

	return [...files];
}

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

	if (includesDeclarationExtension) {
		return [candidate];
	}

	return [
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

function isWithinRoot(path, root) {
	return path === root || path.startsWith(`${root}${sep}`);
}

export function getDeclarationRoot(file, packageRoot = resolve(".")) {
	const absoluteFile = resolve(file);
	const resolvedPackageRoot = resolve(packageRoot);
	const relativeFile = relative(resolvedPackageRoot, absoluteFile);
	const [rootSegment] = relativeFile.split(sep);

	if (
		!rootSegment ||
		rootSegment === ".." ||
		relativeFile.startsWith(`..${sep}`) ||
		relativeFile === ".."
	) {
		throw new Error(
			`Cannot determine declaration root for ${file} relative to ${packageRoot}.`,
		);
	}

	if (!relativeFile.includes(sep)) {
		return resolvedPackageRoot;
	}

	return resolve(resolvedPackageRoot, rootSegment);
}

export function validateDeclarationFile(file, declarationRoot = getDeclarationRoot(file)) {
	if (!existsSync(file)) {
		throw new Error(
			`Missing declaration file: ${file}. Ensure the build produced the expected declaration output before running this check.`,
		);
	}

	const source = readFileSync(file, "utf8");
	const baseDir = dirname(resolve(file));

	for (const specifier of findRelativeSpecifiers(source)) {
		const paths = getDeclarationCandidatePaths(baseDir, specifier);
		const validPaths = [...new Set(paths)].filter((path) =>
			isWithinRoot(path, declarationRoot),
		);

		if (!validPaths.some((path) => existsSync(path))) {
			throw new Error(`Broken declaration import in ${file}: ${specifier}`);
		}
	}
}
