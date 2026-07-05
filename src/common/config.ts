export interface ConfigOptions {
	apiUrl?: string;
	workspace?: string;
	userId?: string;
	apiKey?: string;
	timeout?: number;
}

const IN_CLUSTER_AGENT_GATEWAY_URL =
	"http://agentgateway-proxy.agentgateway-system.svc.cluster.local";

export class Config {
	readonly apiUrl: string;
	readonly workspace: string;
	readonly userId: string | undefined;
	readonly apiKey: string | undefined;
	readonly timeout: number;

	constructor(options: ConfigOptions = {}) {
		this.apiKey = emptyToUndefined(options.apiKey ?? process.env.PROKUBE_API_KEY);
		const apiUrl =
			options.apiUrl ??
			process.env.PROKUBE_API_URL ??
			(this.apiKey == null && process.env.KUBERNETES_SERVICE_HOST
				? IN_CLUSTER_AGENT_GATEWAY_URL
				: undefined);
		const workspace = options.workspace ?? process.env.PROKUBE_WORKSPACE;

		if (!apiUrl) {
			throw new Error(
				"api_url is required. Set PROKUBE_API_URL environment variable or pass apiUrl option.",
			);
		}
		if (!workspace) {
			throw new Error(
				"workspace is required. Set PROKUBE_WORKSPACE environment variable or pass workspace option.",
			);
		}

		this.apiUrl = apiUrl.replace(/\/+$/, "");
		this.workspace = workspace;
		this.userId = emptyToUndefined(
			options.userId ?? process.env.PROKUBE_USER_ID ?? process.env.KF_USER,
		);

		const rawTimeout = options.timeout ?? parseIntSafe(process.env.PROKUBE_TIMEOUT);
		this.timeout = rawTimeout ?? 300;
	}

	get useApiKey(): boolean {
		return this.apiKey != null;
	}
}

function emptyToUndefined(value: string | undefined): string | undefined {
	return value ? value : undefined;
}

function parseIntSafe(value: string | undefined): number | undefined {
	if (value == null) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isNaN(n) ? undefined : n;
}
