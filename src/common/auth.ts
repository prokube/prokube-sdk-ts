import type { Config } from "./config.js";
import { AuthenticationError } from "./errors.js";

export function getAuthHeaders(config: Config): Record<string, string> {
	if (config.apiKey) {
		return { "x-api-key": config.apiKey };
	}
	if (config.userId) {
		return { "kubeflow-userid": config.userId };
	}
	throw new AuthenticationError(
		"No authentication credentials found. " +
			"Set PROKUBE_API_KEY or PROKUBE_USER_ID environment variable, " +
			"or pass apiKey/userId option.",
	);
}
