# RFC-011: AgentFoundry V2 Full Rewrite  
## Unified Long-Horizon Context, Memory, and Execution Kernel

**Status**: Draft (Full Rewrite Proposal)  
**Author**: AgentFoundry Team  
**Created**: 2026-02-06  
**Updated**: 2026-02-06

---

## 1. Executive Decision

AgentFoundry will perform a **full architectural rewrite** of context and memory runtime in V2.

This RFC does **not** patch the current architecture.  
This RFC defines a new kernel that replaces the current multi-path design with a single coherent model:

1. One context assembler
2. One budget planner
3. One memory write gate
4. One compaction engine with replay guarantees
5. One task-state anchor contract

The existing V1 subsystems remain only as migration sources.

---

## 2. Why Full Rewrite

Current V1 behavior works but carries high structural complexity:

- Dual budgeting logic (`BudgetCoordinator` and loop-level message compaction)
- Dual short-memory surfaces (`state-summary phase` and runtime findings summarizer)
- Split history handling across session/index/expand paths
- Overlapping concepts (`project-cards`, `workingset`, selected context, app-level working set)
- Context behavior difficult to reason about, test, and guarantee

For long-horizon projects (weeks/months), V1 has high risk of:

- silent recent-turn loss under pressure
- context drift from inconsistent objective anchoring
- difficult debugging due to multiple competing mechanisms

---

## 3. Scope

## 3.1 In Scope

- New V2 runtime kernel for context, memory, task state, and compaction
- New canonical storage contracts and replay guarantees
- Unified context-budget algorithm with protected zones
- Unified memory formation and update policy
- Unified telemetry model for non-debug operation

## 3.2 Out of Scope

- New UI features
- New external vector database dependency requirement
- Full graph-memory engine in V2.0

---

## 4. Design Goals

1. **Deterministic reasoning path**: one way to build context.
2. **Recent-turn guarantees**: protected window is non-negotiable.
3. **Loss-aware compression**: never lose replay keys.
4. **Long-term stability**: predictable token use and reduced drift.
5. **Operational clarity**: minimal but always-on observability.
6. **File authority**: canonical truth remains versionable on disk.

---

## 5. Core Principles

1. Recent turns are sacred.
2. Files are truth; indexes are acceleration.
3. Compress content, never erase references.
4. Load minimal high-signal context first.
5. Keep active objective in tail attention zone.
6. Memory writes must be gated, auditable, and reversible.

---

## 6. V1 to V2 Replacement Matrix

| V1 Surface | V2 Replacement | Action |
|---|---|---|
| `createContextPipeline` phases | `ContextAssemblerV2` | Replace |
| `BudgetCoordinator` + loop budget manager | `BudgetPlannerV2` | Replace |
| `state-summary phase` + `StateSummarizer` | `MemorySynthesizerV2` + `MemoryWriteGateV2` | Replace |
| `session phase` + `index phase` + `ctx-expand` coupling | `HistoryEngineV2` + `ReplayServiceV2` | Replace |
| `project-cards` vs `workingset` split semantics | `MemoryStoreV2` typed cards + `ArtifactStoreV2` evidence refs | Replace |
| app-level ad hoc working-set memory | canonical `TaskStoreV2` + `MemoryStoreV2` | Replace |

---

## 7. V2 Architecture

```text
                        ┌──────────────────────────┐
User Turn  ───────────▶ │   AgentLoopV2            │
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │ ContextAssemblerV2       │
                        │ - ProtectedTurnsZone     │
                        │ - TaskTailAnchor         │
                        │ - MemoryCards            │
                        │ - EvidenceCards (JIT)    │
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │ BudgetPlannerV2          │
                        │ (single budget authority)│
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │ Tool/LLM Execution       │
                        └────────────┬─────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
       ┌──────────────────────────┐      ┌──────────────────────────┐
       │ MemoryWriteGateV2        │      │ CompactionEngineV2       │
       │ (add/update/supersede)   │      │ (pre-flush + replay-safe)│
       └────────────┬─────────────┘      └────────────┬─────────────┘
                    ▼                                 ▼
       ┌──────────────────────────┐      ┌──────────────────────────┐
       │ MemoryStoreV2            │      │ HistoryStoreV2           │
       │ (facts/cards/index refs) │      │ (turns/segments/replay)  │
       └──────────────────────────┘      └──────────────────────────┘
```

