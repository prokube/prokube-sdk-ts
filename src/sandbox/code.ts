import type { SandboxClient } from "./client.js";
import type { CodeResult } from "./models.js";

export class CodeRunner {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;
	private sessionId: string | undefined;
	private resetOnNextExec = false;

	constructor(client: SandboxClient, sandboxName: string) {
		this.client = client;
		this.sandboxName = sandboxName;
	}

	async run(code: string, language = "python", timeout = 300): Promise<CodeResult> {
		const resetSession = this.resetOnNextExec;

		const result = await this.client.execCode(
			this.sandboxName,
			code,
			language,
			timeout,
			this.sessionId,
			resetSession,
		);

		this.resetOnNextExec = false;
		if (result.sessionId) {
			this.sessionId = result.sessionId;
		}

		return result;
	}

	resetSession(): void {
		this.resetOnNextExec = true;
	}

	markSessionInvalid(): void {
		this.resetOnNextExec = true;
	}

	getSessionId(): string | undefined {
		return this.sessionId;
	}
}
