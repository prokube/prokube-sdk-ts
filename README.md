# prokube-sdk-ts

TypeScript SDK for the [prokube.ai](https://prokube.ai) sandbox platform.

## Installation

```bash
# From npm/GitHub Packages when published
npm install prokube

# For development
git clone https://github.com/prokube/prokube-sdk-ts.git
cd prokube-sdk-ts
npm install
```

For Bun consumers and Docker builds, prefer the prebuilt release tarball over a
GitHub source dependency. Bun does not run git dependency lifecycle scripts by
default, so installing from source can leave `dist/` missing unless the package
is explicitly trusted.

```bash
# Replace v0.1.0 with the desired release tag; note the filename drops the 'v' prefix
bun add https://github.com/prokube/prokube-sdk-ts/releases/download/v0.1.0/prokube-0.1.0.tgz
```

Each GitHub release publishes a packed `.tgz` built from the SDK's `dist/`
output, so consumers do not need to run `prepare` or rebuild inside Docker.

To validate the release package path locally, run:

```bash
npm run smoke:release
```

## Quick Start

```typescript
import { Sandbox } from "prokube";

// Claim a sandbox from a warm pool (instant, <100ms)
const sbx = await Sandbox.fromPool("python-pool");

// Or create directly (cold start, ~10-30s)
const sbx2 = await Sandbox.create("pk-sandbox:python-datascience");
await sbx2.waitUntilReady();

// Execute code (stateful - variables persist between calls)
await sbx.runCode("import pandas as pd");
await sbx.runCode("df = pd.read_csv('/workspace/data.csv')");
const result = await sbx.runCode("print(df.describe())");
console.log(result.stdout);

// Run shell commands
const cmdResult = await sbx.commands.run("pip install scikit-learn");
console.log(cmdResult.exitCode);

// File operations
await sbx.files.write("/workspace/data.csv", "col1,col2\n1,2\n3,4");
const content = await sbx.files.read("/workspace/output.txt");
const files = await sbx.files.list("/workspace");

// Cleanup
await sbx.kill();
```

### Automatic Cleanup

Using TC39 Explicit Resource Management (`await using`):

```typescript
import { Sandbox } from "prokube";

{
  await using sbx = await Sandbox.fromPool("python-pool");
  const result = await sbx.runCode("print(42)");
  console.log(result.stdout);
} // Sandbox is automatically killed
```

Or with a `try/finally` block:

```typescript
const sbx = await Sandbox.fromPool("python-pool");
try {
  const result = await sbx.runCode("print(42)");
  console.log(result.stdout);
} finally {
  await sbx.kill();
}
```

## Configuration

Configuration can be provided via environment variables or explicitly.

### Environment Variables

```bash
export PROKUBE_API_URL=https://prokube.ai/pkui  # Can include path prefix
export PROKUBE_WORKSPACE=my-workspace
export PROKUBE_USER_ID=user@example.com  # Required if no API key (or KF_USER)
export PROKUBE_TIMEOUT=300  # Optional, default 300 seconds
```

**Note:** Authentication requires one of: `PROKUBE_API_KEY`, `PROKUBE_USER_ID`, or
`KF_USER` (precedence in that order). `PROKUBE_API_KEY` enables external access;
`PROKUBE_USER_ID` and `KF_USER` are for in-cluster usage. If none are set, you must
pass `apiKey` or `userId` explicitly when creating a Sandbox.

### Explicit Configuration

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("python-pool", {
  apiUrl: "https://prokube.ai/pkui",
  workspace: "my-workspace",
  userId: "user@example.com",
});
```

### External Access (API Key)

For accessing prokube.ai from outside the cluster, use an API key:

```bash
export PROKUBE_API_URL=https://prokube.ai/pkui
export PROKUBE_WORKSPACE=my-workspace
export PROKUBE_API_KEY=your-api-key
```

```typescript
import { Sandbox } from "prokube";

// API key is picked up from PROKUBE_API_KEY env var
const sbx = await Sandbox.fromPool("python-pool");
const result = await sbx.runCode("print('Hello from outside the cluster!')");
console.log(result.stdout);
await sbx.kill();
```

Or pass the API key explicitly:

```typescript
const sbx = await Sandbox.fromPool("python-pool", {
  apiUrl: "https://prokube.ai/pkui",
  workspace: "my-workspace",
  apiKey: "your-api-key",
});
```

When using an API key, the SDK automatically routes requests to the external
API endpoints.

## API Reference

### Sandbox

The main class for interacting with sandboxes.

```typescript
class Sandbox {
  name: string;       // Sandbox name
  workspace: string;  // Workspace (Kubernetes namespace)
  status: SandboxStatus; // Pending, Running, Paused, Bound, Succeeded, Failed, Unknown

  static fromPool(pool: string, options?: SandboxOptions): Promise<Sandbox>;
  static create(image: string, options?: SandboxOptions & { name?: string }): Promise<Sandbox>;
  static get(name: string, options?: ConfigOptions): Promise<Sandbox>;
  static connect: typeof Sandbox.get;  // Alias
  static list(options?: ConfigOptions & { phase?: SandboxStatus }): Promise<Sandbox[]>;

  runCode(code: string, language?: string, timeout?: number): Promise<CodeResult>;
  resetSession(): void;

  pause(): Promise<void>;
  resume(): Promise<void>;
  waitUntilReady(timeout?: number): Promise<void>;
  kill(): Promise<void>;

  commands: CommandRunner;
  files: FileManager;
  sessionId: string | undefined;
}
```

### CommandRunner

```typescript
class CommandRunner {
  run(command: string, timeout?: number): Promise<CommandResult>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// Helper
commandSuccess(result: CommandResult): boolean;
```

### FileManager

```typescript
class FileManager {
  write(path: string, content: string | Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  list(path?: string): Promise<FileInfo[]>;
}
```

### CodeResult

```typescript
interface CodeResult {
  stdout: string;
  stderr: string;
  success: boolean;
  executionTimeMs: number;
  errorName?: string;      // Set on failure
  errorValue?: string;     // Set on failure
  traceback?: string[];    // Set on failure
  sessionId?: string;      // For stateful execution
}
```

### Errors

```
ProKubeError (base)
├── AuthenticationError
├── NotFoundError
├── SandboxError
│   ├── SandboxNotFoundError
│   ├── SandboxTimeoutError
│   ├── SandboxExecutionError
│   ├── PoolNotFoundError
│   └── PoolExhaustedError
```

## Development

```bash
# Clone the repository
git clone https://github.com/prokube/prokube-sdk-ts.git
cd prokube-sdk-ts

# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Build
npm run build
```

## Requirements

- Node.js >= 20.19.0 (uses native `fetch`)
- TypeScript >= 5.7

## License

MIT
