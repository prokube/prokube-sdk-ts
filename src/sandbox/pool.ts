import { Config, type ConfigOptions } from "../common/config.js";
import type { EnvVar, PoolInfo } from "./models.js";
import { PoolClient } from "./pool-client.js";

export interface CreatePoolOptions extends ConfigOptions {
	name: string;
	image: string;
	poolSize: number;
	resources?: {
		cpu?: string;
		memory?: string;
	};
	allowInternetAccess?: boolean;
	envVars?: EnvVar[];
	secretRefs?: string[];
}

export class SandboxPool {
	private readonly _client: PoolClient;
	private _name: string;
	private _workspace: string;
	private _replicas: number;
	private _readyReplicas: number;
	private _image: string | undefined;
	private _cpu: string | undefined;
	private _memory: string | undefined;

	private constructor(info: PoolInfo, client: PoolClient) {
		this._client = client;
		this._name = info.name;
		this._workspace = info.workspace;
		this._replicas = info.replicas;
		this._readyReplicas = info.readyReplicas;
		this._image = info.image;
		this._cpu = info.cpu;
		this._memory = info.memory;
	}

	// ---- Factory methods ----

	/**
	 * Create a new warm pool.
	 */
	static async create(options: CreatePoolOptions): Promise<SandboxPool> {
		const config = new Config(options);
		const client = new PoolClient(config);
		try {
			const info = await client.create({
				name: options.name,
				image: options.image,
				poolSize: options.poolSize,
				cpu: options.resources?.cpu,
				memory: options.resources?.memory,
				allowInternetAccess: options.allowInternetAccess,
				envVars: options.envVars,
				secretRefs: options.secretRefs,
			});
			return new SandboxPool(info, client);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	/**
	 * List all warm pools in the workspace.
	 */
	static async list(options: ConfigOptions = {}): Promise<SandboxPool[]> {
		const config = new Config(options);
		const client = new PoolClient(config);
		try {
			const infos = await client.list();
			return infos.map((info) => new SandboxPool(info, new PoolClient(config)));
		} finally {
			client.close();
		}
	}

	/**
	 * Get a warm pool by name.
	 */
	static async get(name: string, options: ConfigOptions = {}): Promise<SandboxPool> {
		const config = new Config(options);
		const client = new PoolClient(config);
		try {
			const info = await client.get(name);
			return new SandboxPool(info, client);
		} catch (e) {
			client.close();
			throw e;
		}
	}

	// ---- Properties ----

	get name(): string {
		return this._name;
	}

	get workspace(): string {
		return this._workspace;
	}

	get replicas(): number {
		return this._replicas;
	}

	get readyReplicas(): number {
		return this._readyReplicas;
	}

	get image(): string | undefined {
		return this._image;
	}

	get cpu(): string | undefined {
		return this._cpu;
	}

	get memory(): string | undefined {
		return this._memory;
	}

	// ---- Operations ----

	/**
	 * Delete this warm pool.
	 */
	async delete(): Promise<void> {
		try {
			await this._client.delete(this._name);
		} finally {
			this._client.close();
		}
	}

	/**
	 * Refresh pool info from the API.
	 */
	async refresh(): Promise<void> {
		const info = await this._client.get(this._name);
		this._replicas = info.replicas;
		this._readyReplicas = info.readyReplicas;
		if (info.image) this._image = info.image;
		if (info.cpu) this._cpu = info.cpu;
		if (info.memory) this._memory = info.memory;
	}
}
