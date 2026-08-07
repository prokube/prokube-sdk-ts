import type { SandboxClient } from "./client.js";
import type { BatchFileWriteResponse, FileInfo, FileWriteInput } from "./models.js";

const textEncoder = new TextEncoder();

export class FileManager {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;
	private readonly checkUsable: (() => void) | undefined;

	/**
	 * @param checkUsable Optional callback invoked before every operation.
	 *   {@link Sandbox} injects its killed/deletion-requested guard here so a
	 *   manager cached before the sandbox went away cannot keep issuing work —
	 *   mirroring the Python SDK's `FileManager(check_killed=...)`.
	 */
	constructor(client: SandboxClient, sandboxName: string, checkUsable?: () => void) {
		this.client = client;
		this.sandboxName = sandboxName;
		this.checkUsable = checkUsable;
	}

	async write(path: string, content: string | Uint8Array): Promise<void> {
		this.checkUsable?.();
		const bytes = typeof content === "string" ? textEncoder.encode(content) : content;
		await this.client.writeFile(this.sandboxName, path, bytes);
	}

	async read(path: string): Promise<Uint8Array> {
		this.checkUsable?.();
		return this.client.readFile(this.sandboxName, path);
	}

	async writeBatch(items: FileWriteInput[]): Promise<BatchFileWriteResponse> {
		this.checkUsable?.();
		return this.client.writeFilesBatch(this.sandboxName, items);
	}

	async list(path = "/workspace"): Promise<FileInfo[]> {
		this.checkUsable?.();
		return this.client.listFiles(this.sandboxName, path);
	}
}