---

## 8. Storage Model

V2 standardizes on typed records persisted on disk.

## 8.1 Canonical Stores

1. `HistoryStoreV2` (conversation turns + compact segments)
2. `ProjectStoreV2` (project registry + session-to-project bindings)
3. `TaskStoreV2` (project/task-scoped progress state, not session-only)
4. `SessionContinuityStoreV2` (session summaries and handoff records)
5. `MemoryStoreV2` (durable facts/cards with lifecycle states)
6. `ArtifactStoreV2` (documents/tool outputs with stable refs)
7. `IndexStoreV2` (vector/BM25/keyword structures, rebuildable)

## 8.2 Record Types

### TurnRecord

```json
{
  "id": "turn_...",
  "sessionId": "sess_...",
  "index": 128,
  "role": "user|assistant|tool",
  "content": "...",
  "toolCalls": [],
  "createdAt": "ISO8601"
}
```

### TaskState

```json
{
  "taskId": "task_...",
  "projectId": "proj_...",
  "status": "pending|in_progress|blocked|done",
  "currentGoal": "...",
  "nowDoing": "...",
  "blockedBy": [],
  "nextAction": "...",
  "lastSessionId": "sess_...",
  "updatedAt": "ISO8601"
}
```

### ProjectRecord

```json
{
  "projectId": "proj_...",
  "name": "agentfoundry-core",
  "rootPath": "/workspace/agentfoundry",
  "detectionStrategy": "explicit|path-based|first-goal",
  "status": "registered|archived",
  "defaultForWorkspace": false,
  "updatedAt": "ISO8601"
}
```

### ContinuityRecord

```json
{
  "id": "cont_...",
  "projectId": "proj_...",
  "sessionId": "sess_...",
  "summary": "...",
  "activeTaskIds": ["task_..."],
  "carryOverNextActions": ["..."],
  "knownBlockers": ["..."],
  "createdAt": "ISO8601"
}
```

### DailySummaryIndexRecord (Optional)

```json
{
  "id": "daily_idx_...",
  "projectId": "proj_...",
  "date": "YYYY-MM-DD",
  "path": "continuity/projects/<projectId>/daily/<YYYY-MM-DD>.md",
  "sessionIds": ["sess_..."],
  "summary": "...",
  "keyDecisions": ["..."],
  "openItems": ["..."],
  "createdAt": "ISO8601"
}
```

### MemoryFact

```json
{
  "id": "mem_...",
  "namespace": "user|project|session|task",
  "key": "architecture.auth.strategy",
  "value": {},
  "valueText": "...",
  "status": "proposed|active|superseded|deprecated",
  "confidence": 0.91,
  "provenance": {
    "sourceType": "file|url|turn|tool",
    "sourceRef": "docs/arch.md#auth|https://...|turn_...",
    "traceId": "..."
  },
  "updatedAt": "ISO8601"
}
```

### ArtifactRecord

```json
{
  "id": "art_...",
  "projectId": "proj_...",
  "type": "document|tool-output|file-snapshot|web-content",
  "path": "artifacts/blobs/...",
  "mimeType": "text/markdown",
  "summary": "...",
  "sourceRef": "turn_...|tool_...|url_...",
  "createdAt": "ISO8601"
}
```

### CompactSegment

```json
{
  "id": "seg_...",
  "sessionId": "sess_...",
  "turnRange": [1, 74],
  "summary": "...",
  "replayRefs": [
    { "type": "path", "value": "notes/plan.md#phase-2" },
    { "type": "url", "value": "https://..." },
    { "type": "id", "value": "entity_..." }
  ],
  "createdAt": "ISO8601"
}
```

## 8.3 Filesystem Layout (Authoritative)

