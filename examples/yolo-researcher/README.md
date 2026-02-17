# YOLO-Scholar: Autonomous Systems-Paper Research Agent

YOLO-Scholar is a long-horizon autonomous research agent for systems-paper first drafts, built on AgentFoundry. It executes a non-linear research lifecycle — from problem framing through evaluation to paper drafting — using branch-tree search for decisions and a shared evidence graph for facts.

> Design specification: [`docs/002-yolo-mode.md`](docs/002-yolo-mode.md) (RFC-002, v1.13)

## Quick Start

### Run Tests

```bash
# From project root
npm run test:run -- tests/yolo-researcher/

# Single test file
npm run test:run -- tests/yolo-researcher/planner-llm.test.ts
```

### Run Desktop App

```bash
# From project root
npm run example:yolo-researcher:desktop:install
npm run example:yolo-researcher:desktop:dev

# Or from the desktop directory
cd examples/yolo-researcher/desktop
npm install
npm run dev
```

### Programmatic Usage

```typescript
import { createYoloSession } from './examples/yolo-researcher/index.js'

const session = createYoloSession({
  projectPath: '/path/to/project',
  goal: 'Investigate whether B-tree fanout affects SSD write amplification',
  options: {
    budget: { maxTurns: 20, maxTokens: 200_000, maxCostUsd: 50 },
    models: { planner: 'gpt-4o-mini', coordinator: 'gpt-4o' }
  }
})

await session.init()

// Run turns until completion, pause, or budget exhaustion
while (true) {
  const result = await session.runNextTurn()
  if (!result) break

  console.log(`Turn ${result.turnReport.turnNumber}: ${result.turnReport.summary}`)

  const snapshot = await session.getSnapshot()
  if (['COMPLETE', 'FAILED', 'STOPPED', 'PAUSED', 'WAITING_FOR_USER'].includes(snapshot.state)) {
    break
  }
}
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Desktop UI (Electron)              │
│  Mission Control · Turn Timeline · Evidence Map      │
│  Branch Explorer · Checkpoint Dialog · Diagnostics   │
└────────────────────────┬─────────────────────────────┘
                         │ IPC (50+ methods, 4 push events)
┌────────────────────────┴─────────────────────────────┐
│                    Agent Layer                        │
│  YoloPlanner ──→ YoloCoordinator ──→ YoloReviewer   │
│  (TurnSpec)      (turn execution)    (P3 semantic)   │
└────────────────────────┬─────────────────────────────┘
                         │
┌────────────────────────┴─────────────────────────────┐
│                   Runtime Core                        │
│  YoloSession (orchestrator + state machine)           │
│  ├─ AssetStore      (append-only evidence ledger)     │
│  ├─ BranchManager   (branch-tree search control)     │
│  ├─ GateEngine      (structural + semantic gates)     │
│  ├─ CheckpointBroker(ask-user + pause/resume)         │
│  └─ UserIngressManager (file upload intake, P1+)      │
└──────────────────────────────────────────────────────┘
```

### Three Layers

**Runtime Core** (`runtime/`) — Pure TypeScript state machine with filesystem persistence. No UI or LLM dependencies. Handles turns, assets, gates, review, branches, crash recovery, and event logging.

**Agent Layer** (`agents/`) — AgentFoundry wiring. Each agent is created via `createAgent()` with appropriate packs and constraints. The planner generates TurnSpecs, the coordinator executes turns, and the reviewer provides semantic review in P3.

**Desktop UI** (`desktop/`) — Electron + React 19 + TailwindCSS 4. Structured supervision interface (not a chat UI). Modal checkpoint cards for research decisions, live budget tracking, and evidence map visualization.

## Project Structure

