import type { Config } from "../common/config.js";
import {
	NotFoundError,
	PoolNotFoundError,
	ProKubeError,
	SandboxError,
	SandboxNotFoundError,
} from "../common/errors.js";
import { HttpClient } from "../common/http.js";
import { uint8ArrayToBase64 } from "./base64.js";
import {
	type BatchFileWriteResponse,
	type CodeResult,
	type CommandResult,
	type CreateSandboxRequest,
	type FileInfo,
	type FileWriteInput,
	type SandboxInfo,
	parseBatchFileWriteResponse,
	parseCodeResult,
	parseCommandResult,
	parseFileInfo,
	parseSandboxInfo,
} from "./models.js";

export class SandboxClient {
	private readonly http: HttpClient;
	private readonly workspace: string;

	constructor(config: Config) {
		this.http = new HttpClient(config);
		this.workspace = config.workspace;
	}

	// ---- Path helpers ----

	private sandboxesPath(): string {
		if (this.http.config.useApiKey) {
			return `/sandbox/${this.workspace}/sandboxes`;
		}
		return `/api/namespaces/${this.workspace}/sandboxes`;
	}

	private sandboxPath(name: string): string {
		return `${this.sandboxesPath()}/${name}`;
	}

	private sandboxSubPath(name: string, sub: string): string {
		return `${this.sandboxPath(name)}/${sub}`;
	}

	// ---- Sandbox lifecycle ----

	async claimFromPool(pool: string, volumeSize?: string): Promise<SandboxInfo> {
		const body: Record<string, unknown> = { poolName: pool };
		if (volumeSize) body.volumeSize = volumeSize;

		try {
			const data = (await this.http.post(`${this.sandboxesPath()}/claim`, body)) as Record<
				string,
				unknown
			>;
			return parseSandboxInfo(data, this.workspace);
		} catch (e) {
			if (e instanceof NotFoundError) {
				throw new PoolNotFoundError(`Pool '${pool}' not found`);
			}
			throw e;
		}
	}

	async create(params: CreateSandboxRequest): Promise<SandboxInfo> {
		const { image, name, volumeSize, cpu, memory, allowInternetAccess, envVars, secretRefs } =
			params;

		// Use `!== undefined` for every optional field so that explicit
		// falsy/empty values ("", "0") are forwarded to the backend (which
		// can then validate/reject them) instead of being silently dropped
		// by truthiness checks. Only `undefined` means "caller didn't set
		// this — use the backend default".
		const body: Record<string, unknown> = { image };
		if (name !== undefined) body.name = name;
		if (volumeSize !== undefined) body.volumeSize = volumeSize;
		if (cpu !== undefined) body.cpu = cpu;
		if (memory !== undefined) body.memory = memory;
		if (allowInternetAccess !== undefined) body.allowInternetAccess = allowInternetAccess;
		if (envVars !== undefined) body.envVars = envVars;
		if (secretRefs !== undefined) body.secretRefs = secretRefs;

		const data = (await this.http.post(this.sandboxesPath(), body)) as Record<string, unknown>;
		return parseSandboxInfo(data, this.workspace);
	}

	async list(): Promise<SandboxInfo[]> {
		const data = (await this.http.get(this.sandboxesPath())) as Record<string, unknown>;
		const sandboxes = (data.sandboxes ?? []) as Record<string, unknown>[];
		return sandboxes.map((s) => parseSandboxInfo(s, this.workspace));
	}

	async get(name: string): Promise<SandboxInfo> {
		try {
			const data = (await this.http.get(this.sandboxPath(name))) as Record<string, unknown>;
			return parseSandboxInfo(data, this.workspace);
		} catch (e) {
			if (e instanceof NotFoundError) {
				throw new SandboxNotFoundError(`Sandbox '${name}' not found`);
			}
			throw e;
		}
	}

	async delete(name: string): Promise<void> {
		await this.http.delete(this.sandboxPath(name));
	}

	// ---- Pause / Resume ----

	async pause(name: string): Promise<void> {
		try {
			await this.http.post(this.sandboxSubPath(name, "pause"));
		} catch (e) {
			if (e instanceof ProKubeError && e.statusCode === 409) {
				throw new SandboxError(`Cannot pause sandbox '${name}': not in Running state`, 409);
			}
			throw e;
		}
	}

	async resume(name: string): Promise<void> {
		try {
			await this.http.post(this.sandboxSubPath(name, "resume"));
		} catch (e) {
			if (e instanceof ProKubeError && e.statusCode === 409) {
				throw new SandboxError(`Cannot resume sandbox '${name}': not in Paused state`, 409);
			}
			throw e;
		}
	}

	// ---- Execution ----

	async execCode(
		name: string,
		code: string,
		language = "python",
		timeout = 300,
		sessionId?: string,
		resetSession = false,
	): Promise<CodeResult> {
		const body: Record<string, unknown> = {
			code,
			use_jupyter: true,
			timeout,
			language,
		};
		if (sessionId) body.session_id = sessionId;
		if (resetSession) body.reset_session = true;

		const data = (await this.http.post(this.sandboxSubPath(name, "exec"), body)) as Record<
			string,
			unknown
		>;

		return parseCodeResult(data);
	}

	async execCommand(name: string, command: string, timeout = 300): Promise<CommandResult> {
		const body = {
			code: command,
			use_jupyter: false,
			timeout,
		};

		const data = (await this.http.post(this.sandboxSubPath(name, "exec"), body)) as Record<
			string,
			unknown
		>;

		return parseCommandResult(data);
	}

	// ---- Files ----

	async writeFile(name: string, path: string, content: Uint8Array): Promise<void> {
		const base64 = uint8ArrayToBase64(content);
		await this.http.post(this.sandboxSubPath(name, "files"), {
			path,
			content: base64,
			encoding: "base64",
		});
	}

	async writeFilesBatch(
		name: string,
		items: FileWriteInput[],
	): Promise<BatchFileWriteResponse> {
		const textEncoder = new TextEncoder();
		const data = (await this.http.post(this.sandboxSubPath(name, "files/batch"), {
			items: items.map((item) => ({
				path: item.path,
				content: uint8ArrayToBase64(
					typeof item.content === "string" ? textEncoder.encode(item.content) : item.content,
				),
				encoding: "base64",
			})),
		})) as Record<string, unknown>;
		return parseBatchFileWriteResponse(data);
	}

	async readFile(name: string, path: string): Promise<Uint8Array> {
		return this.http.getBytes(this.sandboxSubPath(name, "files/download"), {
			path,
		});
	}

	async listFiles(name: string, path = "/workspace"): Promise<FileInfo[]> {
		const data = (await this.http.get(this.sandboxSubPath(name, "files"), {
			path,
		})) as Record<string, unknown>;

		const files = (data.files ?? []) as Record<string, unknown>[];
		return files.map(parseFileInfo);
	}

	close(): void {
		this.http.close();
	}
}