```text
.agent-foundry-v2/
  history/
    sessions/<sessionId>/turns.jsonl
    sessions/<sessionId>/segments.jsonl
  projects/
    registry.jsonl
    session-bindings/<sessionId>.json
  tasks/
    projects/<projectId>/tasks.jsonl
  continuity/
    projects/<projectId>/sessions/<sessionId>.json
    projects/<projectId>/daily/<YYYY-MM-DD>.md
    projects/<projectId>/daily/index.jsonl
  memory/
    facts.jsonl
    cards.jsonl
    archive.jsonl
  artifacts/
    refs.jsonl
    blobs/...
  index/
    keyword.json
    vector/
```

Notes:

- `history/projects/tasks/continuity/memory/artifacts` are authoritative.
- `continuity/projects/*/daily/*.md` is authoritative when daily aggregation is enabled.
- `index/*` is non-authoritative and rebuildable.

---

## 9. Runtime Lifecycle

## 9.1 Session Start (Continuity Hydration)

On new session start:

1. Resolve active project through `ProjectResolverV2`.
2. Load active tasks for current project from `TaskStoreV2`.
3. Load previous-session handoff summaries from `SessionContinuityStoreV2` (default: last 2 sessions).
4. Load high-priority durable memory cards.
5. Build initial continuity context block before first user turn.

## 9.2 User Experience Flow (Day 1 and Continuation)

Day 1 in a new project:

- No prior continuity records exist.
- Runtime creates initial project/task shells after project resolution and goal qualification.
- User sees normal agent behavior, but future continuity artifacts begin immediately.

Returning in a later session:

- Runtime injects concise carry-over block: active tasks, last checkpoint, known blockers, next action.
- Last session summary is loaded before first assistant response.
- User can continue without manually restating project history.

Interrupted work (session crash/stop):

- Persisted turns and task state remain authoritative.
- Next session reconstructs status from `TaskStoreV2` + `SessionContinuityStoreV2`.
- Missing in-memory-only details are treated as non-durable and not assumed.

## 9.3 Per Turn

For each user turn:

1. Persist user turn in `HistoryStoreV2`.
2. Resolve task state and build tail anchor block.
3. Retrieve candidate memory/evidence cards (JIT candidate set only).
4. Build context through `ContextAssemblerV2`.
5. Enforce budgets via `BudgetPlannerV2`.
6. Execute LLM+tools in `AgentLoopV2`.
7. Persist assistant/tool turns.
8. Run `MemoryWriteGateV2` for durable updates.
9. Evaluate compaction threshold.
10. If threshold reached: run `PreCompactionFlush` then `CompactionEngineV2`.

## 9.4 Project Resolution and Multi-Project Routing

`ProjectResolverV2` supports three strategies:

- `explicit`: project must be selected by command/UI selection.
- `path-based`: infer from workspace root markers (default), such as `.git`, `package.json`, `pyproject.toml`.
- `first-goal`: infer from first qualified goal when explicit/path signals are absent.

Goal qualification for `first-goal`:

- message contains an action intent (`build|fix|migrate|design|analyze`)
- message references a concrete scope (`module|repo area|artifact`)
- message implies an outcome or completion signal

Multi-project behavior:

- multiple registered projects may coexist in one workspace
- each session has one `activeProjectId` binding at a time (`projects/session-bindings/<sessionId>.json`)
- command layer exposes `/project switch <name|id>` to rebind subsequent turns
- project switch writes a continuity checkpoint before rebind

---

## 10. Context Assembly Contract

`ContextAssemblerV2` is the only component allowed to produce prompt context.

## 10.1 Fixed Zones (ordered)

1. System identity + constraints
2. Tool schemas
3. Memory cards (project/user/task facts)
4. Evidence cards (retrieved summaries)
5. Non-protected historical turns (older conversational context, optional)
6. Optional expansion payloads (explicit user/tool request)
7. **Protected Recent Turns Zone**
8. **Tail Task Anchor**

## 10.2 Turn Definition

In V2, one logical "turn" is:

- one user message
- all assistant/tool messages until the next user message

Protected zones are computed over complete logical turns.

## 10.3 Protected Recent Turns Zone