```
examples/yolo-researcher/
├── index.ts                    # Public API exports
├── agents/
│   ├── yolo-session.ts         # Session factory (createYoloSession)
│   ├── coordinator.ts          # Turn executor (createYoloCoordinator)
│   ├── planner.ts              # LLM turn planner (createYoloPlanner)
│   └── reviewer.ts             # Semantic reviewer (createYoloReviewEngine)
├── runtime/
│   ├── session.ts              # YoloSession orchestrator & state machine
│   ├── types.ts                # Type definitions (TurnSpec, PlannerInput, etc.)
│   ├── planner.ts              # Planner utilities + fallback spec builder
│   ├── gate-engine.ts          # StubGateEngine (P0) & StructuralGateEngine (P1+)
│   ├── review-engine.ts        # DisabledReviewEngine + reviewer utilities
│   ├── asset-store.ts          # FileAssetStore (append-only JSON)
│   ├── branch-manager.ts       # DegenerateBranchManager (P0) / full (P1+)
│   ├── checkpoint-broker.ts    # Ask-user + checkpoint coordination
│   ├── coordinator.ts          # ScriptedCoordinator (testing utility)
│   ├── user-ingress-manager.ts # File upload intake & curation (P1+)
│   ├── export-artifacts.ts     # Claim-evidence table & final bundle export
│   └── utils.ts                # File I/O, hashing utilities
├── docs/
│   └── 002-yolo-mode.md        # RFC-002 design specification
├── skills/
│   ├── *.ts                    # Built-in procedural skills (literature/data/writing/experiment)
│   └── default-project-skills/ # External SKILL.md packs (e.g., coding-large-repo, cloudlab-distributed-experiments, matplotlib)
└── desktop/                    # Electron desktop app
    ├── package.json            # React 19, Lucide, TailwindCSS 4, Electron 33
    ├── electron.vite.config.ts # Build configuration
    └── src/
        ├── main/
        │   ├── index.ts        # Electron window & menu setup
        │   └── ipc.ts          # 40+ IPC handlers
        ├── preload/
        │   └── index.ts        # Context bridge (ElectronAPI)
        └── renderer/
            ├── App.tsx         # Main React component
            ├── main.tsx        # React entry point
            └── global.css      # TailwindCSS + theme
```

## Core Concepts

### Research Stages (S1–S5)

Research progresses through five stages, but not strictly linearly — branches can revisit earlier stages when evidence falsifies assumptions.

| Stage | Focus | Key Assets |
|-------|-------|------------|
| S1 | Problem Framing | Hypothesis, RiskRegister, BaselineLandscape |
| S2 | Bottleneck Evidence | Claim, EvidenceLink, ExperimentRequirement |
| S3 | Design & Prototype | RunRecord, mechanism design, microbench |
| S4 | Evaluation & Analysis | end-to-end comparisons, ablation, parity |
| S5 | Paper Drafting | DraftSection, claim-evidence table, threats |

### Runtime State Machine

```
IDLE → PLANNING → EXECUTING → TURN_COMPLETE
                                  │
                    ┌─────────────┼─────────────────┐
                    ↓             ↓                 ↓
            WAITING_FOR_USER  WAITING_EXTERNAL   auto-continue
                    │             │                 │
                    └─────────────┴────→ PLANNING ──┘
                                            │
                        PAUSED ←──── any state
                          │
                        resume → EXECUTING
                                            │
                    COMPLETE / FAILED / STOPPED / CRASHED
```

11 states total: `IDLE`, `PLANNING`, `EXECUTING`, `TURN_COMPLETE`, `WAITING_FOR_USER`, `WAITING_EXTERNAL` (P1+), `PAUSED`, `COMPLETE`, `FAILED`, `STOPPED`, `CRASHED`.

### Turn Transaction Model

Each turn is one bounded `TurnSpec` execution:

