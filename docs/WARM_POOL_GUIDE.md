# Warm Pool User Guide

This guide walks through the typical workflow for using prokube.ai sandboxes with warm pools — from setup to pause/resume.

## Prerequisites

- A prokube.ai cluster with sandbox support enabled
- An API key (create one in the UI under **Settings → API Keys**)

```bash
export PROKUBE_API_URL=https://your-cluster.prokube.cloud/pkui
export PROKUBE_WORKSPACE=your-namespace
export PROKUBE_API_KEY=pk_live_...
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
await sbx.runCode("import pandas as pd");
await sbx.runCode("df = pd.DataFrame({'x': [1, 2, 3], 'y': [4, 5, 6]})");

const result = await sbx.runCode("print(df.describe())");
console.log(result.stdout);
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

```typescript
// Install packages
await sbx.commands.run("pip install scikit-learn");

// Run scripts
const result = await sbx.commands.run("python3 train.py --epochs 10");
console.log(result.stdout);
console.log(result.exitCode); // 0 = success
```

## 5. Work with Files

```typescript
// Upload data
await sbx.files.write("/workspace/data.csv", "name,score\nAlice,95\nBob,87");

// Process it with code
await sbx.runCode(`
import pandas as pd
df = pd.read_csv('/workspace/data.csv')
df.to_json('/workspace/results.json', orient='records')
`);

// Download results
const output = await sbx.files.read("/workspace/results.json");
console.log(new TextDecoder().decode(output));

// List files
const files = await sbx.files.list("/workspace");
for (const f of files) {
  console.log(`${f.name} — ${f.size} bytes`);
}
```

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

Putting it all together — a script that claims a sandbox, processes data, and cleans up:

```typescript
import { Sandbox } from "prokube";

const sbx = await Sandbox.fromPool("my-pool");

try {
  // Upload dataset
  await sbx.files.write("/workspace/input.csv", csvData);

  // Install dependencies and run analysis
  await sbx.commands.run("pip install scikit-learn");
  
  const result = await sbx.runCode(`
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

df = pd.read_csv('/workspace/input.csv')
X, y = df.drop('target', axis=1), df['target']

model = RandomForestClassifier(n_estimators=100)
model.fit(X, y)
print(f"Accuracy: {model.score(X, y):.2%}")
  `);
  
  console.log(result.stdout); // "Accuracy: 97.33%"

  // Pause to save costs, resume later
  await sbx.pause();
  
  // ... hours later ...
  
  await sbx.resume();
  await sbx.waitUntilReady();
  
  // Data is still there
  const files = await sbx.files.list("/workspace");
  console.log(files.map(f => f.name)); // ["input.csv"]

} finally {
  await sbx.kill();
}
```
