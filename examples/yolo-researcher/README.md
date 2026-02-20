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

## Orchestration Mode

`createYoloSession` supports:

- `orchestrationMode: 'artifact_gravity_v3_paper'`
- `orchestrationMode: 'auto'`
Runtime auto-bootstraps `NORTHSTAR.md` if missing.
`auto` resolves to the same paper loop.

`artifact_gravity_v3_paper` uses strict paper-loop semantics:

- internal checks must pass (`RealityCheck (Internal)`).
- scoreboard metrics must improve versus previous turn (`Scoreboard` json files).
- external friction quota must be satisfied (`External Friction Policy.require_external_every`).
- changes to `NORTHSTAR.md` alone are never progress.

Environment override:

```bash
export YOLO_ORCHESTRATION_MODE=auto   # or artifact_gravity_v3_paper
```

## UI Scope

Desktop UI is not in the v2 correctness path. Runtime correctness depends on the file contracts above.

## NorthStar Semantic Gate (RFC-017)

`artifact_gravity_v3_paper` now supports a dedicated semantic progress gate:

- result key: `northstar_semantic_gate`
- input schema: `yolo.northstar_semantic_gate.input.v1`
- output schema: `yolo.northstar_semantic_gate.output.v1`
- runtime derives verdict from `dimension_scores` (legacy model `verdict` is non-authoritative)

Modes:
- `off`
- `shadow`
- `enforce_downgrade_only` (veto-only)
- `enforce_balanced` (reserved)

Main rules:
- runtime deterministic checks remain hard authority
- semantic gate can only downgrade in `enforce_downgrade_only`
- low-confidence non-abstain output is coerced to `abstain`
- `must_candidate` actions are promoted to blocking `must` only by deterministic runtime triggers

Environment overrides (desktop startup):

```bash
export YOLO_NORTHSTAR_SEMANTIC_GATE_MODE=enforce_downgrade_only
export YOLO_NORTHSTAR_SEMANTIC_GATE_CONFIDENCE=0.80
export YOLO_NORTHSTAR_SEMANTIC_GATE_MAX_INPUT_CHARS=24000
export YOLO_NORTHSTAR_SEMANTIC_GATE_MODEL=gpt-5.2
export YOLO_NORTHSTAR_SEMANTIC_GATE_REQUIRED_ACTION_BUDGET=1
export YOLO_NORTHSTAR_SEMANTIC_GATE_MUST_ACTION_MAX_OPEN=1
export YOLO_NORTHSTAR_SEMANTIC_GATE_RECENT_WINDOW_TURNS=4
```

## Literature Search Budget (Test vs Full)

To reduce cost/latency during testing, v2 now defaults to a **test** literature budget profile.

Default profile (`test`) when `YOLO_LITERATURE_BUDGET_PROFILE` is not set:
- `literature-study`: `targetPaperCount=12`, `timeoutMs=12000`
- `literature-search` quick: `limit=5`
- `literature-search` sweep:
  - `limitPerQuery=4`
  - `finalLimit=16`
  - `maxSubqueries=2`
  - `citationSeedCount=2`
  - `citationLimit=3`
  - `timeoutMs=120000`

### Switch back after testing

Set full profile before starting the app/runtime:

```bash
export YOLO_LITERATURE_BUDGET_PROFILE=full
```

Full profile restores previous heavier defaults:
- `literature-study`: `targetPaperCount=40`, `timeoutMs=15000`
- `literature-search` quick: `limit=8`
- `literature-search` sweep:
  - `limitPerQuery=8`
  - `finalLimit=40`
  - `maxSubqueries=5`
  - `citationSeedCount=5`
  - `citationLimit=5`
  - `timeoutMs=180000`