```typescript
interface TurnSpec {
  turnNumber: number
  stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  branch: {
    activeBranchId: string
    activeNodeId: string
    action: 'advance' | 'fork' | 'revisit' | 'merge' | 'prune'
  }
  objective: string
  expectedAssets: string[]
  constraints: {
    maxToolCalls: number       // hard-enforced P0+
    maxReadBytes: number       // hard-enforced P0+
    maxDiscoveryOps: number    // advisory P0, enforced P1+
    maxWallClockSec: number
    maxStepCount: number
    maxNewAssets: number
    maxPromptTokens: number
    maxCompletionTokens: number
    maxTurnTokens: number
    maxTurnCostUsd: number
  }
}
```

Turn lifecycle: **Planner** generates TurnSpec → **Coordinator** executes turn → **Gate** evaluates asset snapshot → **Reviewer** runs semantic review (P3) → **Session** commits turn report + assets atomically.

### Evidence Asset Model

Assets are append-only with `supersedes` chains for auditability.

**Asset ID format**: `<Type>-t<turnNumber>-a<attempt>-<seq>` (e.g., `Claim-t003-a1-001`)

**Core asset types** (P0/P1):

| Type | Purpose |
|------|---------|
| Hypothesis | Research hypothesis with falsifier |
| Claim | Testable claim (primary/secondary/exploratory) with state machine |
| EvidenceLink | Typed edge (supports/falsifies/context) with counting policy |
| RunRecord | Experiment result with reproducibility triple reference |
| RiskRegister | Tracked risks with next actions |
| Decision | Checkpoint confirmation (problem-freeze, claim-freeze, etc.) |
| DraftSection | Paper section draft |
| ReviewerNote | Reviewer feedback per persona |
| ExperimentRequirement | Outsourced experiment spec (why/objective/method/expectedResult) |

**Claim state machine**: `proposed` → `asserted` (requires Decision asset) → `supported` | `refuted` | `dropped`

### Gate System

**Structural gates** (P1+): Deterministic checks on a `SnapshotManifest` — the closure of all reachable assets from the current branch node. Gates check coverage, parity, reproducibility, and causality obligations.

**Semantic review** (P3): Three independent reviewer passes per stage using anchored hard-blocker taxonomy:
- `claim_without_direct_evidence`
- `causality_gap`
- `parity_violation_unresolved`
- `reproducibility_gap`
- `overclaim`

Consensus rule: if >=2/3 reviewer passes flag the same blocker with citations, the runtime pauses for user confirmation.

### Branch Tree

Non-linear search control using a branch tree, while evidence remains shared globally.

| Operation | Description |
|-----------|-------------|
| `advance` | Continue current node |
| `fork` | Create child branch for alternative approach |
| `revisit` | Jump to ancestor node, reopen obligations |
| `merge` | Merge branch conclusions with conflict notes |
| `prune` | Archive low-value branch with rationale |

## Persistence Layout

All data stored under `<projectPath>/yolo/<sessionId>/`:

```
yolo/<sessionId>/
├── session.json                    # Runtime state snapshot
├── events.jsonl                    # Append-only event log (14 event types)
├── plan.md                         # Mutable research plan (SYSTEM_STATE + AGENT_NOTES zones)
├── plan-state.json                 # Machine-readable plan projection
├── assets/
│   ├── Hypothesis-t001-a1-001.json
│   ├── Claim-t001-a1-001.json
│   └── .staging/                   # Uncommitted assets (cleaned on crash)
├── turns/
│   ├── 1.report.json               # Turn transaction record
│   └── .staging/                   # Uncommitted turn reports
├── branches/
│   ├── tree.json                   # Branch tree index
│   └── nodes/                      # Branch node snapshots
├── branch-dossiers/
│   └── B-001.md                    # Per-branch working notes
├── wait-tasks/                     # External wait tickets (P1+)
│   └── history/                    # Wait-task state snapshots
├── runtime/                        # (P2+)
│   ├── lease.json                  # Owner + heartbeat
│   └── checkpoints/                # Durable state snapshots
└── exports/                        # Generated exports
    ├── session-summary-*.json
    ├── claim-evidence-table-*.json
    ├── asset-inventory-*.json
    └── final-bundle-*.manifest.json
```

