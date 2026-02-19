# YOLO-Researcher v2 (Thin Native Protocol)

This implementation is v2-native only: one loop API (`runTurn`) and direct tool/skill/subagent execution inside the agent runtime.

Design axiom:
- Minimal discipline to avoid failure loops.
- Evidence-driven strengthening over time.

## What Is Implemented

- Single-agent native loop: `Load -> runTurn -> Flush`.
- Minimal persistence:
  - `PROJECT.md`
  - `FAILURES.md`
  - `runs/turn-xxxx/*`
- Native tool event capture:
  - `runs/turn-xxxx/artifacts/tool-events.jsonl`
- Synthesized terminal snapshots from last bash tool call:
  - `cmd.txt`, `stdout.txt`, `stderr.txt`, `exit_code.txt`
- Unified turn result contract:
  - `runs/turn-xxxx/result.json`
  - includes `exit_code/runtime/cmd/cwd/duration_sec/timestamp`
- Deterministic failure learning:
  - repeated fingerprint -> `WARN` / `BLOCKED`
  - fingerprint window = last 10 turns
  - successful verification writes `[UNBLOCKED]` record

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
  goal: 'Capture one reproducible baseline probe',
  defaultRuntime: 'host',
  agent: new ScriptedSingleAgent([
    {
      intent: 'Run one reproducible probe command',
      status: 'success',
      summary: 'Captured baseline output.',
      primaryAction: 'bash: node -v',
      toolEvents: [
        {
          timestamp: new Date().toISOString(),
          phase: 'call',
          tool: 'bash',
          input: { command: 'node -v' }
        },
        {
          timestamp: new Date().toISOString(),
          phase: 'result',
          tool: 'bash',
          success: true,
          result: {
            success: true,
            data: { stdout: 'v20.x\n', stderr: '', exitCode: 0 }
          }
        }
      ],
      projectUpdate: {
        currentPlan: [
          'Capture one environment constraint with evidence',
          'Run a second minimal verification command',
          'Summarize confirmed baseline behavior'
        ]
      }
    },
    {
      intent: 'Stop after first milestone',
      status: 'stopped',
      summary: 'Milestone reached.',
      stopReason: 'Baseline captured.'
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
  model: 'gpt-5.2',
  apiKey: process.env.OPENAI_API_KEY,
  enableNetwork: true,
  capabilityProfile: 'full',
  autoApprove: true
})

const session = createYoloSession({
  projectPath: '/path/to/repo',
  goal: 'Investigate bottlenecks and produce reproducible evidence-backed improvements',
  agent,
  defaultRuntime: 'host'
})

await session.init()
await session.runUntilStop(12)
```

## Runtime Layout

```text
PROJECT.md
FAILURES.md
runs/
  turn-0001/
    action.md
    cmd.txt
    stdout.txt
    stderr.txt
    exit_code.txt
    result.json
    artifacts/
      tool-events.jsonl
      ...
  turn-0002/
```

## UI Scope

Desktop UI is not in the v2 correctness path. Runtime correctness depends on the file contracts above.

Known gap: runtime selector (`host|docker|venv`) is currently metadata/prompt labeling, not executor routing. See `docs/010-runtime-selection-execution-gap.md`.
