import { declarationFiles, validateDeclarationFile } from "./check-dts-lib.mjs";

for (const file of declarationFiles) {
	validateDeclarationFile(file);
}

console.log("Declaration imports resolve correctly.");