- Preserve last `K` complete user turns (`K=3` default).
- Turn-boundary aware; no mid-turn cutting.
- By default, tool messages in protected turns are included.
- Non-prunable unless `FailSafeMode` is activated.

## 10.4 Tail Task Anchor

Always appended near prompt tail:

```text
## Task Anchor
CurrentGoal: ...
NowDoing: ...
BlockedBy: ...
NextAction: ...
```

## 10.5 Fail-Safe Mode

`FailSafeMode` is an emergency budget path and is disabled by default.

Trigger:

- only when required slots cannot fit (`output reserve + fixed costs + minimum protected turns + task anchor > context window`)
- or repeated model hard-limit rejection after one normal degradation pass

Behavior:

- may reduce protected turns from `K` down to `1` temporarily
- never drops the most recent complete logical turn
- emits telemetry on enter/exit and records reason

Exit:

- automatically exit when normal budget fit is restored

---

## 11. Budget Planner V2

Single budget authority across assembly and loop.

## 11.1 Inputs

- model context window
- fixed cost estimates (system/tools)
- protected zone requirements
- output reserve policy

## 11.2 Slot Allocation (default order)

1. output reserve
2. fixed costs
3. memory cards
4. evidence cards
5. optional expansions
6. protected turns
7. task anchor

Slot allocation order follows prompt zone order defined in `10.1`.
Planner must pre-reserve minimum tokens for protected turns and task anchor before allocating optional expansions.

## 11.3 Degradation Order

When over budget, degrade in this exact order:

1. optional expansions
2. evidence detail level
3. memory detail level
4. non-protected old turns

Never degrade:

- protected turns (except `FailSafeMode`)
- task anchor

---

## 12. Memory Formation and Update

V2 introduces `MemoryWriteGateV2` as the only writer for durable facts.

## 12.1 Pipeline

Input:

- latest turn exchange
- current task anchor
- selected evidence refs
- existing facts for relevant keys (retrieved by `namespace/key` prefix and exact-key lookup)

Steps:

1. extract candidate facts
2. normalize to canonical `namespace/key` schema
3. retrieve existing facts for each candidate key
4. apply deterministic action: `PUT | REPLACE | SUPERSEDE | IGNORE`
5. persist with required provenance

## 12.2 Conflict Policy

- no semantic nearest-neighbor merge in V2 core
- updates are key-based (`namespace + key`)
- contradiction on the same key marks previous value as `superseded`
- delete requires explicit user/tool intent (no autonomous delete)
- all versions remain auditable
- semantic consolidation is allowed only in offline lifecycle jobs (see 12.4)

## 12.3 Activation Policy

Defaults:

- user-confirmed or tool-verified writes -> `active`
- model-inferred writes -> `proposed`
- promotion from `proposed` to `active` requires confirmation or repeated supporting evidence

## 12.4 Memory Lifecycle (Consolidation, Decay, Archive)

To avoid unbounded growth, V2 adds a maintenance lifecycle outside the online turn path.

Consolidation:

- trigger: `weekly` or explicit on-demand maintenance
- strategy modes: `key-prefix-group` (default) or `llm-merge` (optional, guarded)
- scope: key-prefix groups and exact semantic duplicates
- output: canonical fact retained, redundant facts marked `superseded` with backlinks

Decay:

- facts not retrieved or referenced beyond threshold are marked `deprecated`
- default threshold: 90 days without access or update

Archive:

- deprecated facts may move to cold storage index while staying replayable
- archived facts are excluded from default prompt injection unless explicitly requested

## 12.5 Memory Write Rate Limiting

`MemoryWriteGateV2` enforces bounded write throughput to protect storage and index resources.
Gate enforcement is mandatory in V2 core.

Limits:

- per turn normal-write cap (default: 20 accepted writes, excludes pre-flush reserve writes)
- per session write cap (default: 500 accepted writes)
- writes beyond caps are rejected with `rate_limited` reason and telemetry

Policy:

- priority order under pressure: `active` writes > `proposed` writes
- allow explicit user override command for a single turn (audited)
- never bypass provenance checks even when override is used
- pre-compaction writes follow `13.5` interaction policy

