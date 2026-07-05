import type { Config } from "./config.js";

export function getAuthHeaders(config: Config): Record<string, string> {
	if (config.apiKey) {
		return { "x-api-key": config.apiKey };
	}
	if (config.userId) {
		return { "kubeflow-userid": config.userId };
	}
	return {};
}
