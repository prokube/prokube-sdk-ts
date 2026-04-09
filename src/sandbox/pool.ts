import { Config, type ConfigOptions } from "../common/config.js";
import { sleep } from "../common/time.js";
import type { EnvVar, PoolInfo, ResourceRequests } from "./models.js";
import { PoolClient } from "./pool-client.js";
import { Sandbox } from "./sandbox.js";

/**
 * Options for {@link SandboxPool.create}. New fields are optional; omitted
 * fields are not sent to the backend.
 */
export interface CreatePoolOptions extends ConfigOptions {
	/** Pool name (required). */
	name: string;
	/** Container image used for each pool member. */
	image: string;
	/** Number of warm pods to maintain. */
	poolSize: number;
	/** CPU / memory resource requests (e.g. `{ cpu: "2", memory: "4Gi" }`). */
	resources?: ResourceRequests;
	/** If set, whether pool members may reach the public internet. */
	allowInternetAccess?: boolean;
	/** Environment variables to inject into each pool member. */
	envVars?: EnvVar[];
	/** Names of Kubernetes secrets to mount/reference in each pool member. */
	secretRefs?: string[];
	/**
	 * If true (default), `SandboxPool.create` blocks until the pool's pods
	 * reach `readyReplicas >= pool.replicas` (the backend-reported desired
	 * replica count, which may differ from the requested `poolSize` if the
	 * backend clamps or applies defaults) and then claims a single sandbox
	 * to run the Jupyter kernel warmup probe against, in order to
	 * mitigate the cold-kernel race on the first subsequent
	 * `Sandbox.fromPool` claim (the ipykernel cold-start window is
	 * ~1.7s after pod Running). Set to `false` to preserve the legacy
	 * instant-return behaviour.
	 *
	 * The warmup is best-effort: a readiness or probe timeout after the
	 * pool CR has been created is logged via `console.warn` and the pool
	 * is still returned. Errors from the underlying pool create API call
	 * itself always propagate.
	 */
	waitUntilReady?: boolean;
	/**
	 * Maximum number of seconds to wait for pool pods to become ready and
	 * for the warmup probe to complete. Only used when `waitUntilReady`
	 * is not false. Defaults to 300 seconds.
	 */
	readyTimeout?: number;
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
	 *
	 * By default (`waitUntilReady` unset or true), this blocks until the
	 * pool's pods reach `readyReplicas >= pool.replicas` (the
	 * backend-reported desired count), then claims one sandbox and runs
	 * the Jupyter kernel warmup probe against it via
	 * `Sandbox.waitUntilReady()`, then kills the probe sandbox. The
	 * probe's wall-clock is roughly the ipykernel cold-start window, so
	 * by the time this call returns the other pool pods have had similar
	 * warm-up time. This *mitigates* the cold-kernel race on the first
	 * `Sandbox.fromPool` + `runCode` sequence against a fresh pool, but
	 * cannot guarantee it: readiness can time out, and
	 * `Sandbox.waitUntilReady` itself logs a warning and returns when its
	 * own probe deadline expires without seeing the marker.
	 *
	 * Pass `waitUntilReady: false` to preserve the legacy behaviour of
	 * returning immediately after the CR is created.
	 *
	 * Warmup is best-effort: a readiness or probe error after the pool CR
	 * has been created is logged via `console.warn` and the pool is still
	 * returned. Errors from the underlying pool create API call itself
	 * always propagate.
	 */
	static async create(options: CreatePoolOptions): Promise<SandboxPool> {
		const config = new Config(options);
		const client = new PoolClient(config);
		let pool: SandboxPool;
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
			pool = new SandboxPool(info, client);
		} catch (e) {
			client.close();
			throw e;
		}

		if (options.waitUntilReady === false) {
			return pool;
		}

		const readyTimeoutSec = options.readyTimeout ?? 300;
		try {
			await SandboxPool.warmPoolPods(pool, options, readyTimeoutSec);
		} catch (e) {
			// Best-effort warmup: never block pool handoff on probe errors.
			// Real pool-creation errors already propagated above.
			console.warn(
				`SandboxPool '${options.name}': warmup failed (${
					e instanceof Error ? e.message : String(e)
				}); returning pool anyway`,
			);
		}
		return pool;
	}

	/**
	 * Internal: wait for pool readiness then run a single cold-kernel
	 * warmup probe via a claimed sandbox. Bounded by `timeoutSec`. May
	 * throw — the caller (`create`) swallows and logs per "best-effort"
	 * contract.
	 */
	private static async warmPoolPods(
		pool: SandboxPool,
		options: CreatePoolOptions,
		timeoutSec: number,
	): Promise<void> {
		const deadline = Date.now() + timeoutSec * 1000;
		const pollIntervalMs = 2000;

		// Phase 1: poll refresh() until readyReplicas >= the backend-reported
		// desired count or deadline. Refresh BEFORE the first sleep so an
		// already-ready pool returns immediately without burning ~2s of
		// poll-interval (and ~2s of the readyTimeout budget). Compare against
		// pool.replicas (the backend's desired count) rather than
		// options.poolSize, since the backend may clamp or apply defaults.
		while (true) {
			await pool.refresh();
			if (pool.readyReplicas >= pool.replicas) break;

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				console.warn(
					`SandboxPool '${options.name}': timed out waiting for ${pool.replicas} ready replicas (saw ${pool.readyReplicas}); skipping warmup probe`,
				);
				return;
			}
			await sleep(Math.min(pollIntervalMs, remainingMs));
		}

		// Phase 2: claim one sandbox, run the warmup probe via the
		// existing Sandbox.waitUntilReady() path (which internally runs
		// warmupKernel), then kill it. The remaining budget is what's
		// left of readyTimeout after waiting for pods to come up.
		//
		// Sandbox.waitUntilReady's deadline math is millisecond-precise but
		// its parameter is an integer second count internally clamped by
		// warmupKernel (which itself skips when <1s remains). To avoid
		// overrunning the caller's readyTimeout budget by up to ~999ms, we
		// only run the probe when at least 1s of budget remains, and pass
		// the floor of the remaining seconds rather than rounding up.
		const remainingMs = deadline - Date.now();
		if (remainingMs < 1000) {
			console.warn(
				`SandboxPool '${options.name}': less than 1s of warmup budget remains after readiness poll; skipping warmup probe`,
			);
			return;
		}
		const probeTimeoutSec = Math.floor(remainingMs / 1000);

		const sbx = await Sandbox.fromPool(options.name, options);
		try {
			await sbx.waitUntilReady(probeTimeoutSec);
		} finally {
			try {
				await sbx.kill();
			} catch (e) {
				// Swallow kill errors — if the probe already succeeded we
				// don't want to fail the outer create, and if it didn't the
				// outer catch in create() will log anyway. Sandbox.kill now
				// closes its underlying HTTP client in a finally block even
				// when delete fails (see Sandbox.kill), so there's no
				// connection leak to clean up here.
				console.warn(
					`SandboxPool '${options.name}': failed to kill warmup probe sandbox '${sbx.name}' (${
						e instanceof Error ? e.message : String(e)
					})`,
				);
			}
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
