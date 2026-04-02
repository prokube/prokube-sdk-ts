import type { SandboxClient } from "./client.js";
import type { CommandResult } from "./models.js";

export class CommandRunner {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;
	private readonly defaultTimeout: number;

	constructor(client: SandboxClient, sandboxName: string, defaultTimeout = 300) {
		this.client = client;
		this.sandboxName = sandboxName;
		this.defaultTimeout = defaultTimeout;
	}

	async run(command: string, timeout?: number): Promise<CommandResult> {
		return this.client.execCommand(this.sandboxName, command, timeout ?? this.defaultTimeout);
	}
}
