import type { SandboxClient } from "./client.js";
import type { BatchFileWriteResponse, FileInfo, FileWriteInput } from "./models.js";

const textEncoder = new TextEncoder();

export class FileManager {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;

	constructor(client: SandboxClient, sandboxName: string) {
		this.client = client;
		this.sandboxName = sandboxName;
	}

	async write(path: string, content: string | Uint8Array): Promise<void> {
		const bytes = typeof content === "string" ? textEncoder.encode(content) : content;
		await this.client.writeFile(this.sandboxName, path, bytes);
	}

	async read(path: string): Promise<Uint8Array> {
		return this.client.readFile(this.sandboxName, path);
	}

	async writeBatch(items: FileWriteInput[]): Promise<BatchFileWriteResponse> {
		return this.client.writeFilesBatch(this.sandboxName, items);
	}

	async list(path = "/workspace"): Promise<FileInfo[]> {
		return this.client.listFiles(this.sandboxName, path);
	}
}
