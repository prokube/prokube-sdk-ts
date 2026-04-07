# Warm Pool User Guide

This guide walks through the typical workflow for using prokube.ai sandboxes with warm pools — from setup to pause/resume.

## Prerequisites

- A prokube.ai cluster with sandbox support enabled
- An API key (create one in the UI under **Settings → API Keys**)
- Node.js >= 20.19

### Project Setup

```bash
mkdir my-sandbox-project && cd my-sandbox-project
npm init -y
npm pkg set type=module
npm install prokube
```

### Environment Variables

```bash
export PROKUBE_API_URL=https://your-cluster.prokube.cloud/pkui
export PROKUBE_WORKSPACE=your-namespace
export PROKUBE_API_KEY=pk_live_...
```

### Running Examples

Save any code block from this guide as a `.ts` file and run it with:

```bash
npx tsx my-script.ts
```

## 1. Create a Warm Pool

Warm pools keep pre-warmed sandboxes ready so you can claim one instantly instead of waiting for a cold start (~15-20s).

You can create a pool in the prokube.ai UI, or via the SDK:

```typescript
import { SandboxPool } from "prokube";

const pool = await SandboxPool.create({
  name: "my-pool",
  image: "europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/pk-sandbox-base:v06-04-2026",
  poolSize: 3,
  resources: { cpu: "2", memory: "4Gi" },
});

// Pools need a minute to warm up (image pull + container start)
while (pool.readyReplicas < 1) {
  await new Promise((r) => setTimeout(r, 2000));
  await pool.refresh();
}

console.log(`Pool ready: ${pool.readyReplicas}/${pool.replicas}`);
```

You only need to do this once. The pool stays running and automatically replenishes when sandboxes are claimed.

## 2. Claim a Sandbox

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("my-pool");
// Ready to use — typically takes ~1s
```

## 3. Run Code

The sandbox runs a stateful Jupyter kernel. Variables, imports, and functions persist across calls:

```typescript
await sbx.runCode("x = 42");
const result = await sbx.runCode("print(x * 2)");
console.log(result.stdout);         // "84\n"
console.log(result.success);        // true
console.log(result.executionTimeMs); // e.g. 45
```

Multiline code works as expected:

```typescript
const result = await sbx.runCode(`
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print(fibonacci(10))
`);
console.log(result.stdout); // "55\n"
```

### Reset Kernel State

To clear all variables and start fresh without creating a new sandbox:

```typescript
sbx.resetSession();
```

## 4. Run Shell Commands

Run any shell command inside the sandbox:

```typescript
const result = await sbx.commands.run("echo hello && ls /workspace");
console.log(result.stdout);
console.log(result.exitCode); // 0 = success

// Python one-liners
const py = await sbx.commands.run("python3 -c 'print(2 + 2)'");
console.log(py.stdout); // "4\n"

// Check for failure
const fail = await sbx.commands.run("false");
console.log(fail.exitCode); // 1
```

> **Note:** Sandboxes have no internet access by default. To install packages
> with `pip install`, enable internet access when creating the pool in the UI.
> Pre-installed packages (Python 3.12, Node.js 22, git, curl, jq) are always
> available.

## 5. Work with Files

```typescript
// Write a file and read it back via the SDK
await sbx.files.write("/workspace/hello.txt", "hello world");
const content = await sbx.files.read("/workspace/hello.txt");
console.log(new TextDecoder().decode(content)); // "hello world"

// List files
const files = await sbx.files.list("/workspace");
for (const f of files) {
  console.log(`${f.name} (${f.size} bytes)`);
}

// To create files that code can read, use commands.run or runCode:
await sbx.commands.run("echo 'name,score' > /workspace/data.csv");
await sbx.commands.run("echo 'Alice,95' >> /workspace/data.csv");
await sbx.commands.run("echo 'Bob,87' >> /workspace/data.csv");

await sbx.runCode(`
with open('/workspace/data.csv') as f:
    for line in f:
        print(line.strip())
`);
```

> **Note:** Files written via `files.write()` can be read back with `files.read()`,
> but they are stored in an internal format. If you need to read a file from within
> `runCode()` or shell commands, create it via `commands.run()` or `runCode()` instead.

## 6. Pause & Resume

Pause frees compute resources while preserving your workspace in S3. Resume brings the sandbox back with all files intact.

```typescript
// Save some work
await sbx.files.write("/workspace/checkpoint.pkl", modelData);

// Pause — workspace is flushed to S3, pod is terminated
await sbx.pause();
// No compute costs while paused

// Later: resume
await sbx.resume();
await sbx.waitUntilReady();

// Files are restored from S3
const checkpoint = await sbx.files.read("/workspace/checkpoint.pkl");
```

**What survives pause/resume:**
- All files in `/workspace`, `/root`, and `/home/agent`

**What does not survive:**
- Running processes and kernel state (variables, imports)
- System packages installed with `apt` (use `/home/agent/.sandbox-restore.sh` to auto-reinstall)
- Temporary files outside the persisted paths

## 7. Clean Up

```typescript
// Kill the sandbox when done
await sbx.kill();
```

Or use automatic cleanup:

```typescript
{
  await using sbx = await Sandbox.fromPool("my-pool");
  await sbx.runCode("print('hello')");
} // automatically killed
```

## 8. Manage Pools

```typescript
import { SandboxPool } from "prokube";

// List pools
const pools = await SandboxPool.list();
for (const p of pools) {
  console.log(`${p.name}: ${p.readyReplicas}/${p.replicas} ready`);
}

// Get pool details
const pool = await SandboxPool.get("my-pool");
console.log(pool.image);

// Delete a pool
await pool.delete();
```

## Full Example

Putting it all together — a script that claims a sandbox, uploads data, processes it, pauses, resumes, and verifies persistence:

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("my-pool");

try {
  // Create data via code
  await sbx.runCode(`
with open('/workspace/data.csv', 'w') as f:
    f.write('name,score\\nAlice,95\\nBob,87\\nCharlie,92')
  `);

  // Process it
  const result = await sbx.runCode(`
data = []
with open('/workspace/data.csv') as f:
    headers = f.readline().strip().split(',')
    for line in f:
        values = line.strip().split(',')
        data.append(dict(zip(headers, values)))

avg = sum(int(r['score']) for r in data) / len(data)
print(f"Average score: {avg:.1f}")
print(f"Students: {len(data)}")
  `);

  console.log(result.stdout);
  // "Average score: 91.3"
  // "Students: 3"

  // Pause to save costs
  await sbx.pause();
  console.log("Paused — no compute costs");

  // Resume later
  await sbx.resume();
  await sbx.waitUntilReady();
  console.log("Resumed");

  // Verify data survived
  const check = await sbx.commands.run("cat /workspace/data.csv");
  console.log(check.stdout);

} finally {
  await sbx.kill();
}
```