**Turn commit protocol**: Assets and turn reports write to `.staging/` first, then rename to final paths atomically. Only turns with a `turn_committed` event in `events.jsonl` are considered durable. On crash recovery, staging directories are cleaned and the session resumes from the last committed turn.

## Desktop App

The desktop UI is a structured research supervision interface — **not a chat interface**. The user acts as a "committee chair" who reviews progress, makes decisions at checkpoints, and intervenes when the agent is stuck.

### Views

| View | Description |
|------|-------------|
| Mission Control | Stage progress, runtime state, current turn, budget summary |
| Turn Timeline | Vertical audit trail of turn reports with filters |
| Checkpoint Dialog | Modal cards for freeze decisions, side-panel for questions |
| Branch Explorer | Interactive branch tree visualization |
| Evidence Map | Asset inventory + claim-evidence matrix |
| Diagnostics | Per-turn tool call sequence, token usage (DevTools-style) |

### IPC Contract

Session lifecycle:
- `yolo:start(goal, options)` / `yolo:pause()` / `yolo:resume()` / `yolo:stop()`

Data access:
- `yolo:get-snapshot()` / `yolo:get-turn-reports()` / `yolo:get-events()` / `yolo:get-assets()`

User interaction:
- `yolo:enqueue-input(text, priority)` / `yolo:get-input-queue()` / queue management

External wait (P1+):
- `yolo:wait-external(...)` / `yolo:list-wait-tasks()` / `yolo:resolve-wait-task(...)`
- `yolo:request-fulltext-wait(...)` / `yolo:add-ingress-files(...)`

Exports:
- `yolo:export-summary()` / `yolo:export-claim-evidence-table()` / `yolo:export-asset-inventory()` / `yolo:export-final-bundle()`

Push events: `yolo:state`, `yolo:turn-report`, `yolo:question`, `yolo:event`

## API Reference

### Session Factory

```typescript
import { createYoloSession, type CreateYoloSessionConfig } from './index.js'

const session = createYoloSession({
  projectPath: string,          // Project root directory
  goal: string,                 // Research goal
  options: {
    budget: {
      maxTurns: number,
      maxTokens: number,
      maxCostUsd: number,
      deadlineIso?: string
    },
    models: {
      planner: string,          // Model for TurnSpec generation
      coordinator: string,      // Model for turn execution
      reviewer?: string         // Model for semantic review (P3)
    }
  },
  sessionId?: string,           // Custom session ID (default: random UUID)
  coordinator?: YoloCoordinator,  // Custom coordinator instance
  planner?: TurnPlanner,        // Custom planner instance
  reviewEngine?: ReviewEngine,  // Custom review engine
  coordinatorConfig?: { ... },  // Agent config overrides
  plannerConfig?: { ... },      // Agent config overrides (enables LLM planner)
  reviewerConfig?: { ... }      // Agent config overrides
})
```

### Turn Planner

```typescript
import { createYoloPlanner, type YoloPlannerConfig } from './index.js'

const planner = createYoloPlanner({
  projectPath: string,
  model: string,                // Recommended: fast/cheap model
  apiKey?: string,
  maxSteps?: number,            // Default: 6
  debug?: boolean,
  createAgentInstance?: () => AgentLike  // Test injection
})

const output = await planner.generate(plannerInput)
// output.turnSpec: TurnSpec
// output.suggestedPrompt: string
// output.rationale: string
// output.uncertaintyNote: string
```

### Coordinator

