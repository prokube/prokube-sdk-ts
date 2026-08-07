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
# Replace v0.2.0 with the desired release tag
bun add https://github.com/prokube/prokube-sdk-ts/releases/download/v0.2.0/prokube-v0.2.0.tgz
```

Each GitHub release publishes a packed `.tgz` built from the SDK's `dist/`
output, so consumers do not need to run `prepare` or rebuild inside Docker.

### Versioning

Starting with `0.2.0` this SDK uses semantic versioning, aligned with the
Python SDK (`prokube-sdk`) release line. Earlier releases used date-based
versions such as `2026.7.5` with release tags like `v2026-07-05`. Release tags
are now `v` + the `package.json` version (for example `v0.2.0`), and release
assets are named accordingly (`prokube-v0.2.0.tgz`).

`0.2.0` requires a pk-sandbox backend of **0.8.0 or newer**. The SDK checks the
backend version on first use and emits a `console.warn` when the backend is
older than the minimum; the check is skipped for API-key (external) access
because external endpoints do not expose `/api/version`.

To validate the release package path locally, run:

```bash
npm run smoke:release
```

## Quick Start

```typescript
import { Sandbox } from "prokube";

// Claim a sandbox from a warm pool (fast, but adoption is asynchronous)
const sbx = await Sandbox.fromPool("python-pool");
await sbx.waitUntilReady();

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
await sbx.files.writeBatch([
  { path: "/workspace/app.ts", content: "console.log('hello')" },
  { path: "/workspace/data.bin", content: new Uint8Array([0, 1]) },
]);
const content = await sbx.files.read("/workspace/output.txt");
const files = await sbx.files.list("/workspace");

// Pause / resume: both are asynchronous on the backend.
await sbx.pause(); // blocks until the sandbox reports Paused
await sbx.resume(); // returns immediately, phase is Resuming
await sbx.waitUntilReady(); // block until the new pod is Running

// Cleanup. Deletion (including the persistence purge that releases the name)
// is asynchronous; pass { wait: true } when you need guaranteed reclamation.
await sbx.kill({ wait: true });
```

### Automatic Cleanup

Using TC39 Explicit Resource Management (`await using`):

```typescript
import { Sandbox } from "prokube";

{
  await using sbx = await Sandbox.fromPool("python-pool");
  await sbx.waitUntilReady();
  const result = await sbx.runCode("print(42)");
  console.log(result.stdout);
} // Sandbox is automatically killed
```

Or with a `try/finally` block:

```typescript
const sbx = await Sandbox.fromPool("python-pool");
await sbx.waitUntilReady();
try {
  const result = await sbx.runCode("print(42)");
  console.log(result.stdout);
} finally {
  await sbx.kill();
}
```

`await using` and the `try/finally` block both call `kill()` with its default
(non-blocking) behaviour: the delete request is accepted with HTTP 202 and the
backend finishes tearing the sandbox down — including the persistence purge
that releases the name — in the background. Use `kill({ wait: true })` when you
need the name reclaimed before continuing.

## Configuration

Configuration can be provided via environment variables or explicitly.

### Environment Variables

```bash
export PROKUBE_API_URL=https://prokube.ai/pkui  # Can include path prefix
export PROKUBE_WORKSPACE=my-workspace
export PROKUBE_API_KEY=your-api-key  # Required for external access
export PROKUBE_TIMEOUT=300  # Optional, default 300 seconds
```

**Note:** `PROKUBE_API_KEY` enables external access and routes requests to the
external `/sandbox/{workspace}/...` endpoints. In Kubernetes, if no API key and
no `PROKUBE_API_URL` are configured, the SDK defaults to the in-cluster Agent
Gateway service and routes sandbox requests to `/_platform/sandbox/{workspace}/...`.
Outside Kubernetes, `PROKUBE_API_URL` is still required.

### Explicit Configuration

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("python-pool", {
  apiUrl: "https://prokube.ai/pkui",
  workspace: "my-workspace",
  apiKey: "your-api-key",
});
```

