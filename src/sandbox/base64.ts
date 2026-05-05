export function uint8ArrayToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
