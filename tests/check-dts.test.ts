import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
	findRelativeSpecifiers,
	getDeclarationCandidatePaths,
	getDeclarationFilesFromPackageJson,
	getDeclarationRoot,
	validateDeclarationFile,
} from "../scripts/check-dts-lib.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "prokube-check-dts-"));
	tempDirs.push(dir);
	return dir;
}

describe("check-dts helpers", () => {
	it("finds relative specifiers across declaration import forms", () => {
		const source = `
			export { Foo } from "./foo.js";
			import "./bar.js";
			type Baz = import("../baz.js").Baz;
		`;

		expect(findRelativeSpecifiers(source)).toEqual([
			"./foo.js",
			"./bar.js",
			"../baz.js",
		]);
	});

	it("accepts runtime extensions that map to declaration files", () => {
		const dir = createTempDir();
		const declarationFile = join(dir, "index.d.ts");

		writeFileSync(declarationFile, 'export { Foo } from "./foo.js";');
		writeFileSync(join(dir, "foo.d.ts"), "export interface Foo {}\n");

		expect(() => validateDeclarationFile(declarationFile, dir)).not.toThrow();
	});

	it("checks import type queries and side-effect imports", () => {
		const dir = createTempDir();
		const declarationFile = join(dir, "index.d.ts");

		writeFileSync(
			declarationFile,
			'type Foo = import("./types.js").Foo;\nimport "./setup.js";\n',
		);
		writeFileSync(join(dir, "types.d.ts"), "export interface Foo {}\n");
		writeFileSync(join(dir, "setup.d.ts"), "export {}\n");

		expect(() => validateDeclarationFile(declarationFile, dir)).not.toThrow();
	});

	it("keeps explicit declaration specifiers exact", () => {
		const paths = getDeclarationCandidatePaths("/tmp/dist", "./foo.d.ts");

		expect(paths).toEqual([resolve("/tmp/dist", "./foo.d.ts")]);
	});

	it("rejects imports that escape the published declaration root", () => {
		const dir = createTempDir();
		const distDir = join(dir, "dist");
		const declarationFile = join(distDir, "index.d.ts");

		mkdirSync(distDir);
		writeFileSync(declarationFile, 'export { Foo } from "../src/foo.js";');
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "foo.d.ts"), "export interface Foo {}\n");

		expect(() => validateDeclarationFile(declarationFile, distDir)).toThrow(
			`Broken declaration import in ${declarationFile}: ../src/foo.js`,
		);
	});

	it("does not treat bare directories as valid declaration targets", () => {
		const dir = createTempDir();
		const declarationFile = join(dir, "index.d.ts");

		writeFileSync(declarationFile, 'export { Foo } from "./foo";');
		mkdirSync(join(dir, "foo"));

		expect(() => validateDeclarationFile(declarationFile, dir)).toThrow(
			`Broken declaration import in ${declarationFile}: ./foo`,
		);
	});

	it("collects declaration entrypoints from package.json metadata", () => {
		const dir = createTempDir();
		const packageJsonPath = join(dir, "package.json");

		writeFileSync(
			packageJsonPath,
			JSON.stringify(
				{
					types: "./dist/index.d.ts",
					exports: {
						".": {
							import: { types: "./dist/index.d.ts" },
							require: { types: "./dist/index.d.cts" },
						},
					},
				},
				null,
				2,
			),
		);

		expect(getDeclarationFilesFromPackageJson(packageJsonPath)).toEqual([
			"./dist/index.d.ts",
			"./dist/index.d.cts",
		]);
	});

	it("uses the package root for root-level declaration files", () => {
		const dir = createTempDir();
		const declarationFile = join(dir, "index.d.ts");

		writeFileSync(declarationFile, "export interface Root {}\n");

		expect(getDeclarationRoot(declarationFile, dir)).toBe(dir);
	});
});