---

## 13. Compaction Engine V2

Compaction is replay-safe and pre-flush aware.

## 13.1 Trigger

`promptTokens > contextWindow - reserveFloor - softThreshold`

## 13.2 Pre-Compaction Flush

Before compaction:

1. execute one silent preservation turn
2. prompt model to store durable memories now
3. persist through `MemoryWriteGateV2`

Execution contract:

- blocking operation (must finish before compaction decision continues)
- timeout default: `10000ms`
- timeout fallback: `skip` (continue compaction without preflush writes)
- no-op allowed: model may return no durable writes
- writes still pass full `MemoryWriteGateV2` validation and provenance requirements

Default preservation prompt (system):

`Context nearing compaction. Save only durable, high-signal facts and task updates now. Ignore transient details.`

## 13.3 Segment Compaction

- compact oldest non-protected turn ranges into `CompactSegment`
- keep summary + `replayRefs`
- store mapping turnRange -> segment id

## 13.4 Replay Guarantees

Every compacted segment must retain at least one stable reference for source recovery:

- `path`
- `url`
- `id`

Segments failing this contract are rejected.

## 13.5 Pre-Flush and Write-Limit Interaction

To avoid double-write ambiguity and accidental loss under pressure:

- pre-flush writes count toward session cap
- pre-flush writes use dedicated reserve (`preFlush.writeReserve`, default `5`) and do not consume normal per-turn cap
- when pre-flush and same-turn write gate target same `namespace/key`, runtime deduplicates to one persisted write by deterministic precedence:
  1. validated user/tool-backed write
  2. higher confidence write
  3. latest timestamp
- if session cap is exhausted, pre-flush writes are rejected with `rate_limited_preflush`

---

## 14. Retrieval Model (Hybrid, Rebuildable)

`RetrieverV2` uses hybrid retrieval:

- lexical/keyword (BM25-like)
- vector similarity (if enabled)
- recency and diversity re-ranking

Indexes are optional accelerators.  
If primary retrieval path is unavailable, runtime follows fallback chain in `14.1`.

## 14.1 Fallback Chain and Guardrails

Fallback order:

1. `hybrid` (lexical + vector + rerank)
2. `lexical`
3. `vector-only` (if lexical index unavailable but vector index exists)
4. `raw-file-scan` (bounded, authoritative-file scan)

Raw scan guardrail:

- hard cap on scan payload (`10000` tokens default)
- prefer targeted paths from replay refs before global scan
- if cap exceeded, return partial results + truncation metadata

---

## 15. Tool Result Handling and Error Retention

V2 retains bounded failure context to reduce repeated mistakes while controlling token cost.

## 15.1 Failure Signature Schema

```json
{
  "id": "fail_...",
  "sessionId": "sess_...",
  "projectId": "proj_...",
  "tool": "bash",
  "errorType": "ExitCodeNonZero|Timeout|ValidationError|PermissionError|Unknown",
  "normalizedMessage": "npm install failed with ERESOLVE",
  "paramHash": "sha256:...",
  "attemptCount": 3,
  "firstSeenAt": "ISO8601",
  "lastSeenAt": "ISO8601",
  "lastOutcome": "failed|recovered"
}
```

## 15.2 Retention Policy

- Keep at most 10 unique failure signatures per session.
- Persist top 5 cross-session signatures per project (ranked by `attemptCount` and recency).
- On successful execution of the same `tool + paramHash`, mark signature as `recovered` and decay `attemptCount`.
- Expire recovered signatures after configurable TTL.

## 15.3 Injection Rule

- Before a tool call, runtime checks for matching recent failure signatures on same tool and similar params.
- If match exists, inject compact caution note into context with prior failure and suggested parameter change.
- Runtime should prefer parameter adjustments over blind retries.

This preserves actionable failure memory without carrying full raw logs in prompt history.

---

## 16. Observability (Always On)

Non-debug baseline telemetry events:

- `context.protected_zone.kept`
- `context.protected_zone.dropped`
- `context.degradation.applied`
- `context.failsafe.{entered|exited}`
- `memory.writegate.action.{add|update|supersede|ignore}`
- `memory.writegate.rate_limited`
- `memory.writegate.rate_limited_preflush`
- `compaction.preflush.triggered`
- `compaction.segment.created`
- `compaction.replay_contract.failed`
- `storage.integrity.check.{ok|failed}`
- `storage.recovery.applied`
- `retrieval.hybrid.stats`
- `task.anchor.injected`

Required metrics:

- recent-turn miss rate
- compaction-boundary loss rate
- replay success rate
- P95 prompt tokens
- goal drift incidence

---

## 17. Configuration Model

```yaml
kernelV2:
  enabled: true
  project:
    autoDetection:
      strategy: "path-based"
      fallbackStrategy: "first-goal"
      pathPatterns: [".git", "package.json", "pyproject.toml"]
    multiProject:
      enabled: true
      switchCommand: "/project switch <name|id>"
  continuity:
    injectPreviousSessionSummary: true
    maxPreviousSessions: 2
    injectActiveTasks: true
    dailyAggregation:
      enabled: false
      generateDailySummary: true
  context:
    protectedRecentTurns: 3
    protectedMinTokens: 1200
    includeToolMessagesInProtectedZone: true
    tailTaskAnchor: true
  budget:
    reserveOutput:
      intermediate: 4096
      final: 8192
    softThreshold: 0.82
  memory:
    writeGate:
      enforced: true # V2 invariant, must not be false
      maxWritesPerTurn: 20
      maxWritesPerSession: 500
    activationMode: source_based
    semanticMergeInCore: false
    lifecycle:
      consolidation:
        enabled: true
        trigger: "weekly"
        strategy: "key-prefix-group" # or "llm-merge"
      decay:
        enabled: true
        unusedThresholdDays: 90
        action: "deprecate"
      archive:
        enabled: true
        coldStore: "memory/archive.jsonl"
  compaction:
    enabled: true
    preFlush:
      enabled: true
      timeoutMs: 10000
      fallbackOnTimeout: "skip"
      allowNoOp: true
      writeReserve: 5
      promptTemplate: "Context nearing compaction. Save only durable, high-signal facts and task updates now. Ignore transient details."
    requireReplayRefs: true
  errorRetention:
    enabled: true
    maxPerSession: 10
    maxCrossSession: 5
    recoveredTtlDays: 14
  retrieval:
    hybrid: true
    vectorWeight: 0.7
    lexicalWeight: 0.3
    fallbackChain: ["hybrid", "lexical", "vector-only", "raw-file-scan"]
    rawScanLimitTokens: 10000
  telemetry:
    baselineAlwaysOn: true
  storage:
    integrity:
      verifyOnStartup: true
      checksum: "optional-jsonl-footer"
    recovery:
      autoTruncateToLastValidRecord: true
      createRecoverySnapshot: true
```

---

## 18. API and Developer Surface Changes

## 18.1 New Core Interfaces

- `createKernelV2(config): KernelV2`
- `kernel.runTurn(input, options): TurnResult`
- `kernel.replay(ref): ReplayPayload`
- `kernel.getTaskState(projectId, taskId): TaskState`
- `kernel.listActiveTasks(projectId): TaskState[]`
- `kernel.getSessionContinuity(projectId, sessionId): ContinuityRecord`
- `kernel.resolveProject(input): ProjectRef`
- `kernel.switchProject(projectId): void`
- `kernel.runMemoryLifecycle(projectId, mode): LifecycleReport`
- `kernel.verifyIntegrity(scope?): IntegrityReport`

## 18.2 Core DTO Contracts

`IntegrityReport`:

```json
{
  "ok": false,
  "checkedAt": "ISO8601",
  "scope": "workspace|project|file",
  "issues": [
    {
      "path": ".agent-foundry-v2/history/sessions/sess_1/turns.jsonl",
      "failureType": "invalid_jsonl|checksum_mismatch|missing_file",
      "lastValidOffset": 18273
    }
  ]
}
```

`LifecycleReport`:

```json
{
  "projectId": "proj_...",
  "mode": "weekly|on-demand",
  "startedAt": "ISO8601",
  "finishedAt": "ISO8601",
  "consolidated": 42,
  "deprecated": 17,
  "archived": 9,
  "errors": []
}
```

## 18.3 Deprecated V1 Surfaces

- phase registration via old context pipeline APIs
- dual budget controllers
- direct writes to durable memory bypassing write gate

## 18.4 Tooling Impact

- Existing tools remain callable.
- Internal runtime wiring changes only.
- `ctx-expand` semantics migrate to `ReplayServiceV2` while preserving compatibility facade.

---

## 19. Migration Strategy

Even with full rewrite, data migration is required.

## 19.1 One-Time Migration Inputs

- V1 message stores
- V1 memory items
- V1 project cards / working set artifacts

## 19.2 Migration Output

- normalized `TurnRecord`
- normalized `MemoryFact` with status/provenance
- synthesized initial `TaskState` (best effort)
- synthesized `ContinuityRecord` from last session snapshot (best effort)
- optional synthesized daily markdown + `DailySummaryIndexRecord` for recent days (if daily aggregation enabled)

## 19.3 Compatibility Policy

- No mixed runtime mode within one session.
- Session starts on V1 or V2, never both.
- Migration runs before first V2 session in a workspace.

## 19.4 Recovery Strategy

V2 defines a recoverable storage contract for `.agent-foundry-v2/`.

Integrity verification:

- optional checksum markers for JSONL segments/files
- startup and on-demand integrity scan (`kernel.verifyIntegrity`)
- report includes file path, failure type, and last valid offset

Partial corruption recovery:

- truncate to last valid JSONL record boundary
- rebuild non-authoritative indexes from authoritative stores
- preserve recovery audit record with before/after metadata

Backup and restore:

- create snapshot before destructive recovery operations
- allow restore from latest valid snapshot + replay from durable logs
- expose recovery status through telemetry and CLI/status surface

---

## 20. Risks and Mitigations

### Risk 1: Rewrite complexity and schedule slip

Mitigation:

- strict kernel boundaries
- deterministic interfaces
- end-to-end regression gates before app integration

### Risk 2: Behavior regressions in long sessions

Mitigation:

- dedicated 30/60/90-day synthetic replay tests
- frozen benchmark conversations for parity checks

### Risk 3: Higher token usage from protection zones

Mitigation:

- enforce degradation order on non-protected zones
- tune protected min tokens by model/window profile

### Risk 4: Memory pollution from over-writing

Mitigation:

- key-based deterministic updates only
- model-inferred writes start as `proposed`
- provenance required for all durable writes

---

## 21. Acceptance Criteria

V2 is accepted only if all criteria pass:

1. Protected zone invariant: last `K` turns always present in assembled context.
2. Replay invariant: every compacted segment is recoverable through reference keys.
3. Budget invariant: no dual budget decisions in runtime path.
4. Memory invariant: all durable writes pass through write gate.
5. Continuity invariant: resumed sessions inject prior checkpoint and active tasks before first assistant response.
6. Lifecycle invariant: memory maintenance can consolidate/decay/archive without losing replayability.
7. Retrieval invariant: fallback chain reaches a bounded result path even when indexes are unavailable.
8. Write safety invariant: per-turn normal-write caps, pre-flush reserve caps, and per-session caps are enforced with auditable overrides only.
9. Storage integrity invariant: startup integrity verification and corruption recovery path are executable.
10. Stability metrics:
   - recent-turn miss rate < 1%
   - replay success rate > 99%
   - compaction-boundary loss incidents = 0 in benchmark suite
   - P95 token variance reduced vs V1 baseline

---

## 22. Open Questions

1. Default protected-zone size per model family/context window.
2. Whether project auto-detection should prefer `explicit` in enterprise/multi-repo workspaces.
3. Whether to expose replay references directly in UI or keep runtime-only.
4. Whether `TaskState` should be user-editable via command layer.

---

## 23. References (Design Inputs)

- OpenClaw: compaction, pruning, memory layering, JIT context patterns
- Manus: long-horizon agent behavior, task anchoring, sandbox lifecycle concepts
