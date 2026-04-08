import type { Config } from "../common/config.js";
import { NotFoundError, PoolNotFoundError } from "../common/errors.js";
import { HttpClient } from "../common/http.js";
import { type EnvVar, type PoolInfo, parsePoolInfo } from "./models.js";

/**
 * Parameters for {@link PoolClient.create}. Optional fields are omitted from
 * the outgoing request body when not set.
 */
export interface PoolCreateParams {
	name: string;
	image: string;
	poolSize: number;
	cpu?: string;
	memory?: string;
	allowInternetAccess?: boolean;
	envVars?: EnvVar[];
	secretRefs?: string[];
}

export class PoolClient {
	private readonly http: HttpClient;
	private readonly workspace: string;

	constructor(config: Config) {
		this.http = new HttpClient(config);
		this.workspace = config.workspace;
	}

	// ---- Path helpers ----

	private poolsPath(): string {
		if (this.http.config.useApiKey) {
			return `/sandbox/${this.workspace}/sandbox-pools`;
		}
		return `/api/namespaces/${this.workspace}/sandbox-pools`;
	}

	private poolPath(name: string): string {
		return `${this.poolsPath()}/${name}`;
	}

	// ---- Pool operations ----

	async create(params: PoolCreateParams): Promise<PoolInfo> {
		const { name, image, poolSize, cpu, memory, allowInternetAccess, envVars, secretRefs } = params;

		const body: Record<string, unknown> = { name, image, poolSize };
		if (cpu) body.cpu = cpu;
		if (memory) body.memory = memory;
		if (allowInternetAccess !== undefined) body.allowInternetAccess = allowInternetAccess;
		if (envVars !== undefined) body.envVars = envVars;
		if (secretRefs !== undefined) body.secretRefs = secretRefs;

		const data = (await this.http.post(this.poolsPath(), body)) as Record<string, unknown>;
		return parsePoolInfo(data, this.workspace);
	}

	async list(): Promise<PoolInfo[]> {
		const data = (await this.http.get(this.poolsPath())) as Record<string, unknown>;
		const pools = (data.pools ?? data.sandboxPools ?? []) as Record<string, unknown>[];
		return pools.map((p) => parsePoolInfo(p, this.workspace));
	}

	async get(name: string): Promise<PoolInfo> {
		try {
			const data = (await this.http.get(this.poolPath(name))) as Record<string, unknown>;
			return parsePoolInfo(data, this.workspace);
		} catch (e) {
			if (e instanceof NotFoundError) {
				throw new PoolNotFoundError(`Pool '${name}' not found`);
			}
			throw e;
		}
	}

	async delete(name: string): Promise<void> {
		await this.http.delete(this.poolPath(name));
	}

	close(): void {
		this.http.close();
	}
}
