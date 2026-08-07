import type { SandboxClient } from "./client.js";
import type { CommandResult } from "./models.js";

export class CommandRunner {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;
	private readonly defaultTimeout: number;
	private readonly checkUsable: (() => void) | undefined;

	/**
	 * @param checkUsable Optional callback invoked before every operation.
	 *   {@link Sandbox} injects its killed/deletion-requested guard here so a
	 *   runner cached before the sandbox went away cannot keep issuing work —
	 *   mirroring the Python SDK's `CommandRunner(check_killed=...)`.
	 */
	constructor(
		client: SandboxClient,
		sandboxName: string,
		defaultTimeout = 300,
		checkUsable?: () => void,
	) {
		this.client = client;
		this.sandboxName = sandboxName;
		this.defaultTimeout = defaultTimeout;
		this.checkUsable = checkUsable;
	}

	async run(command: string, timeout?: number): Promise<CommandResult> {
		this.checkUsable?.();
		return this.client.execCommand(this.sandboxName, command, timeout ?? this.defaultTimeout);
	}
}
