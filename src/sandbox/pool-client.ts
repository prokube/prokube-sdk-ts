import { checkBackendCompatibility } from "../common/compat.js";
import type { Config } from "../common/config.js";
import { NotFoundError, PoolNotFoundError } from "../common/errors.js";
import { HttpClient } from "../common/http.js";
import { type CreatePoolRequest, type PoolInfo, parsePoolInfo } from "./models.js";

export class PoolClient {
	private readonly http: HttpClient;
	private readonly workspace: string;
	private readonly checkVersion: boolean;
	private compatibilityChecked: Promise<void> | undefined;

	/**
	 * @param checkVersion Whether {@link ensureCompatibility} performs the
	 *   backend version check. Pass `false` for the extra clients built per
	 *   listing result, whose compatibility the listing client already
	 *   verified.
	 */
	constructor(config: Config, checkVersion = true) {
		this.http = new HttpClient(config);
		this.workspace = config.workspace;
		this.checkVersion = checkVersion;
	}

	/**
	 * Verify backend compatibility once, before the first real request.
	 * See {@link SandboxClient.ensureCompatibility}.
	 */
	async ensureCompatibility(): Promise<void> {
		if (!this.checkVersion) return;
		this.compatibilityChecked ??= checkBackendCompatibility(this.http);
		return this.compatibilityChecked;
	}

	// ---- Path helpers ----

	private poolsPath(): string {
		if (this.http.config.useApiKey) {
			return `/sandbox/${this.workspace}/sandbox-pools`;
		}
		return `/_platform/sandbox/${this.workspace}/sandbox-pools`;
	}

	private poolPath(name: string): string {
		return `${this.poolsPath()}/${name}`;
	}

	// ---- Pool operations ----

	async create(params: CreatePoolRequest): Promise<PoolInfo> {
		const {
			name,
			image,
			poolSize,
			cpu,
			memory,
			allowInternetAccess,
			autoIdleTimeoutSeconds,
			envVars,
			secretRefs,
		} = params;

		// Use `!== undefined` for every optional field so that explicit
		// falsy/empty values ("", "0") are forwarded to the backend (which
		// can then validate/reject them) instead of being silently dropped
		// by truthiness checks. Only `undefined` means "caller didn't set
		// this — use the backend default".
		const body: Record<string, unknown> = { name, image, poolSize };
		if (cpu !== undefined) body.cpu = cpu;
		if (memory !== undefined) body.memory = memory;
		if (allowInternetAccess !== undefined) body.allowInternetAccess = allowInternetAccess;
		if (autoIdleTimeoutSeconds !== undefined) {
			body.autoIdleTimeoutSeconds = autoIdleTimeoutSeconds;
		}
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
