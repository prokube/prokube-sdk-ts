import type { SandboxClient } from "./client.js";
import type { CommandResult } from "./models.js";

export class CommandRunner {
	private readonly client: SandboxClient;
	private readonly sandboxName: string;

	constructor(client: SandboxClient, sandboxName: string) {
		this.client = client;
		this.sandboxName = sandboxName;
	}

	async run(command: string, timeout = 300): Promise<CommandResult> {
		return this.client.execCommand(this.sandboxName, command, timeout);
	}
}
