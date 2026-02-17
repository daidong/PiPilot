# YOLO-Researcher v2 (Minimal & Reliable)

This implementation follows `docs/005-v2-minimal-reliable.md` directly.

Design axiom:
- The system does not rely on complex architecture for quality.
- The system relies on minimal discipline to avoid failure loops, plus evidence-driven strengthening.

## What Is Implemented

- Single-agent atomic loop: `Load -> Decide -> Act -> Flush`
- Minimal persistence only:
  - `yolo/<project_id>/PROJECT.md`
  - `yolo/<project_id>/FAILURES.md`
  - `yolo/<project_id>/runs/turn-xxxx/*`
- Raw tool output pass-through for `Exec`:
  - `cmd.txt`, `stdout.txt`, `stderr.txt`, `exit_code.txt`
- Deterministic failure learning:
  - repeated fingerprint -> `WARN` / `BLOCKED`
  - `BLOCKED` interception before execution
- Explicit unblock path:
  - `blockedOverrideReason` for post-remediation minimal verification
  - successful override downgrades `BLOCKED` entry

## Public API

```ts
import {
  createYoloSession,
  ScriptedSingleAgent,
  createLlmSingleAgent
} from './examples/yolo-researcher/index.js'
```

## Quick Start (Scripted)

```ts
import { createYoloSession, ScriptedSingleAgent } from './examples/yolo-researcher/index.js'

const session = createYoloSession({
  projectPath: '/path/to/repo',
  projectId: 'demo-rq1',
  goal: 'Test whether command X succeeds in host runtime',
  defaultRuntime: 'host',
  agent: new ScriptedSingleAgent([
    {
      intent: 'Run one reproducible probe command',
      expectedOutcome: 'Capture full raw output',
      action: { kind: 'Exec', cmd: 'node -v', runtime: 'host' },
      projectUpdate: {
        currentPlan: ['Record verified environment fact', 'Run next minimal probe']
      }
    },
    {
      intent: 'Stop after first probe',
      action: { kind: 'Stop', reason: 'Milestone reached' }
    }
  ])
})

await session.init()
await session.runUntilStop(5)
```

## Quick Start (LLM)

```ts
import { createYoloSession, createLlmSingleAgent } from './examples/yolo-researcher/index.js'

const agent = createLlmSingleAgent({
  projectPath: '/path/to/repo',
  model: 'gpt-5-mini',
  apiKey: process.env.OPENAI_API_KEY,
  enableNetwork: false
})

const session = createYoloSession({
  projectPath: '/path/to/repo',
  projectId: 'rq-lsm-001',
  goal: 'Investigate LSM compaction bottleneck and produce reproducible evidence',
  agent,
  defaultRuntime: 'host'
})

await session.init()
await session.runUntilStop(20)
```

## Runtime Layout

```text
yolo/<project_id>/
├── PROJECT.md
├── FAILURES.md
└── runs/
    ├── turn-0001/
    │   ├── action.md
    │   ├── cmd.txt
    │   ├── stdout.txt
    │   ├── stderr.txt
    │   ├── exit_code.txt
    │   ├── patch.diff
    │   └── artifacts/
    └── turn-0002/
```

## UI Scope

Desktop UI is not in the v2 correctness path. Runtime correctness depends only on file contracts above.