```typescript
import { createYoloCoordinator, type YoloCoordinatorConfig } from './index.js'

const coordinator = createYoloCoordinator({
  projectPath: string,
  model: string,
  apiKey?: string,
  maxSteps?: number,            // Default: 30
  allowBash?: boolean,          // Enable exec pack
  debug?: boolean,
  createAgentInstance?: (...) => AgentLike  // Test injection
})

const result = await coordinator.runTurn({
  turnSpec, stage, goal, mergedUserInputs
})
// result.summary: string
// result.assets: NewAssetInput[]
// result.metrics: CoordinatorTurnMetrics
// result.askUser?: AskUserRequest
```

### Review Engine

```typescript
import { createYoloReviewEngine, type YoloReviewerConfig } from './index.js'

const engine = createYoloReviewEngine({
  projectPath: string,
  model: string,                // Empty string → DisabledReviewEngine
  apiKey?: string,
  maxSteps?: number,            // Default: 8
  createAgentInstance?: (...) => AgentLike  // Test injection
})

const review = await engine.evaluate({
  stage, manifest, gateResult   // Only runs at S5 (Final Synthesis)
})
// review.enabled: boolean
// review.reviewerPasses: ReviewerPass[]
// review.consensusBlockers: ConsensusBlocker[]
```

## Testing

The test suite covers key contracts:

```
tests/yolo-researcher/
├── p0-runtime-skeleton.test.ts     # Session lifecycle, turn commit, events
├── p0-conformance.test.ts          # RFC §19 conformance (24 tests)
├── p2-runtime-robustness.test.ts   # Crash recovery, lease, checkpoints
├── p3-semantic-review.test.ts      # Consensus blockers, reviewer personas
├── p3-coverage-closure.test.ts     # Claim-evidence coverage thresholds
├── coordinator.test.ts             # JSON parsing, asset normalization
├── planner-llm.test.ts             # LLM planner parsing, fallback, prompts
├── planner-replay-determinism.test.ts  # Replay determinism via snapshot hashes
├── reviewer-engine.test.ts         # Reviewer engine with injected agents
├── gate-engine-structural.test.ts  # Structural gate checks (coverage, parity, etc.)
├── gate-replay-from-turn-report.test.ts  # Gate replay from stored manifests
├── branch-manager-p1.test.ts       # Full branch operations (fork/revisit/merge/prune)
├── experiment-outsourcing.test.ts  # ExperimentRequirement + WAITING_EXTERNAL flow
├── export-artifacts.test.ts        # Claim-evidence table + final bundle export
├── checkpoint-broker.test.ts       # Ask-user coordination
└── user-ingress-manager.test.ts    # File upload intake
```

All agents accept `createAgentInstance` for dependency injection — no real LLM calls in tests.

```bash
# Run all yolo-researcher tests
npm run test:run -- tests/yolo-researcher/

# Run with coverage
npm run test:coverage -- tests/yolo-researcher/
```

## Design Principles

1. **Append-only assets** — No in-place overwrites. Updates produce new IDs with `supersedes` pointers. Full provenance chain is always available.

2. **Deterministic gates** — Gate evaluation reads only a `SnapshotManifest` (the closure of reachable assets), never the filesystem directly. Gates are replayable from stored manifests.

3. **Crash-safe turns** — Turn commit protocol uses staging directories + atomic renames. Only turns with a `turn_committed` event are durable. Ghost assets are impossible after recovery.

4. **LLM-led direction, not score-led** — No weighted aggregate scores for route selection. Research direction is chosen by LLM deliberation and reviewer critique. Coverage metrics are structural obligations, not quality scores.

5. **Budget-first execution** — Every turn is bounded by `TurnConstraints`. Session-level budget (turns, tokens, cost) is tracked and enforced. Planner degrades scope before hard stop.

6. **Structured supervision** — The user is a research supervisor, not an operator. Interaction happens at defined checkpoints via structured modal cards, not chat bubbles.

## Independence Rule

YOLO-Scholar is an independent example app. It reuses AgentFoundry platform capabilities (`createAgent`, packs, tool runtime, policy engine) but does **not** import from `examples/research-pilot/*` or other example apps.
