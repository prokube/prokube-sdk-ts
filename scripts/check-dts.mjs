import {
	getDeclarationFilesFromPackageJson,
	validateDeclarationFile,
} from "./check-dts-lib.mjs";

for (const file of getDeclarationFilesFromPackageJson()) {
	validateDeclarationFile(file);
}

console.log("Declaration imports resolve correctly.");
