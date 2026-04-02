import type { SandboxClient } from "./client.js";
import type { FileInfo } from "./models.js";

export class FileManager {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;

	constructor(client: SandboxClient, sandboxName: string) {
		this.client = client;
		this.sandboxName = sandboxName;
	}

	async write(path: string, content: string | Uint8Array): Promise<void> {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		await this.client.writeFile(this.sandboxName, path, bytes);
	}

	async read(path: string): Promise<Uint8Array> {
		return this.client.readFile(this.sandboxName, path);
	}

	async list(path = "/workspace"): Promise<FileInfo[]> {
		return this.client.listFiles(this.sandboxName, path);
	}
}
