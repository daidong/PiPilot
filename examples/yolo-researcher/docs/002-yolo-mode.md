# RFC-002: YOLO-Scholar Mode for Systems Papers

**Status**: Draft (Proposed, v1.13)
**Author**: AgentFoundry team
**Date**: 2026-02-14
**Target**: Computer Systems conference first-submission draft

## 1. Purpose

YOLO-Scholar is a long-horizon autonomous mode for systems-paper first drafts.

Target lifecycle:

1. find practical problem,
2. profile and identify bottleneck,
3. propose mechanism,
4. implement prototype,
5. evaluate against strong baselines,
6. validate/falsify claims,
7. generate constrained evidence-backed draft.

Execution model is non-linear by design: branch-tree search for decisions plus shared evidence-graph memory for facts.

## 2. Optimization Objective

Two-level objective:

### 2.1 Structural Reliability (must pass)

Runtime must keep process controllable and auditable:

1. bounded turns (`TurnSpec` constraints),
2. durable wait states (`WAITING_EXTERNAL`),
3. append-only assets + replayable provenance,
4. crash-safe recovery + idempotent run accounting.

### 2.2 Scientific Direction (LLM-led, not score-led)

Research direction is chosen by LLM deliberation and reviewer critique, not by numeric global scores.

Non-goal:

1. no weighted aggregate score for route selection,
2. no reward/backprop objective for branch choice.

## 3. Scope and Delivery Plan

### 3.1 In Scope

1. multi-turn autonomous execution,
2. asset-first claim validation,
3. rollbackable gate workflow,
4. user-interruptible checkpoints.

### 3.2 Out of Scope (v1)

1. guaranteed acceptance-level novelty,
2. full cluster-scale orchestration,
3. zero-context domain invention,
4. concurrent multi-branch execution (single coordinator is P3 bottleneck for multi-baseline evaluation; `BranchManager` interface should allow `activeNodeIds: string[]` in future, v1 asserts `length === 1`),
5. degradation ladder quantitative thresholds (needs empirical tuning; placeholder formula: remaining budget < estimated remaining turns × recent 5-turn cost mean × 1.5 → warning; < 1.0 → degrade),
6. RunRecord statistical anti-cheat fields (warmup duration, outlier policy, noise flag — add when gate checks require them in P2/P3),
7. MergeNote (branch merge conflict details — stored in `BranchNode.mergedFrom` field, not a separate asset type).

### 3.3 Phased Delivery

`P0 Runtime Skeleton`

1. `YoloSession` + runtime state machine (states: IDLE through STOPPED; `WAITING_EXTERNAL` deferred to P1),
2. `BranchManager` interface designed for multi-branch, but P0 implements **degenerate single-branch mode** (`advance` only; `fork/revisit/merge/prune` stubbed with "not implemented in P0" error),
3. `CheckpointBroker` + ask-user / pause / resume / stop interaction,
4. minimal `AssetStore` (filesystem append-only),
5. `StubGateEngine` integrated in control flow (always pass by default, but emits gate evaluation events and supports forced-fail testing),
6. turn transaction bounds (`maxToolCalls` and `maxReadBytes` are **hard-enforced** in P0; `maxDiscoveryOps` is advisory — logged but not enforced; enforced starting P1),
7. turn reports and event log.

P0 scope boundary: the goal is a running loop that can execute turns, produce assets, and pause/resume. Deferred to later phases: multi-branch search (P1), external wait tickets (P1), runtime lease/heartbeat/checkpoint cadence (P2).

`P1 Literature YOLO`

1. stage focus: S1,
2. outputs: hypothesis + baseline landscape + scoped claims.

`P2 Draft YOLO`

1. stage focus: S1 + S5,
2. outputs: full draft + claim-evidence table (without S2-S4 external experiment loop).

`P3 Full YOLO-Scholar`

1. stage focus: S1-S5,
2. includes S2-S4 requirement-first experimentation (emit requirements, ingest externally executed results), tiered evaluation, reproducibility assets,
3. requires Tooling Readiness Gates (Section 21) before enabling S2-S4 external evidence flow.

### 3.4 Current Capability Boundary (Independent YOLO Researcher Example)

YOLO Researcher is an independent example app built on Agent Framework core runtime.

Reuse policy:

1. allowed reuse: Agent Framework platform capabilities (`createAgent`, packs, tool runtime, policy engine, kernel, storage primitives),
2. disallowed reuse: `examples/research-pilot/*` application-layer modules, prompts, and workflow packages. You can refer implementations in examples/research-pilot/* to help you build needed components. Many of the subagent tools (such as literature research and data anlayzer) are already implemented there and very robust.

Current strengths (from framework baseline):

1. code/file operations via safe tools (`read/write/edit/glob/grep`),
2. command execution via `bash` (exec pack),
3. literature/web search and network tool integration,
4. data analysis + plotting tool integration,
5. long-running agent loop and event hooks.

Current limits:

1. no dedicated in-runtime systems-benchmark orchestration abstraction (v1 relies on external execution + artifact upload),
2. no built-in profiler/benchmark adapter layer for Linux-centric tooling in v1,
3. parity/coverage/gate logic is specified but not yet fully implemented as production validators.

## 4. Runtime Architecture

### 4.1 Placement Decision

Adopt application-layer orchestrator:

1. new class: `examples/yolo-researcher/agents/yolo-session.ts`,
2. `createYoloCoordinator(...)` is the single-turn primitive for this app,
3. no framework-wide generic YOLO in `src/` for v1,
4. no dependency on `examples/research-pilot/*` modules.

### 4.2 Core Components

1. `YoloSession`: loop orchestration, branch control, and state transitions,
2. `GateEngine`: gate evaluation over asset snapshots,
3. `AssetStore`: append-only asset ledger (evidence graph substrate),
4. `BranchManager`: branch-tree mutations (`advance/fork/revisit/merge/prune`) and branch snapshots,
5. `ReviewEngine`: reviewer-note generation, blocker detection, and risk-register updates,
6. `CheckpointBroker`: ask-user + queued input handling,
7. `UserIngressManager`: per-turn upload intake, review, curation, and deduplication.

Workspace discovery uses existing agent tools (glob, grep, read, bash). No separate component is needed; YoloSession assembles stage-relevant context from `plan.md` and asset inventory at each turn boundary. The agent performs ad-hoc workspace exploration within turns using its standard toolset.

Phase-to-component mapping:

1. `P0` requires: `YoloSession` + `CheckpointBroker` + minimal `AssetStore` + degenerate `BranchManager` (advance-only),
2. `P1` adds: `GateEngine` (structural gates only) + `UserIngressManager` + `WAITING_EXTERNAL` state + wait-ticket persistence + full `BranchManager` operations (`fork/revisit/merge/prune`) + enforced `maxDiscoveryOps`,
3. `P2` adds: runtime lease/heartbeat + durable checkpoint cadence (Section 23),
4. `P3` adds: full `GateEngine` (structural + semantic) + full `ReviewEngine` (Novelty/System/Evaluation/Writing personas).

`AssetStore` P0 implementation:

1. thin wrapper over filesystem (`assets/*.json`),
2. each asset is one JSON file named `<type>-<id>.json`,
3. `supersedes` pointer stored inside payload,
4. `list(type?)` and `get(id)` read from disk,
5. no heavy indexing subsystem in P0/P1; retrieval relies on fast shell search (`rg/find/ls`) with optional lightweight cache.

### 4.3 Turn-to-Agent Mapping

Each YOLO turn is one yolo-coordinator call:

1. `YoloSession` builds prompt/context,
2. calls `yoloCoordinator.chat(...)`,
3. yolo-coordinator internally runs one `agent.run(...)`,
4. callbacks produce tool/activity stream,
5. session writes assets/events/turn report,
6. gate/branch policy decides continue/revisit/fork/merge/prune/wait-user/wait-external/complete.

### 4.4 Desktop/IPC Integration

Main process hosts one active YOLO session per window.

Session options schema:

```ts
interface YoloSessionOptions {
  budget: { maxTurns: number; maxTokens: number; maxCostUsd: number; deadlineIso?: string }
  models: { planner: string; coordinator: string; reviewer?: string }
  phase: 'P0' | 'P1' | 'P2' | 'P3'
}
```

New IPC methods:

1. `yolo:start(goal, options: YoloSessionOptions)`
2. `yolo:pause({ immediate?: boolean })`
3. `yolo:resume()`
4. `yolo:stop()`
5. `yolo:enqueue-input(text, priority?)`
6. `yolo:get-snapshot()`

Push events:

1. `yolo:state`
2. `yolo:turn-report`
3. `yolo:question`
4. `yolo:event`

### 4.5 Agent Topology (v1 Default)

Use single commander topology in v1:

1. one primary coordinator agent owns global decisions (stage, branch, gate, user interaction),
2. specialized subagents are exposed as tools and produce bounded artifacts,
3. no peer-to-peer multi-commander "agent army" orchestration in v1 runtime.
4. subagent outputs are facts only when emitted as verifiable assets (with source ids/chunk refs/run ids); free-form summaries are `cite_only`.

Independence rule:

1. commander and subagents are defined inside `examples/yolo-researcher/*`,
2. no import from `examples/research-pilot/*` is allowed.

Rationale:

1. simpler accountability for claim/evidence decisions,
2. lower coordination overhead and lower failure surface in long runs.

### 4.6 Persistence Layout

All paths scoped under project-root `yolo/<sid>/` where `<sid>` is the session id.

Path rationale: `yolo/` lives at project root (not under `.research-pilot/`) for user discoverability and git tracking — researchers can inspect, diff, and version-control their YOLO session data directly.

P0 paths:

1. `session.json`
2. `events.jsonl`
3. `turns/<n>.report.json`
4. `turns/.staging/` (uncommitted turn reports; cleaned on crash recovery)
5. `assets/*.json`
6. `assets/.staging/` (uncommitted assets; cleaned on crash recovery)
7. `branches/tree.json` (current tree index + active node pointer)
8. `branches/nodes/*.json` (branch node snapshots; P0 has one linear chain)
9. `branch-dossiers/*.md` (compact per-branch working notes; P0 has one dossier)
10. `plan.md`
11. `plan-state.json` (machine-readable projection of `plan.md` SYSTEM_STATE zone; auto-generated by YoloSession)

P1 adds:

12. `ingress/user-turn-<turn>-upload/` (temporary user upload intake)
13. `ingress/reviewed/` (validated upload manifests)
14. `inputs-curated/` (normalized and accepted user data)
15. `inputs-rejected/` (rejected or unsafe uploads + reasons)
16. `wait-tasks/*.json` (persistent external-assistance wait tickets)

P2 adds:

17. `runtime/lease.json` (owner + heartbeat + stale detection)
18. `runtime/checkpoints/*.json` (durable state snapshots for long-run recovery)

### 4.7 plan.md Ownership

`plan.md` is a mutable working document managed by `YoloSession`, not an immutable asset.

Rules:

1. `YoloSession` creates `plan.md` during `PLANNING` state from initial goal,
2. after each turn, `YoloSession` updates `plan.md` based on turn report (progress marks, branch decisions, next-step),
3. `plan.md` uses deterministic zones:
   `SYSTEM_STATE` (session-managed, agent read-only) and `AGENT_NOTES` (agent append-only),
4. agent may only append/update inside `AGENT_NOTES` zone during a turn,
5. `YoloSession` only updates `SYSTEM_STATE` zone; no free-form textual merge across zones,
6. `plan-state.json` is the mandatory machine-readable projection of `SYSTEM_STATE`; `YoloSession` auto-generates it after every `SYSTEM_STATE` update; downstream consumers (planner, UI, gate engine) read `plan-state.json` instead of parsing markdown,
7. `plan.md` is not subject to asset append-only rules,
8. per-branch short memory is stored in `branch-dossiers/<branchId>.md`, using the same zone convention as `plan.md`: `SYSTEM_STATE` (session-managed) + `AGENT_NOTES` (agent append-only),
9. snapshots of `plan.md` and active branch dossier are included in each turn report for audit trail,
10. planner input must reference a persisted `planSnapshotHash` from turn report input manifest (not implicit "latest file on disk" state) for replay determinism,
11. `AGENT_NOTES` zone has an 8KB soft limit; when exceeded, context assembly injects only the most recent entries — older entries remain on disk but are not loaded into the prompt. This controls growth without changing write rules.

### 4.8 Event Schema

`events.jsonl` is the foundation for crash recovery and UI state reconstruction. Each line is a single event:

```ts
interface YoloEvent {
  eventId: string
  sessionId: string
  turnNumber: number
  seq: number              // monotonic within turn
  timestamp: string
  schemaVersion: number    // starts at 1; bump on breaking changes
  eventType: string        // discriminated union tag
  payload: { ... }         // typed per eventType
}
```

Minimum eventType set (P0):

1. `turn_started`
2. `turn_committed`
3. `asset_created`
4. `asset_updated`
5. `branch_mutated`
6. `gate_evaluated`
7. `state_transition`
8. `user_input_merged`
9. `ask_user_emitted`
10. `checkpoint_confirmed`
11. `amendment_requested`
12. `planner_spec_generated`

Rules:

1. payload must be a typed discriminated union per eventType — no `Record<string, unknown>`,
2. events are append-only; corrections emit new events, never overwrite,
3. `turn_committed` is the durability boundary (see Section 4.9 Turn Commit Protocol).

### 4.9 Turn Commit Protocol

Crash during a turn can produce ghost assets (files exist but audit chain is broken) or ghost events (events exist but asset files are missing). The commit protocol makes turn boundaries atomic using filesystem operations only.

Commit sequence:

1. new assets write to `assets/.staging/<assetId>.json`,
2. turn report writes to `turns/.staging/<n>.report.json`,
3. after all writes succeed, rename staged files to final paths (atomic per file),
4. append `turn_committed` event to `events.jsonl` with payload: `{ turnNumber, attempt, createdAssetIds[], snapshotManifestId }`.

Recovery rules:

1. only turns with a matching `turn_committed` event are considered durable,
2. on crash recovery, delete contents of `assets/.staging/` and `turns/.staging/`,
3. emit `crash_recovery` event noting cleaned staging files,
4. resume from last durable `TURN_COMPLETE`.

This turns crash recovery from "guess which writes completed" into "deterministic: committed or not."

## 5. Execution Model

## 5.1 Stage Axis (Research Progress)

Stages remain:

1. `S1 Problem Framing`
2. `S2 Bottleneck Evidence`
3. `S3 Design and Prototype`
4. `S4 Evaluation and Analysis`
5. `S5 Paper Drafting`

But stage progression is not strictly linear. In YOLO-Scholar:

1. stage is a quality axis, not a fixed one-way pipeline,
2. active branch can revisit earlier stages when new evidence falsifies assumptions,
3. rollback reopens prior stage obligations instead of forcing global restart.

## 5.2 Exploration Control Axis (BranchTree)

Use branch tree for non-linear search control, while evidence remains shared in graph assets.

Core objects:

```ts
interface BranchNode {
  nodeId: string
  branchId: string
  parentNodeId?: string
  stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  hypothesisIds: string[]
  openRisks: string[]
  evidenceDebt: string[]        // unresolved evidence obligations
  confidenceBand: 'high' | 'medium' | 'low'
  status: 'active' | 'paused' | 'merged' | 'pruned' | 'invalidated'
  summary: string
}
```

Allowed operations:

1. `advance`: continue current node with next bounded action,
2. `fork`: create child branch when uncertainty or alternative mechanism is material (P1+),
3. `revisit`: jump to ancestor node and reopen unresolved obligations (P1+),
4. `merge`: merge branch conclusions into target branch with explicit conflict note (P1+),
5. `prune`: archive low-value branch with rationale (P1+).

P0 degenerate mode: `BranchManager` interface exposes all five operations, but P0 implementation only supports `advance`. Calling `fork/revisit/merge/prune` in P0 returns an error with "upgrade to P1 for multi-branch search". This keeps the interface stable while deferring complexity.

Planner policy (deliberative, argument-driven):

1. each branch action must include rationale + falsifier hypothesis,
2. branch choice uses open risks, evidence debt, and reviewer objections,
3. create at most 1-2 child nodes per turn,
4. hard bounds are always enforced by `TurnSpec` constraints.

Control policy:

1. runtime hard-codes only safety/audit invariants (bounds, append-only assets, gate rules),
2. branch choice is LLM-planned from current evidence/risk state, not rigid scripted stage templates.

## 5.3 Runtime State Machine (Execution Axis)

States:

1. `IDLE`
2. `PLANNING`
3. `EXECUTING`
4. `TURN_COMPLETE`
5. `WAITING_FOR_USER`
6. `WAITING_EXTERNAL` (P1+; P0 uses `WAITING_FOR_USER` as fallback for external deps)
7. `PAUSED`
8. `COMPLETE`
9. `FAILED`
10. `STOPPED`
11. `CRASHED`

Key transitions:

1. `IDLE -> PLANNING -> EXECUTING`
2. `EXECUTING -> TURN_COMPLETE`
3. `TURN_COMPLETE -> EXECUTING` (auto continue on selected branch)
4. `TURN_COMPLETE -> WAITING_FOR_USER` (ask-user/checkpoint)
5. `TURN_COMPLETE -> WAITING_EXTERNAL` (external run/data required)
6. `* -> PAUSED` (user pause)
7. `PAUSED -> EXECUTING` (resume)
8. `WAITING_EXTERNAL -> PLANNING` (required external artifacts satisfied)
9. `TURN_COMPLETE -> COMPLETE | FAILED | STOPPED`
10. process failure -> `CRASHED` and recoverable resume path.

Stage, branch node, and runtime state are orthogonal dimensions.

## 5.4 Turn Transaction Model

Each turn executes one `TurnSpec` and one bounded `ActionBatch`.

```ts
interface TurnSpec {
  turnNumber: number
  stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  branch: {
    activeBranchId: string
    activeNodeId: string
    action: 'advance' | 'fork' | 'revisit' | 'merge' | 'prune'
    targetNodeId?: string
  }
  objective: string
  expectedAssets: string[]
  constraints: {
    maxToolCalls: number
    maxWallClockSec: number
    maxStepCount: number
    maxNewAssets: number
    maxDiscoveryOps: number   // advisory in P0 (logged, not enforced); enforced P1+
    maxReadBytes: number      // hard-enforced in P0 (append-only makes garbage undeletable)
    maxPromptTokens: number
    maxCompletionTokens: number
    maxTurnTokens: number
    maxTurnCostUsd: number
  }
}
```

Turn validity:

1. all bounds respected,
2. at least one auditable asset mutation,
3. branch mutation recorded (`node created/updated/merged/pruned`) when action is not pure `advance`,
4. gate impact emitted (`none/pass/fail/rollback-needed`),
5. token/cost bounds respected or explicit budget-exceeded stop path emitted.

No auditable mutation -> `non-progress` turn.

### 5.4.1 TurnSpec Generation (LLM Planner)

`YoloSession` uses a dedicated LLM call to generate each `TurnSpec` before the turn executes.

Planner input:

1. persisted `planSnapshot` (hash-addressed snapshot from last committed turn report),
2. branch tree snapshot (active branch, frontier nodes, open risks, evidence debt),
3. current stage and gate status,
4. last N turn reports (summaries only),
5. queued user inputs (if any),
6. asset inventory (type counts and latest ids per type),
7. remaining budget (turns, wall-clock, tokens).

Planner output:

1. `TurnSpec` with concrete objective and bounds,
2. suggested prompt for yolo-coordinator (the message that drives the turn),
3. rationale (why this objective and branch action improve expected submission readiness),
4. uncertainty note (what could falsify current direction).

Policy:

1. planner uses a fast/cheap model (e.g. haiku/gpt-5-nano) to minimize overhead,
2. planner output is validated against constraints and branch invariants before execution,
3. if planner produces invalid spec (missing fields, exceeds budget), `YoloSession` falls back to conservative `advance` spec: session-level default constraints, objective `"consolidate current state and report blockers"`, must produce at least one `RiskRegister` update recording the planner failure reason (zero-asset fallback would trigger non-progress, creating an intervention spiral),
4. planner call is recorded in turn report as `plannerSpec` + `plannerRationale`,
5. consecutive non-progress turns (>=3) trigger mandatory re-plan with `fork/revisit` consideration (P0: re-plan with `advance` only since fork/revisit are deferred); counter resets to 0 on any valid turn, on branch switch, and on user input merge; pause/resume does not affect counter; counter is persisted in `session.json`,
6. planner input manifest must include `planSnapshotHash` and `branchDossierHash` for replay determinism.

### 5.4.2 TurnSpec Amendment Protocol

Executor may discover stronger opportunities during execution, but cannot silently change turn scope.

Rules:

1. executor can emit `TurnSpecAmendmentRequest` with rationale and expected asset impact,
2. amendment is recorded as event/asset candidate and never auto-applied mid-turn,
3. commander decides at turn boundary: `accept-next-turn` or `reject`,
4. accepted amendment must appear in next turn's `plannerSpec` and input manifest.

### 5.4.3 Cost Model and Budget Policy

Budget is first-class and enforced per turn and per session.

Session-level budget state:

1. remaining token budget,
2. remaining cost budget (`USD`),
3. remaining turn/time budget.

Policy:

1. if a turn is likely to exceed budget, planner must produce a downgraded spec (smaller scope or cheaper model),
2. runtime applies degradation ladder before hard stop:
   reduce model tier -> reduce context breadth -> reduce branch fan-out,
3. if budget still insufficient, stop with explicit budget report and required user decision.

## 5.5 Context Window Strategy

Per turn context assembly:

1. base system prompt,
2. `plan.md` current stage section,
3. active branch dossier (`branchId`, open risks, evidence debt),
4. stage-relevant asset summaries from evidence graph,
5. recent N turn summaries,
6. queued user inputs drained at boundary,
7. curated input manifests from latest accepted user-turn uploads (P1+),
8. last reviewer/gate outcome.

Policy:

1. long-term continuity comes from assets + `plan.md` + branch dossiers,
2. chat history is short-horizon only,
3. compaction may drop old messages but never drops durable assets/branch records,
4. large files are never injected raw; only bounded snippets/manifests enter context,
5. workspace discovery is delegated to the agent via existing tools (glob, grep, read, bash) within the turn,
6. each turn enforces `maxReadBytes` (hard, P0+) and `maxDiscoveryOps` (advisory P0, hard P1+).

## 6. Interaction Protocol

## 6.1 ask_user Tool Contract

Primary interaction mechanism is tool-based.

```ts
tool ask_user {
  question: string
  options?: string[]
  context?: string
  checkpoint?: 'problem-freeze' | 'baseline-freeze' | 'claim-freeze' | 'final-scope'
  blocking?: boolean // default true
}
```

Behavior:

1. on call, session emits `yolo:question`,
2. state moves to `WAITING_FOR_USER` if blocking,
3. next turn starts only after user reply.

Fallback marker parsing (`YOLO_ASK_USER:`) is allowed but non-authoritative.

## 6.2 Input Queue Contract

```ts
interface QueuedUserInput {
  id: string
  text: string
  priority: 'urgent' | 'normal'
  createdAt: string
  source: 'chat' | 'system'
}
```

Rules:

1. queue accepts input in `EXECUTING/WAITING_FOR_USER/PAUSED`,
2. merge occurs only at turn boundary,
3. urgent entries are merged first,
4. merged ids are recorded in turn report.

## 6.3 Checkpoint UI Contract

Mandatory checkpoints must be explicit UI cards, not plain chat text.

Card fields:

1. checkpoint type,
2. proposed decision,
3. alternatives,
4. impact summary,
5. confirm/edit actions.

Checkpoint confirmation must write a `Decision` asset (Section 10.4.2) with the user's choice, alternatives, and rationale. This makes checkpoint outcomes durable, auditable, and visible to gate replay and crash recovery.

## 6.4 Intervention Policy

Mandatory user intervention triggers:

1. two consecutive rollbacks,
2. unresolved baseline ambiguity,
3. selected eval tier infeasible under budget,
4. non-dominated claim scope tradeoff.

## 6.5 User File Ingestion Protocol

User-provided files follow per-turn staging and curation via `UserIngressManager` (P1+). See Section 22 for full filesystem orchestration contract including directory roles, ingestion lifecycle, and guardrails.

Literature full-text rule:

1. if required PDF/full-text cannot be programmatically retrieved (paywall, auth, blocked access), agent must not fabricate content,
2. agent must trigger `ask_user` with explicit upload request and expected file list,
3. if full-text is blocking, runtime must enter `WAITING_EXTERNAL` with a wait ticket referencing upload directory.

## 6.6 External Assistance and Persistent Wait Protocol (P1+)

When the agent needs external execution/help (for example, user runs an experiment on another machine), it must enter a durable waiting flow. This protocol is deferred to P1 since P0 focuses on the core turn loop; in P0, external dependencies are handled via `ask_user` + `WAITING_FOR_USER` as a simpler fallback.

S2-S4 experiment outsourcing policy (v1 default):

1. YOLO Researcher is **not** a full system experiment platform,
2. in S2-S4, the agent should produce explicit experiment requirements (`ExperimentRequirement`) describing `why`, `objective`, `method`, and `expectedResult`,
3. execution is outsourced to user/external environment; runtime persists `WAITING_EXTERNAL` ticket and waits for uploaded artifacts before continuing.

State transition:

1. `TURN_COMPLETE -> WAITING_EXTERNAL` when external dependency is required,
2. write wait ticket to `wait-tasks/<wait_id>.json`,
3. stop autonomous turns until ticket is satisfied or canceled.

`WaitTask` minimum schema:

```ts
interface WaitTask {
  id: string
  createdAt: string
  stage: 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  branchId: string
  nodeId: string
  status: 'waiting' | 'satisfied' | 'canceled' | 'expired'
  reason: string
  requiredArtifacts: Array<{ kind: string; pathHint?: string; description: string }>
  uploadDir: string               // e.g. ingress/user-turn-0012-upload
  completionRule: string          // deterministic checker expression or checklist id
  resumeAction: string            // what next turn should do after satisfaction
}
```

Rules:

1. wait tickets are append-only records (status changes via superseding ticket record or explicit status event),
2. session resume across app restart reads `session.json` + open wait tickets,
3. if completionRule is met (files curated + checks passed), transition `WAITING_EXTERNAL -> PLANNING`,
4. if not met, session remains waiting without losing context,
5. turn report must include the open wait ticket id when in `WAITING_EXTERNAL`.

## 7. Gate Semantics and Evaluator Architecture

### 7.0 GateEngine Interface Contract

P0 uses `StubGateEngine`; P1 replaces it with structural gates. Both must implement the same interface so the upgrade is a swap, not a rewrite.

```ts
interface GateEngine {
  evaluate(manifest: SnapshotManifest): GateResult
}

interface GateResult {
  stage: string
  passed: boolean
  structuralChecks: { name: string; passed: boolean; detail?: string }[]
  hardBlockers: { label: string; assetRefs: string[] }[]
  advisoryNotes: string[]
}
```

`StubGateEngine` implements this interface with `passed: true` by default. It supports forced-fail injection for testing. P1+ implementations add real structural checks while keeping the same `GateResult` shape.

### 7.0.1 SnapshotManifest

Gate input must be a deterministic manifest, not a disk scan. This ensures gate evaluation is replayable.

```ts
interface SnapshotManifest {
  id: string
  assetIds: string[]
  evidenceLinkIds: string[]
  branchNodeId: string
  planSnapshotHash: string
  generatedAtTurn: number
}
```

Manifest generation (closure algorithm):

1. start from current branch node's referenced asset IDs,
2. follow `supersedes` chains to include full version history,
3. follow `EvidenceLink` references to include linked evidence,
4. collect all reachable asset IDs into a deterministic sorted list,
5. write manifest to turn report.

`GateEngine.evaluate()` only accepts a `SnapshotManifest`. Disk scanning is used only to generate the manifest, never inside gate evaluation.

## 7.1 Gate Determinism Requirement

For gate pass/fail:

`pass_Gk = f_structural(SnapshotManifest)`

The `SnapshotManifest` (Section 7.0.1) is the deterministic closure of all reachable assets from the current branch node.

Rules:

1. structural gate is deterministic and replayable,
2. structural gate reads only the `SnapshotManifest`; no direct filesystem access during evaluation,
3. no hidden runtime memory or transient chat state in pass/fail decisions.

## 7.2 Structural Gates (Deterministic Code)

Deterministic checks:

1. required assets exist,
2. required fields complete,
3. type/format constraints,
4. coverage thresholds,
5. parity/reproducibility flags,
6. `EvidenceLink.countingPolicy` eligibility for coverage counting.

Boundary:

1. structural gates only validate objective obligations (traceability, reproducibility, fairness, minimum causality, claim-evidence presence),
2. structural gates must not decide pass/fail from subjective narrative quality ("novel enough", "writing quality", "argument elegance").

## 7.3 Semantic Review (LLM-Assisted, Advisory, P3+)

Semantic review is argument-driven and evidence-cited, not numeric-score-driven.

Activation policy:

1. semantic review is enabled in `P3+` only,
2. `P1/P2` run structural gates only.

Stability policy:

1. run 3 independent reviewer passes (Novelty/System/Evaluation/Writing perspectives),
2. each pass must answer anchor questions with asset/run citations,
3. disagreement recorded in `ReviewerNote`,
4. unresolved concerns are materialized into `RiskRegister` entries with explicit next actions,
5. hard-blocker labels must use anchored taxonomy (not free-form): `claim_without_direct_evidence`, `causality_gap`, `parity_violation_unresolved`, `reproducibility_gap`, `overclaim`.

## 7.4 Combined Gate Decision

Gate evaluation timing (structural, P1+):

1. after each turn, evaluate the gate for the current stage,
2. also run regression checks on previously-passed gates to detect regressions from new evidence or asset updates.

Gate pass/fail in v1.x:

1. structural gate passes,
2. no hard blocker.

Semantic-review escalation rule (P3+):

1. if >=2/3 reviewer passes mark the same anchored hard blocker with citations, runtime must pause progression (`WAITING_FOR_USER`) even when structural gate passes,
2. pause requires user confirmation or remediation plan before advancing.

## 8. Stage Gates

### 8.1 G1 Problem Framing

Required assets:

1. problem definition + hypothesis,
2. reproducible workload setup,
3. `BaselineLandscape`.

Pass:

1. >=1 reproducible setup,
2. >=2 primary metrics,
3. baseline landscape approved.

### 8.2 G2 Bottleneck Evidence

Required assets:

1. profile artifacts,
2. root-cause statement,
3. baseline behavior explanation,
4. intervention or counterfactual evidence.

Pass:

1. dominant bottleneck quantified,
2. mapping to mechanism,
3. causality evidence supports direction.

### 8.3 G3 Design and Prototype

Required assets:

1. mechanism design,
2. running prototype record,
3. microbench evidence,
4. additional intervention evidence.

Pass:

1. prototype executes,
2. claim-effect mapping is test-backed,
3. side-effects/tradeoffs documented.

### 8.4 G4 Evaluation and Analysis

Required assets:

1. end-to-end comparisons,
2. ablation/sensitivity (by tier),
3. overhead analysis,
4. fairness + parity validation.

Pass:

1. tier requirements met,
2. no critical parity/fairness violation,
3. primary claim direction supported.

### 8.5 G5 Draft

Required assets:

1. complete draft,
2. claim-evidence table,
3. threats/limits,
4. tier/scope disclosure.

Pass:

1. uncovered primary claims = 0,
2. no overclaim beyond evaluated scope.

## 9. Resource Budget and Evaluation Tier

Before S4, materialize:

1. `ResourceBudget`
2. `EvalTierPlan`
3. `TierJustification`

`ResourceBudget` fields:

1. machine inventory,
2. available machine-hours,
3. max concurrency,
4. baseline-count upper bound,
5. deadline date.

Tier definitions:

`Gold`:

1. >=2 strong baselines,
2. ablation + sensitivity,
3. full overhead profile.

`Silver`:

1. >=2 baselines,
2. ablation or sensitivity,
3. overhead profile.

`Bronze`:

1. 1 strong baseline,
2. microbench + constrained end-to-end,
3. scoped overhead profile.

Constraints:

1. tier must reference `ResourceBudget`,
2. non-Gold requires claim narrowing,
3. downgrade without budget evidence is invalid.

## 10. Evidence Asset Model

## 10.1 EvidenceGraph Contract

Evidence is modeled as a shared DAG across all branches.

Rules:

1. branch tree controls search decisions; it does not duplicate evidence payloads,
2. evidence assets are global and reusable across branches,
3. every claim/evidence edge must record provenance (`sourceAssetId`, `createdByBranchId`),
4. branch merge reuses existing evidence ids and adds new conflict-resolution notes instead of cloning evidence.

Minimum link types (two categories):

Claim-evidence links (modeled via `EvidenceLink` interface, Section 10.4.1):

1. `supports` (`Evidence -> Claim`),
2. `falsifies` (`Evidence -> Hypothesis/Claim`),
3. `context` (background evidence relevant to claim but not directly supporting/falsifying).

Asset-dependency links (structural provenance, stored as `dependsOn`/`derivedFrom` fields within asset payloads):

4. `depends_on` (`RunRecord/Figure -> EnvSnapshot/ReplayScript/WorkloadVersion`),
5. `derived_from` (`FigureTable -> MetricSeries/RunRecord`).

## 10.2 Minimal Core Types by Phase

`P0/P1 core`:

1. `Hypothesis`
2. `Claim`
3. `EvidenceLink`
4. `DraftSection`
5. `ReviewerNote`
6. `RunRecord`
7. `EnvSnapshot` (minimal schema in P1: `id + hashKey + metadata`)
8. `WorkloadVersion` (minimal schema in P1: `id + hashKey + metadata`)
9. `RiskRegister`
10. `Decision`

`P2/P3 extended` adds:

1. `BaselineLandscape`
2. `BaselineParityContract`
3. `ExperimentSpec`
4. `MetricSeries`
5. `FigureTable`
6. `ReplayScript`
7. `EnvSnapshot` (extended schema)
8. `WorkloadVersion` (extended schema)
9. `ResourceBudget`
10. `EvalTierPlan`
11. `TierJustification`

## 10.3 Immutability, ID Strategy, and Version Chain

1. assets are append-only,
2. no in-place overwrite,
3. updates produce new id with `supersedes` pointer.

Asset ID format: `<Type>-t<turnNumber>-a<attempt>-<seq>`, e.g. `Claim-t003-a1-001`.

1. `turnNumber` provides temporal ordering,
2. `attempt` handles crash-retry idempotency (same turn, new attempt after recovery),
3. `seq` handles multiple assets of the same type within one turn.

## 10.4 Turn-Level Asset Diff

Turn report must emit:

1. `created[]`,
2. `updated[{new_id, supersedes}]`,
3. `linked[evidence_link_ids]`.

### 10.4.1 EvidenceLink Applicability Contract

`EvidenceLink` is not a raw pointer; it carries counting semantics.

```ts
interface EvidenceLink {
  id: string
  claimId: string
  evidenceId: string
  relation: 'supports' | 'falsifies' | 'context'
  applicability: {
    workloadEnvelope?: string
    scaleRange?: string
    assumptions?: string[]
  }
  constraintsRef: {
    envSnapshotId?: string
    workloadVersionId?: string
    baselineParityContractId?: string
  }
  countingPolicy: 'countable' | 'cite_only' | 'needs_revalidate'
}
```

Rules:

1. cross-branch reuse defaults to `cite_only`,
2. auto-upgrade to `countable` is allowed when `envSnapshotId + workloadVersionId + baselineParityContractId` are identical and applicability has no conflict,
3. otherwise `countable` requires explicit revalidation evidence,
4. `needs_revalidate` links cannot satisfy coverage thresholds until upgraded.

P1 cross-branch reuse strategy: introduce minimal `EnvSnapshot` and `WorkloadVersion` schemas in P1 (id + hashKey + metadata). Auto-upgrade uses ID equality comparison. Without this, P1 coverage checking is dominated by `cite_only` links and structural gates become ineffective.

### 10.4.2 Decision Asset Contract

Checkpoint confirmations and state-changing approvals must be recorded as append-only `Decision` assets, not transient UI events. Without this, gate replay cannot see why a claim became `asserted`, and crash recovery cannot reconstruct approval history.

```ts
interface Decision {
  id: string
  kind: 'problem-freeze' | 'baseline-freeze' | 'claim-freeze' | 'final-scope' | 'override'
  madeAt: string
  madeBy: 'user' | 'system'
  branchId: string
  nodeId: string
  turnNumber: number
  referencedAssetIds: string[]
  choice: string
  alternatives?: string[]
  rationale?: string
  supersedes?: string
}
```

Rules:

1. `proposed → asserted` on a Claim must reference a `Decision(kind='claim-freeze')`,
2. every checkpoint confirmation (Section 6.3) writes a Decision asset,
3. Decision assets follow the same append-only + supersedes rules as other assets,
4. `Decision(kind='override')` is the only mechanism to bypass a gate or contract violation (P1+, see Section 14 rollback policy).

## 10.5 Reproducibility Triple

Each key `RunRecord` must reference:

1. `EnvSnapshot`,
2. `ReplayScript`,
3. `WorkloadVersion`.

Key-run rule:

1. any `RunRecord` linked to asserted primary/secondary claim evidence is a key run,
2. key runs must satisfy reproducibility triple + parity constraints,
3. if key-run constraints are missing, linked `EvidenceLink` must be downgraded to `cite_only`.

G4 structural check (P1+): verify that all `countable` evidence links pointing to asserted primary claims reference RunRecords with complete reproducibility triple. At claim-freeze time, missing triples do not block (experiments may not have run yet) but must generate `RiskRegister` entries.

## 10.6 Claim Schema and Coverage

```ts
interface Claim {
  id: string
  text: string
  tier: 'primary' | 'secondary' | 'exploratory'
  state: 'proposed' | 'asserted' | 'supported' | 'refuted' | 'dropped'
  claimType: 'performance' | 'scalability' | 'overhead' | 'robustness'
  branchContext: { createdInBranchId: string; activeNodeId: string }
  expectedEffect?: { direction: 'up' | 'down'; magnitudeRange?: string }
  falsifier?: string
  requiredEvidenceKinds: string[]
  evidenceIds: string[]
}
```

Rules:

1. Abstract/Intro contributions default to `primary`,
2. primary claim count target: 2-4,
3. artificial claim splitting invalid,
4. coverage obligations apply to `asserted` claims only.

State transition preconditions:

1. `proposed → asserted`: requires `Decision(kind='claim-freeze')` asset referencing this Claim,
2. `asserted → supported/refuted`: determined by `GateEngine` at G4/G5 evaluation, written as new Claim asset (supersedes),
3. `asserted → dropped`: agent-initiated, must attach rationale + `Decision(kind='override')` with risk acceptance.

Coverage thresholds:

1. `asserted_primary_coverage == 1.0`,
2. `asserted_secondary_coverage >= 0.85`.

## 10.7 Direct-Evidence Mapping

1. `performance/scalability`:
   needs >=1 end-to-end evidence; microbench-only claim cannot be primary.
2. `overhead`:
   needs resource breakdown with parity alignment.
3. `robustness`:
   needs sensitivity or structured failure evidence.

Auto-check must validate `requiredEvidenceKinds` against linked evidence kinds.

## 11. Baseline Parity Contract

Before baseline freeze, create `BaselineParityContract`.

Per-baseline fields:

1. allowed tunable knobs,
2. tuning budget (time/attempts),
3. parity-required knobs,
4. unavoidable baseline-specific differences.

Enforcement:

1. violating run -> `parity_violation`,
2. violating run cannot count toward G4 evidence.

## 12. Causality Minimum

For bottleneck/mechanism claims, require at least one:

1. intervention test,
2. counterfactual test.

Correlation-only evidence cannot pass G2/G3.

## 13. Statistical Defaults

1. recommended repetitions >= 5,
2. minimum repetitions = 3 with variance disclosure,
3. report mean + 95% CI,
4. latency reports include p50/p95/p99,
5. warmup and steady-state windows documented.

## 14. Reviewer-in-the-Loop

Personas:

1. Novelty,
2. System,
3. Evaluation,
4. Writing.

Stage-to-persona mapping (3 passes per stage, P3+):

1. S1-S4: Novelty + System + Evaluation,
2. S5: System + Evaluation + Writing.

Novelty review input is valid only with:

1. baseline landscape,
2. mechanism delta table,
3. assumption/tradeoff comparison.

Anchor-question enforcement (must cite asset/run ids):

1. top-3 primary claims and direct supporting evidence ids,
2. strongest baseline selection and parity rationale,
3. key falsifier tests for each major mechanism claim and their outcomes,
4. explicit unresolved risks that could invalidate conclusions.

Hard blockers:

1. uncovered primary claim,
2. critical fairness/parity violation,
3. unreproducible key result,
4. overgeneralized conclusion.

Reviewer hard-blocker anchoring:

1. blocker annotations must map to anchored taxonomy in Section 7.3,
2. blockers without asset/run citations are treated as advisory risk, not blocking.

Rollback:

1. fail G5 -> revisit strongest supporting S4 node on active branch,
2. fail G4 -> revisit or fork from latest valid S3 node,
3. fail G3 -> revisit or fork from latest valid S2 node,
4. fail G2 -> revisit or fork from latest valid S1 node.

Forward threshold:

1. no hard blocker,
2. all anchor questions answered with citations,
3. open high-severity risks recorded in `RiskRegister` with action owner/next step.

## 15. Deadlock Breaker

If same rollback class repeats >=2 times -> enter `ScopeNegotiation`.

Only allowed actions:

1. narrow claim scope,
2. narrow baseline set with justification,
3. narrow workload envelope,
4. fork alternative hypothesis branch,
5. request resource extension (`request_resource_extension`) with explicit budget delta and rationale.

Exit:

1. feasible tier plan approved, or
2. user stops.

Resource-extension path:

1. `request_resource_extension` transitions to `WAITING_FOR_USER`,
2. user decision updates `ResourceBudget` via append-only superseding record,
3. if approved, planner regenerates `EvalTierPlan` under updated budget.

Loop-breaker policy:

1. if same node fails same gate twice, node must be marked `invalidated` or forked,
2. planner cannot select an invalidated node unless user explicitly overrides via `Decision(kind='override')` referencing the gate/contract being bypassed, with rationale and `riskAccepted` note,
3. all override decisions are surfaced in the final session summary.

## 16. Turn Report and Auditability

Each report includes:

1. turn spec and bounds,
2. consumed budgets,
3. asset diff,
4. branch diff (`activeNode`, `action`, `createdNodes`, `mergedNodes`, `prunedNodes`),
5. gate impact,
6. reviewer snapshot,
7. risk delta,
8. next-step rationale,
9. merged user input ids,
10. non-progress flag,
11. planner input manifest (`planSnapshotHash`, `branchDossierHash`, selected asset snapshot ids).

## 17. Stop Conditions and Crash Recovery

Valid stops:

1. G5 passed,
2. user stopped,
3. hard budget/deadline limit reached with final risk report,
4. unrecoverable deadlock after scope negotiation.

Crash policy:

1. unexpected termination sets state `CRASHED`,
2. on restart, clean staging directories (`assets/.staging/`, `turns/.staging/`) per Turn Commit Protocol (Section 4.9),
3. replay `events.jsonl` — only turns with a `turn_committed` event are considered durable,
4. emit synthetic `crash_recovery` report,
5. resume from last durable `TURN_COMPLETE` snapshot or require user confirmation,
6. replay uses idempotency keys to prevent duplicate run accounting,
7. if last durable state was `WAITING_EXTERNAL`, runtime reloads open wait tickets and re-enters waiting state,
8. if wait ticket completion conditions are already met at startup, runtime transitions to `PLANNING` and resumes,
9. branch tree and active node pointer are reconstructed from `branches/tree.json` + `branches/nodes/*.json`.

Idempotency rules:

1. each experiment run uses `runKey = hash(ExperimentSpec, EnvSnapshot, WorkloadVersion, seed)`,
2. duplicate `runKey` cannot be counted twice in evidence aggregation,
3. crash recovery must reconcile partially written runs before reopening the stage gate.

## 18. P0 Demo Scenario (Concrete Walkthrough)

This section illustrates the P0 runtime skeleton in action on a trivial toy problem.

Goal: "Investigate whether Python dict lookup is faster than list linear search for small collections."

**Turn 0 (PLANNING)**

1. `YoloSession` creates `plan.md` from goal,
2. creates initial branch node `N-001` on branch `B-001` (stage S1),
3. creates `branch-dossiers/B-001.md`,
4. LLM planner generates TurnSpec: `{ stage: S1, branch: { action: advance, activeNodeId: N-001 }, objective: "Define hypothesis and identify baseline workload" }`.

**Turn 1 (EXECUTING → TURN_COMPLETE)**

1. yolo-coordinator runs agent with TurnSpec prompt,
2. agent writes assets: `Hypothesis-t001-a1-001.json` ("dict lookup is O(1) vs list O(n)"), `Claim-t001-a1-001.json` (primary, state: proposed),
3. turn report records: 2 assets created, 0 updated, branch advance on N-001,
4. `YoloSession` updates `plan.md` with progress marks,
5. `StubGateEngine` evaluates and emits `pass` event (control-flow path exercised),
6. auto-continue.

**Turn 2 (EXECUTING → WAITING_FOR_USER)**

1. planner generates TurnSpec: `{ stage: S1, branch: { action: advance }, objective: "Draft experiment requirement and request external run" }`,
2. agent writes `ExperimentRequirement-t002-a1-001.json` (why/objective/method/expectedResult),
3. agent calls `ask_user` to request external execution artifacts,
4. state → `WAITING_FOR_USER` (P0 fallback for external dependency),
5. turn report includes pending external request.

**Turn 3 (WAITING_FOR_USER → PLANNING → TURN_COMPLETE)**

1. user uploads external run artifacts,
2. planner generates TurnSpec: `{ objective: "Curate uploaded evidence and update claim state" }`,
3. agent converts uploaded artifacts into `RunRecord-t003-a1-001.json`,
4. agent analyzes results and updates claim progression (proposed → asserted if justified),
5. turn report records curated upload references and branch advance.

This 3-turn sequence demonstrates: TurnSpec generation, requirement-first experimentation, external dependency handling, asset creation, branch advance, plan.md updates, and user interaction — all within P0 scope.

## 19. Runtime Conformance Tests

Mandatory suite (can run on toy project). Each test is annotated with its earliest applicable phase.

P0-required tests:

1. **[P0]** enforce tight TurnSpec bounds (`maxToolCalls`, `maxWallClockSec`, `maxStepCount`, `maxNewAssets`, `maxReadBytes` must not exceed),
2. **[P0]** verify `advance` operation produces valid linear tree mutation (single branch, sequential nodes),
3. **[P0]** verify asset append-only and supersedes chain,
4. **[P0]** verify turn report records asset diff, branch diff, and planner input snapshot,
5. **[P0]** verify `StubGateEngine` path is executed (pass and forced-fail branches),
6. **[P0]** verify token/cost constraints (`maxPromptTokens`, `maxCompletionTokens`, `maxTurnTokens`, `maxTurnCostUsd`) are enforced,
7. **[P0]** verify pause/resume/stop transitions and session restart from `TURN_COMPLETE`,
8. **[P0]** verify turn commit protocol: crash between staging writes and `turn_committed` event leaves no ghost assets after recovery,
9. **[P0]** verify `Decision` asset is written on checkpoint confirmation and referenced by claim state transitions,
10. **[P0]** verify `SnapshotManifest` is generated and recorded in turn report; `StubGateEngine.evaluate()` receives manifest not raw file list,
11. **[P0]** verify event schema: `events.jsonl` entries parse as valid `YoloEvent` with typed payload per eventType,

P1-required tests:

12. **[P1]** verify full branch operations (`fork/revisit/merge/prune`) produce valid tree mutations,
13. **[P1]** feed correlation-only evidence (G2/G3 structural gate must fail),
14. **[P1]** feed parity contract gaps (G4 fail + ScopeNegotiation),
15. **[P1]** verify structural gate determinism on identical `SnapshotManifest`,
16. **[P1]** verify cross-branch evidence reuse defaults to `cite_only`, and auto-upgrades to `countable` on exact applicability match,
17. **[P1]** verify planner replay uses identical `planSnapshotHash` input and reproduces same decision context,
18. **[P1]** verify `WAITING_EXTERNAL` persistence and restart resume behavior,
19. **[P1]** verify paywalled-PDF path: missing full-text triggers `ask_user` + `WAITING_EXTERNAL` ticket,
20. **[P1]** verify `request_resource_extension` path updates `ResourceBudget` and resumes planning after user decision,

P2-required tests:

21. **[P2]** verify idempotency: duplicate `runKey` is not counted twice after crash/retry,
22. **[P2]** verify long-run checkpoint replay yields same runtime state and active node pointer,

P3-required tests:

23. **[P3]** verify semantic consensus blocker (`>=2/3` same anchored blocker) pauses progression via `WAITING_FOR_USER`,
24. **[P3]** produce final claim-evidence table with asserted primary coverage 1.0 across full S1-S5 pipeline.

## 20. Acceptance Criteria

RFC is accepted when runtime can demonstrate:

1. phase-appropriate YOLO execution (P0-P3),
2. deterministic structural gate replay on stored snapshots,
3. asserted primary coverage 1.0 and asserted secondary coverage >= 0.85,
4. reproducibility triple for key runs,
5. `P3`: reviewer report per stage (`P0-P2`: structural gate reports only),
6. branch-tree recovery and deterministic active-node resume after restart,
7. passing runtime conformance tests,
8. phase-required tooling readiness gates pass (Section 21),
9. persistent `WAITING_EXTERNAL` sessions survive restart and resume correctly.

## 21. Tooling and Environment Readiness Gates

YOLO-Scholar must satisfy runtime capability gates in addition to research quality gates (G1-G5).

### 21.1 TG0 Core Runtime

Required:

1. safe file/code tools available,
2. turn report + event persistence available,
3. pause/resume/stop semantics verified,
4. runtime lease + checkpoint persistence available (P2; P0/P1 rely on turn-report-based recovery).

Blocking rule:

1. cannot start P0 if TG0 fails.

### 21.2 TG1 Code Authoring and Execution

Required:

1. code writing/editing tools available,
2. command execution (`bash`) available under policy,
3. target-language build/compile chain available.

Blocking rule:

1. cannot claim S3 completion if TG1 fails.

### 21.3 TG2 Data and Plotting

Required:

1. Python runtime available,
2. data stack available (`pandas`, `numpy`),
3. plotting stack available (`matplotlib`, optional `seaborn`),
4. headless plotting path verified.

Blocking rule:

1. cannot claim evidence-ready figures/tables if TG2 fails.

### 21.4 TG3 Experiment Externalization Stack

Required for full P3:

1. `ExperimentRequirement` production path is available and validated (`why/objective/method/expectedResult`),
2. external wait flow is available (`WAITING_EXTERNAL` in P1+, `WAITING_FOR_USER` fallback in P0),
3. uploaded artifacts can be normalized into `RunRecord` with reproducibility metadata,
4. baseline parity enforcement hooks for uploaded runs are active.

Blocking rule:

1. S2-S4 claim progression is disabled if TG3 fails.

### 21.5 TG4 External Dependencies

Required where used:

1. selected LLM provider credentials available,
2. web search credentials available (if web mode enabled),
3. required skill scripts or third-party tools available.

Blocking rule:

1. missing dependency must fail fast at preflight with explicit disclosure.

### 21.6 Preflight and Continuous Re-check

Policy:

1. run full readiness preflight before session start,
2. re-check relevant readiness gates on `S2`/`S3`/`S4` entry,
3. write readiness snapshot into turn reports.

### 21.7 Phase Go/No-Go

1. `P0` requires TG0.
2. `P1` requires TG0 + TG4.
3. `P2` requires TG0 + TG1 + TG2 + TG4.
4. `P3` requires TG0 + TG1 + TG2 + TG3 + TG4.

If required readiness gates fail, runtime must downgrade phase or stop with explicit reason.

## 22. Filesystem Orchestration Contract (P1+)

YOLO-Scholar uses filesystem structure as the protocol layer for user-provided data.

### 22.1 Directory Roles

All paths relative to session root (`yolo/<sid>/`):

1. `ingress/user-turn-<turn>-upload/`: short-lived external/user upload staging,
2. `inputs-curated/`: curated canonical user-provided data for downstream use,
3. `inputs-rejected/`: rejected payloads with rejection metadata,
4. `assets/`: append-only research assets and version chain,
5. `branches/`: branch tree index and node snapshots,
6. `branch-dossiers/`: per-branch short memory files,
7. `turns/`: per-turn transaction records and diffs,
8. `ingress/reviewed/`: validated upload manifests.

### 22.2 Ingestion Lifecycle

`UserIngressManager` handles the full intake flow:

1. create turn-scoped ingress directory before user upload,
2. validate file type/size/hash and basic safety checks,
3. normalize filename/path conventions,
4. emit ingestion manifest asset,
5. move accepted file into curated space or link to existing deduplicated content,
6. purge stale ingress directories by retention policy.

Rules:

1. files in ingress staging are temporary and not directly used as evidence,
2. only curated files can be referenced in claims/evidence links,
3. each accepted file generates an ingestion manifest (source path, hash, size, mime, curation notes),
4. duplicate uploads are deduplicated by content hash and linked to prior curated records.

### 22.3 Context Injection Guardrails

1. do not inject entire large files into context,
2. prefer curated artifacts over raw ingress files,
3. include provenance pointers (`asset_id`, `path`, `hash`) for every injected item,
4. large user uploads are summarized into manifests before context injection.

### 22.4 Workspace Discovery

Workspace discovery uses the agent's existing tools (glob, grep, read, bash). No dedicated discovery component is needed.

The agent's standard toolset already provides:

1. `glob` for file pattern matching,
2. `grep` for content search,
3. `read` for file reading,
4. `bash` for arbitrary shell commands when needed.

`YoloSession` supports discovery by including stage-relevant and branch-relevant hints in the turn prompt (current stage, active branch node, objective, asset inventory). The agent decides what to explore within the turn.

Discovery budget rules:

1. each turn caps discovery operations by `maxDiscoveryOps`,
2. each turn caps read volume by `maxReadBytes`,
3. if budget is exhausted, turn must either emit partial result or ask user for guidance.

### 22.5 Failure-Reduction Rules

1. if required file is missing or ambiguous, trigger `ask_user` instead of guessing,
2. if agent cannot locate expected assets, turn report must record the search attempt and failure reason,
3. if evidence debt persists for 3 turns on same node, planner must revisit or fork instead of repeated advance.

## 23. Long-Horizon Robustness (Weeks to Months) — P2+

YOLO-Scholar must remain stable for research cycles spanning weeks or months. This section is deferred to P2 since P0/P1 sessions are expected to be hours-to-days in scope; the mechanisms below become critical only when sessions span multi-day or multi-week horizons.

### 23.1 Runtime Lease and Heartbeat

1. active runtime maintains `runtime/lease.json` with owner id and heartbeat timestamp,
2. stale lease detection allows safe takeover after timeout,
3. takeover writes explicit recovery event before resuming execution.

### 23.2 Durable Checkpoint Cadence

1. write checkpoint snapshot after every `TURN_COMPLETE`,
2. write periodic rollup checkpoint (e.g. daily) for fast resume,
3. checkpoint includes stage, runtime state, open wait tickets, budget usage, and latest plan hash.

### 23.3 Event and Artifact Hygiene

1. rotate large logs (`events.jsonl`) with bounded segment size,
2. archive stale intermediate artifacts into `archive/` with manifest pointers,
3. keep active working set small for retrieval efficiency.

### 23.4 Maintenance and Drift Controls

1. run periodic integrity checks on asset chain (`supersedes` continuity),
2. verify unresolved wait tickets and emit reminders/escalations,
3. enforce budget drift alarms (time/tokens/turns) against project horizon,
4. detect repeated non-progress windows and require replanning or user intervention.

### 23.5 Resume Guarantees

After restart, system guarantees:

1. no loss of durable assets/turn reports/events before last committed checkpoint,
2. deterministic reconstruction of runtime state from persisted files,
3. safe continuation from `WAITING_EXTERNAL`, `PAUSED`, or `TURN_COMPLETE` boundaries,
4. deterministic reconstruction of branch tree and active node pointer.

## 24. UI Architecture

The user's role is **research supervisor** ("committee chair"), not operator. The UI must support structured decision-making at checkpoints, rapid progress scanning between checkpoints, and deep diagnostics when things go wrong. The interaction mode is semi-autonomous supervision — the system runs autonomously most of the time, and the user intervenes at defined decision points.

Core design constraint: **this is NOT a chat interface.** The underlying LLM interaction is hidden; the user sees structured views, not streaming text.

### 24.1 Design Principles

1. answer five questions at a glance: what is the system doing / why / how well / how much has it cost / what does it need from me,
2. structured interaction at decision points (modal cards for checkpoints, not chat bubbles),
3. progressive disclosure: summary by default, detail on demand,
4. no subjective quality scores in the UI (coverage metrics yes, "research quality: 87/100" no),
5. phased UI delivery aligned with backend phases (Section 24.7).

### 24.2 View Catalog

Six views total (P0: three views; Branch Explorer and Evidence Map activate in P1; Diagnostics activates in P2), ordered by user dwell time:

**V1 Mission Control** (primary view, ~80% dwell time):

1. stage progress bar: S1→S5, current stage highlighted, gate status icons on each stage node (pass / not-evaluated / fail); clickable for gate details,
2. runtime state badge: globally visible across all views; color-coded (green pulsing = EXECUTING, orange = WAITING_FOR_USER, blue = WAITING_EXTERNAL, gray = PAUSED, red = FAILED/CRASHED),
3. current turn card: turn number, objective (from `TurnSpec.objective`), budget usage (tool calls used/max, wall-clock elapsed/max), active branch and node ID; live-updated during execution,
4. mini coverage indicator: `Primary: 3/4 covered` with click-through to full Claim-Evidence Matrix (V3),
5. session budget summary: tokens used/remaining, cost so far/cap, turns elapsed/max; burn rate trend.

**V2 Branch Explorer** (decision tree, **P1+ only**):

Rationale: in P0 with degenerate single-branch, Branch Explorer is a linear node list that duplicates Turn Timeline. It provides independent value only when multi-branch operations (fork/revisit/merge/prune) are available in P1.

1. horizontal tree layout, left to right,
2. each node is a card: node ID, short description, status (active / paused / pruned / invalidated / merged),
3. active path highlighted; pruned/invalidated branches grayed but visible (abandonment reasons are valuable),
4. edge styles distinguish operation types: advance (solid arrow), fork (split), revisit (dashed back-arrow), merge (convergence),
5. click node → side panel shows branch dossier, associated assets, gate evaluations.

**V3 Evidence Map** (asset inventory + claim-evidence matrix):

1. first layer: asset type summary (Hypothesis ×2, Claim ×4, EvidenceLink ×7...) with count and last-updated timestamp,
2. second layer: expanded type list with ID, summary, supersedes chain, originating branch,
3. **Claim-Evidence Matrix** (highest-value visualization): rows = asserted claims (sorted by tier), columns = evidence links, cells = coverage status (countable / cite_only / needs_revalidate / empty); primary rows with gaps are highlighted red,
4. supersedes chain expandable like git blame — click asset to see full evolution history.

**V4 Checkpoint and Dialog**:

1. checkpoint events (`WAITING_FOR_USER` + checkpoint type) → **full-width modal card**, not dismissible without action; fields: checkpoint type, proposed decision, alternatives, impact summary (what paths get locked), confirm / edit / reject buttons,
2. ordinary `ask_user` questions → **side panel dialog**, lower urgency; does not block other view navigation,
3. input queue panel: user can see queued messages, their priority, estimated processing turn; supports reorder, cancel, and priority change,
4. urgency levels: `checkpoint-freeze` > `intervention-trigger` > `ordinary-ask-user`; visual treatment scales with urgency.

**V5 Turn Timeline** (audit trail):

1. vertical timeline, newest at top,
2. collapsed card: turn number, stage, branch action, objective, pass/fail, asset diff summary (+3 created, 1 updated), cost,
3. expanded card: full turn report contents,
4. consecutive non-progress turns highlighted with warning color,
5. filter controls: by stage, by branch, by gate result.

**V6 Diagnostics** (on-demand, not default):

1. accessible from Turn Timeline or Mission Control via "Inspect" action,
2. per-turn tool call sequence with input/output, token consumption, wall-clock timing,
3. similar UX to browser DevTools Network panel,
4. LLM streaming text viewable here as opt-in, never shown by default in other views.

### 24.3 State-to-View Mapping

Runtime state transitions trigger specific UI behaviors:

| Runtime State | Primary UI Action |
|---|---|
| `IDLE` | show session start / goal input form |
| `PLANNING` | Mission Control: turn card shows "Planning turn N..." |
| `EXECUTING` | Mission Control: turn card live-updates (tool calls, elapsed time) |
| `TURN_COMPLETE` | Turn Timeline: new card appears; Mission Control: turn card resets |
| `WAITING_FOR_USER` + checkpoint | V4: full-width modal card; state badge orange pulsing |
| `WAITING_FOR_USER` + ask_user | V4: side panel dialog; state badge orange steady |
| `WAITING_EXTERNAL` | state badge blue; Mission Control shows wait-ticket summary card |
| `PAUSED` | state badge gray; all views read-only; resume button prominent |
| `COMPLETE` | state badge green (solid); Mission Control shows final summary card with coverage matrix link |
| `FAILED` | state badge red (solid); see 24.3.1 Failure View |
| `STOPPED` | state badge gray (solid); see 24.3.2 Stopped View |
| `CRASHED` | state badge red pulsing; on restart show crash-recovery card with last-good turn + recovery options |

### 24.3.1 Failure View (`FAILED`)

When the system enters `FAILED`, the user is most confused and needs the most guidance. Mission Control must show:

1. **failure reason card**: prominent, not dismissible, containing: failure category (budget exhausted / unrecoverable deadlock / gate failure cascade / runtime error), plain-language explanation, and the failing turn number with direct link,
2. **last turn diagnostics**: auto-expand the failing turn in Turn Timeline, showing full turn report + tool call sequence (V6 Diagnostics level, not hidden behind click),
3. **asset snapshot**: read-only view of all assets produced up to failure (Evidence Map remains browsable),
4. **recovery guidance**: contextual actions based on failure category — budget exhaustion offers "extend budget and retry"; gate failure cascade offers "enter scope negotiation"; runtime error offers "inspect and resume from last TURN_COMPLETE",
5. **session history**: full Turn Timeline and all views remain browsable (read-only) — user can trace the full path to failure.

### 24.3.2 Stopped View (`STOPPED`)

`STOPPED` is a user-initiated graceful halt. The session is valuable, not broken. Mission Control must show:

1. **stop reason card**: who stopped (user / budget deadline / deadlock exit), when, and at which turn/stage/branch,
2. **session summary**: total turns, assets created, coverage status, budget consumed, time elapsed,
3. **full history access**: all views (Turn Timeline, Evidence Map, Claim-Evidence Matrix) remain fully browsable — the session data is a research artifact,
4. **resume option**: if the session is resumable (not `COMPLETE` or `FAILED`), show a "Resume session" button that transitions back to `PLANNING`,
5. **export option**: option to export session summary, claim-evidence table, and asset inventory as a report.

### 24.4 IPC-to-UI Event Mapping

Push events from main process (Section 4.4) map to UI updates:

| IPC Event | UI Target |
|---|---|
| `yolo:state` | state badge update + state-to-view mapping trigger (24.3) |
| `yolo:turn-report` | Turn Timeline: append new card; Mission Control: update stage/coverage/budget |
| `yolo:question` | V4: render as modal card (checkpoint) or side panel (ask_user) based on `checkpoint` field |
| `yolo:event` | Mission Control: live-update current turn card; V6: append to diagnostics log |

### 24.5 Input Queue UI Contract

1. input queue is always visible as a collapsible panel (badge shows count),
2. each queued item shows: text preview, priority (urgent/normal), creation time, estimated processing turn,
3. user can: reorder items, change priority, cancel pending items,
4. merged items show "processed in turn N" with link to turn report,
5. visual feedback: "This message will be processed at the next turn boundary" (not immediate).

### 24.6 Budget Dashboard Contract

Session budget is a first-class UI element on Mission Control:

1. token usage: prompt tokens used / remaining, completion tokens used / remaining, total tokens used / remaining,
2. cost: USD spent / cap,
3. turns: elapsed / max,
4. wall-clock: elapsed / deadline,
5. burn rate: tokens/turn trend (last 5 turns), cost/turn trend,
6. budget alerts: warning at 80%, critical at 95%, degradation ladder active indicator.

### 24.7 Phased UI Delivery

| Phase | Views Available |
|---|---|
| P0 | Mission Control (simplified: no coverage indicator, no budget trends) + Turn Timeline + Checkpoint Dialog (3 views) |
| P1 | + Branch Explorer + Evidence Map + Claim-Evidence Matrix + full Mission Control (5 views) |
| P2 | + Diagnostics + full Budget Dashboard with trends + system notification support for long-running sessions (6 views) |

P0 has three views. Branch Explorer is deferred to P1 because in P0's degenerate single-branch mode it would duplicate Turn Timeline with no additional information value.

### 24.8 Anti-Patterns

1. **do not build a chat interface**: user-system interaction is structured (checkpoints, queue, cards), not conversational,
2. **do not stream LLM output by default**: results and decisions matter, not thinking process; streaming is opt-in in Diagnostics view only,
3. **do not display subjective quality scores**: coverage metrics (structural) are fine; "research quality: 87/100" is not — the system explicitly avoids numeric scoring for scientific direction (Section 2.2),
4. **do not show every tool call in Mission Control**: tool-level detail belongs in Diagnostics; Mission Control shows turn-level summaries only,
5. **do not use dismissible toast notifications for checkpoints**: checkpoint decisions are irreversible research commitments and require modal interaction.
