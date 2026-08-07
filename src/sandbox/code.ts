import type { SandboxClient } from "./client.js";
import type { CodeResult } from "./models.js";

export class CodeRunner {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;
	private sessionId: string | undefined;
	private resetOnNextExec = false;
	private readonly checkUsable: (() => void) | undefined;

	/**
	 * @param checkUsable Optional callback invoked before every execution.
	 *   {@link Sandbox} injects its killed/deletion-requested guard here so a
	 *   runner cached before the sandbox went away cannot keep issuing work —
	 *   mirroring the Python SDK's `CodeRunner(check_killed=...)`, which
	 *   guards `run` only; session bookkeeping stays local and unguarded.
	 */
	constructor(client: SandboxClient, sandboxName: string, checkUsable?: () => void) {
		this.client = client;
		this.sandboxName = sandboxName;
		this.checkUsable = checkUsable;
	}

	async run(code: string, language = "python", timeout = 300): Promise<CodeResult> {
		this.checkUsable?.();
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
		this.sessionId = undefined;
		this.resetOnNextExec = true;
	}

	markSessionInvalid(): void {
		this.resetSession();
	}

	getSessionId(): string | undefined {
		return this.sessionId;
	}
}