### In-Cluster / Notebook Usage

Inside a Kubernetes notebook or workload, configure only the workspace when you
do not need external API-key access. The SDK detects Kubernetes via
`KUBERNETES_SERVICE_HOST`, uses the in-cluster Agent Gateway service, and sends
no SDK auth headers unless you explicitly provide `PROKUBE_USER_ID`, `KF_USER`,
or `apiKey`.

```bash
export PROKUBE_WORKSPACE=my-workspace
```

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("python-pool");
const result = await sbx.runCode("print('Hello from inside the cluster!')");
console.log(result.stdout);
await sbx.kill();
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
  status: SandboxStatus; // Pending, Running, Paused, Pausing, Resuming,
                         // Deleting, Succeeded, Failed, Unknown

  static fromPool(pool: string, options?: SandboxOptions): Promise<Sandbox>;
  static create(image: string, options?: SandboxOptions & { name?: string }): Promise<Sandbox>;
  static get(name: string, options?: ConfigOptions): Promise<Sandbox>;
  static connect: typeof Sandbox.get;  // Alias
  static list(options?: ConfigOptions & { phase?: SandboxStatus }): Promise<Sandbox[]>;
  static listPage(
    options?: ConfigOptions & { limit?: number; continueToken?: string },
  ): Promise<SandboxPage>;

  runCode(code: string, language?: string, timeout?: number): Promise<CodeResult>;
  resetSession(): void;

  pause(options?: { wait?: boolean; timeout?: number }): Promise<void>;
  resume(): Promise<void>;
  waitUntilReady(timeout?: number): Promise<void>;
  kill(options?: { wait?: boolean; timeout?: number }): Promise<void>;

  commands: CommandRunner;
  files: FileManager;
  sessionId: string | undefined;
}
```

#### Lifecycle

Against a v0.8 backend every lifecycle transition is asynchronous: claim,
create, pause, resume, and delete are accepted with HTTP 202 and the sandbox
moves through an intermediate phase before it settles.

| Call | Returns when | Phase you observe | Follow up with |
| --- | --- | --- | --- |
| `fromPool()` | claim accepted | `Pending` | `waitUntilReady()` |
| `create()` | create accepted | `Pending` | `waitUntilReady()` |
| `pause()` | sandbox reports `Paused` (default `wait: true`) | `Pausing` → `Paused` | — |
| `pause({ wait: false })` | pause accepted | `Pausing` | poll `refresh()` / `status` |
| `resume()` | resume accepted (never blocks) | `Resuming` | `waitUntilReady()` |
| `kill()` | delete accepted (default `wait: false`) | local `status` flips to `Succeeded` at once | — |
| `kill({ wait: true })` | sandbox is gone (HTTP 404) | local `status` flips to `Succeeded` once gone | — |

- `pause(options)` defaults to `{ wait: true, timeout: 300 }` (seconds), so
  existing `await sbx.pause()` call sites keep blocking until `Paused`.
- `kill(options)` defaults to `{ wait: false, timeout: 300 }`. Deletion
  includes an asynchronous persistence purge, and the sandbox name stays
  reserved until that purge finishes — pass `{ wait: true }` when you need to
  reuse the name or reclaim quota immediately.
- `kill()` marks the sandbox dead locally the moment the delete is accepted:
  `status` reads `Succeeded` and every further operation throws, even though
  the backend is still tearing the pod down (its own phase is `Deleting`
  until the record is purged). The local status is the SDK's "this handle is
  finished" flag, not a backend phase reading — the handle's client is closed,
  so it cannot report backend phases any more. Use `Sandbox.get(name)` if you
  need to observe the backend-side teardown.
- `waitUntilReady(timeout)` polls through `Pending` and `Resuming` until the
  phase is `Running`. The timeout is in seconds and defaults to the client
  timeout (`PROKUBE_TIMEOUT` / the `timeout` option, 300 by default). The whole
  poll shares one timeout budget, so a single slow status request cannot exceed
  it. It throws `SandboxError` if the sandbox reaches `Failed` (the message
  carries `lastError`) or `Deleting`, and `SandboxTimeoutError` on timeout.
- `SandboxStatus.Bound` and `SandboxInfo.resumedFromPool` were removed in
  0.2.0 (matching the Python SDK): v0.8 backends never report them.

#### Pagination

`listPage()` returns one bounded, name-ordered page across every sandbox
phase. Idle warm-pool capacity is internal infrastructure and never appears in
the listing. `limit` defaults to `25` and must be between 1 and 100.

```typescript
import { Sandbox } from "prokube";

interface SandboxPage {
  sandboxes: Sandbox[];
  loaded: number;
  hasMore: boolean;
  continueToken?: string;
}

let page = await Sandbox.listPage({ limit: 10 });
for (const sandbox of page.sandboxes) {
  console.log(sandbox.name, sandbox.status);
}

while (page.hasMore) {
  // The continuation token is an opaque keyset cursor: pass it back together
  // with a `limit` (required whenever a token is supplied) for the next page.
  page = await Sandbox.listPage({ limit: 10, continueToken: page.continueToken });
  for (const sandbox of page.sandboxes) {
    console.log(sandbox.name, sandbox.status);
  }
}
```

`Sandbox.list()` is unchanged and still returns every sandbox in one call.

#### Backend compatibility

```typescript
import { MIN_BACKEND_VERSION, getSdkVersion, parseVersion } from "prokube";

console.log(MIN_BACKEND_VERSION); // "0.8.0"
```

Every `Sandbox.*` / `SandboxPool.*` factory checks the backend version once per
client before its first request. A backend older than `MIN_BACKEND_VERSION`
produces a `console.warn`; the check never throws and is skipped entirely for
API-key (external) access, where `/api/version` is not exposed.

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
  writeBatch(items: FileWriteInput[]): Promise<BatchFileWriteResponse>;
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

Execution timeouts are returned as failed results, not successful executions:
`CodeResult.success` is `false`, and command results have a non-zero `exitCode`
so `commandSuccess(result)` returns `false`. Timeout details are included in the
error fields or `stderr` when provided by the backend.

### SandboxInfo

```typescript
interface SandboxInfo {
  name: string;
  workspace: string;
  status: SandboxStatus;
  lastError?: string;        // Backend failure detail, set when status is Failed
  // ...remaining fields unchanged; the pre-0.8 resumedFromPool field was removed
}
```

`lastError` carries the backend's failure detail for a sandbox in phase
`Failed`. `pause()`, `kill({ wait: true })`, and `waitUntilReady()` include it
in the `SandboxError` they throw when a sandbox fails mid-transition, so the
reason surfaces instead of a bare timeout.

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

`Sandbox.fromPool()` rejects with `PoolExhaustedError` when the backend returns
HTTP 429 with `reason` or `error` set to `pool_exhausted`. Treat this as
retryable backpressure: no warm pool capacity is currently available. The error
has `statusCode: 429`, `reason: "pool_exhausted"`, and preserves the optional
`Retry-After` response header as `retryAfter`.

`kill({ wait: true })` rejects with `SandboxError` if the backend lands the
delete in a terminal failure (phase `Failed`, message carries `lastError`), and
with `SandboxTimeoutError` if the sandbox is still present when the timeout
elapses. Once the delete has been admitted the sandbox is locked even if the
wait fails: `runCode()`, `commands`, and `files` reject from then on, while
`kill({ wait: true })` may be re-issued to keep waiting (the backend's DELETE is
idempotent while teardown is in flight). If the initial delete request itself
fails, the sandbox stays usable so you can retry.

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
- pk-sandbox backend >= 0.8.0

## License

MIT
