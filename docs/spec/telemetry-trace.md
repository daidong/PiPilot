# Telemetry & Trace: Objective Runtime Data Capture

> Spec version: 0.5 (draft) | Last updated: 2026-05-04 | Status: PROPOSAL — NOT IMPLEMENTED
>
> **Changelog v0.4 → v0.5** (simplification):
>
> - **Retention configurability removed.** All telemetry data — traces, blobs, digest, ledgers — is retained **forever** by default and is not user-configurable. Project deletion is the only purge mechanism. This drops: the `7-days | 1-month | forever` picker, three retention dimensions (`rawTraceRetention` / `blobRetention` / `metadataRetention`), the eviction sweep, the "Compact telemetry" action, and most of the retention-coupling discussion. Storage estimates in §5.6 still apply — users see them as informational, not configurable.
> - Project-scoped settings reduced to two fields: `privacy` (still needed; per-project privacy profile cannot be global) and `tracingMode: 'enabled' | 'disabled'` (single switch — opt-out only, no granularity).
> - Removed §11.5 (storage stats fallback to compaction) since there's no compaction.
> - §13.1 tension #4 (digest under retention downgrade) deleted — the scenario no longer exists.
>
> **Changelog v0.3 → v0.4** (audit fixes; design boundary unchanged):
>
> - **OTel correctness (audit #1)**: `project.id`, `session.id`, `privacy.profile` moved from per-process Resource attributes to span attributes. Resource now only carries app/process/build identity (per OTel spec — Resource is process-life immutable). Wiki background agent (`app/src/main/ipc.ts:917`) and any code that crosses project boundaries now demonstrably correct.
> - **OTel correctness (audit #2)**: local-compute async run is now a **separate trace** with an OTel `Link { type: "follows_from" }` back to the submit span. Reusing a `traceId` with `parentSpanId = null` is invalid per OTel spec.
> - **OTel correctness (audit #6)**: GenAI fields updated to current semconv — `gen_ai.provider.name` (was `gen_ai.system`), `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` (were `_input_tokens` suffix), `gen_ai.client.inference.operation.details` event (replaces per-message events). `schema_url` pinned in §6.3 with schema-conformance tests required at P0 gate.
> - **Retention contract (audit #3)**: split into three independent dimensions — `rawTraceRetention`, `blobRetention`, `metadataRetention` (digest + ledgers). Defaults all `forever`. Removes contradictions about what survives eviction.
> - **Project-scoped settings (audit #4)**: telemetry settings live in `ProjectConfig` (`lib/types.ts`), **not** global `AppSettings`. New §10.2 specifies project config migration, project-scoped IPC, and UI surface.
> - **turnId implementability (audit #5)**: renderer's existing chat-message id is now passed in the `agent:send` IPC envelope as `clientMessageId` + `clientTimestamp`. `turnId = clientMessageId` becomes deterministic across renderer / main / ledgers.
> - **Local exporter resilience (audit #7)**: §5.1 specifies bounded queue (default 1024 spans), drop policy with counter, disk-full graceful degrade, writer-crash isolation, runtime disable toggle. Sync flush only at shutdown.
> - **Artifact reality (audit #8)**: §2.1 + §8.1 corrected — current artifact store is per-file JSON, not JSONL. Migration is non-trivial; P1 introduces `artifacts/ledger.jsonl` as a new append-only event log alongside the existing per-file storage (which remains the read-side authority).
> - **Trace closure semantics (audit #9)**: §5.5 + §6.5 define trace closure via root-span end event + active-child refcount + watchdog timeout for background spans. Background tasks (memory extract, wiki bg) become detached spans on their own trace, joined to the originating trace by `Link { type: "spawned_from" }`.
>
> v0.3 boundary intact: Layer 3 (subjective analysis) remains out of scope. No `Paper 1`-specific content anywhere in this file.

---

## 0. Boundary Declaration (read this first)

This spec defines **two layers** of data that PiPilot collects:

- **Layer 1 — Trace**: per-operation OpenTelemetry spans (LLM call, tool call, compaction event, etc.).
- **Layer 2 — Ledgers**: entity-centric records (artifact versions, memory operations, raw user-response signals, view log).

Both layers capture **only objective, machine-observable facts**. The single test for inclusion in this spec is:

> **Can this field be produced deterministically from observable runtime events without human or LLM judgment?**

If yes → it may belong in Layer 1+2.
If no → it belongs in **Layer 3**, which is **outside this spec and outside PiPilot runtime**.

**Layer 3 (out of scope for this spec)**: post-hoc analysis that labels, classifies, or judges the Layer 1+2 data. Done by:

- Human annotators (researchers, RAs) with a codebook.
- LLM annotators (offline scripts that read the objective record and produce labels).

Layer 3 produces things like "this turn was a revision-request", "this anchor-fact went stale at turn 234", "the agent overstepped here", "role migrated from research-assistant to teaching-assistant in week 6". **PiPilot runtime never produces these labels and the user is never asked to provide them.**

This split serves both audiences:

- **Engineering** uses Layer 1+2 for debugging, performance analysis, regression detection, and user support.
- **Research** uses Layer 1+2 as the raw substrate, then runs Layer 3 annotation pipelines (separate codebase, separate tooling) to derive findings.

If research questions change, or new analyses are written, **Layer 1+2 does not change** — only the Layer 3 codebook does.

---

## 1. Goals and Non-Goals

### 1.1 Goals

1. **Complete objective capture of agent execution**: every LLM call (main + 8 sub-LLM blind spots), every tool call, every artifact / memory operation, every compaction event, every user input boundary, every user passive view in the UI. Cover the full execution tree, not just surface symptoms.
2. **Standards-first portability**: emit OpenTelemetry-conformant traces so Langfuse, Phoenix, Tempo, Datadog, or any OTLP backend can consume our data without bespoke adapters.
3. **Long-horizon retention**: traces and ledgers retained forever, for the lifetime of the project. Project deletion is the only purge.
4. **Pluggable export**: local JSONL by default (zero-dep), OTLP endpoint behind an env flag, never block the agent on exporter failure.
5. **Privacy as a project-level contract**: redaction, blob retention, and export gating governed by a per-project privacy profile.

### 1.2 Non-Goals

- **Subjective labels**: no anchor-fact lifecycle, no repair classification, no role migration tagging, no `user_message_type` enum at runtime, no referring-expression counters, no project-type semantics. These are Layer 3 concerns.
- **User-driven labeling UX**: no thumbs-up/thumbs-down buttons designed to feed research, no "is this an anchor fact?" prompts, no taxonomy questionnaires. The user uses PiPilot normally; data accrues in the background.
- **Real-time alerting / SLO dashboards**: telemetry is for post-hoc analysis and developer debugging. No paging, no on-call.
- **Cross-user analytics**: each install is its own data plane. Cross-install aggregation is a Layer 3 problem.
- **Replacing domain stores**: `compute-store`, `entity-store`, `session-store`, etc. remain authoritative for their domains. Trace references them by ID, never replicates them.

### 1.3 Design axioms

Anchors all subsequent decisions. If a later section appears to violate these, it is wrong, not the axioms.

- **A1 — Trace ≠ Ledger.** Traces are time-line + causal structure. Ledgers are entity-keyed (artifact / memory / response-signal / view). Both retained per project policy. Layer 3 joins them by ID at analysis time.
- **A2 — Capture facts, not judgments.** Runtime records observable events (calls, tokens, status, hashes, raw user message metadata). Subjective labels (repair type, context staleness, trust, anchor-factness) are added in post-hoc Layer 3 annotation, not by the runtime.
- **A3 — OTel skeleton, PiPilot extensions.** Standard OTel GenAI conventions for portability. PiPilot-specific schema lives under `pipilot.*` namespace and never overloads standard fields.
- **A4 — Never block the agent.** Tracing failures (disk full, OTLP endpoint down, exporter bug) must degrade silently. The agent path tolerates trace loss; trace path tolerates agent abort.
- **A5 — Privacy is a project-level contract, not a per-span flag.** Privacy profile is configured once per project; per-span detectors only adjust redaction aggressiveness.
- **A6 — Minimum discipline for survival.** P0 freezes interfaces; P1+ fills coverage incrementally with evidence.
- **A7 — Layer 3 is not part of PiPilot.** Annotation tooling, codebooks, and analysis pipelines live in a separate research codebase. The runtime never depends on them.

---

## 2. Background: What We Already Have

This spec must build on existing infrastructure, not replace it. Inventory of reusable hooks:

### 2.1 Event sources already in place

| Source | File | What it gives us |
|---|---|---|
| `pi-agent-core` `AgentEvent` stream | subscribed at `lib/agents/coordinator.ts:635` | `agent_start/end`, `turn_start/end`, `message_*`, `tool_execution_*` |
| `beforeToolCall` / `afterToolCall` hooks | `lib/agents/coordinator.ts:612,619` | tool boundary with args/result/toolCallId |
| `transformContext` callback | `lib/agents/coordinator.ts:530` | compaction trigger + summarization input |
| Coordinator callbacks | `onStream/onToolCall/onToolResult/onToolProgress/onUsage/onSkillLoaded` | streamed back to renderer via IPC |
| `RealtimeBuffer` | `app/src/main/realtime-buffer.ts:41` | live push + remount-recovery snapshot for renderer stores |
| `RunStore` JSONL pattern | `lib/local-compute/run-store.ts` | atomic temp+rename, debounced flush, retention — **template only**, not direct reuse (§5) |
| Explain snapshot | `lib/agents/coordinator.ts:230,805–826` | per-`chat()` JSON dump (matched skills, budget) — proto-task-span; deprecated by trace (§6.6) |
| Artifact JSONL | `lib/memory-v2/store.ts` | upgraded to artifact ledger (§8.1) |
| Compute run ledger | `lib/local-compute/run-store.ts` | already long-running async records; integrates as §6.5 |
| `session.json` | `shared-electron/ipc-base.ts:260` | stable cross-process session id |
| `AppSettings.research` | `shared-ui/settings-types.ts:7` | precedent for the 3-option picker pattern adopted in §5.1 |

### 2.2 Sub-LLM blind spots (currently invisible)

These sites bypass `agent.subscribe`'s event stream and are the highest-value targets:

- `ResearchToolContext.callLlm` — `lib/agents/coordinator.ts:410`
- `ResearchToolContext.callLlmVision` — `lib/agents/coordinator.ts:425`
- `matchSkillsWithLLM` — `lib/agents/coordinator.ts:100`
- `maybeGenerateSummary` → `completeSimple` — `lib/agents/coordinator.ts:687`
- `transformContext` → `generateSummary` — `lib/agents/coordinator.ts:580`
- `maybeExtractMemories` — `lib/memory/extractor.ts:148`
- Wiki background agent — `app/src/main/ipc.ts:917`
- Diagram backend direct `fetch()` to OpenAI/Anthropic

All eight covered by a single `tracedCompleteSimple` helper plus closure-level wrappers for the two non-`completeSimple` cases.

### 2.3 Renderer stores already consuming events

`activity-store`, `tool-events-store`, `tool-progress-store`, `usage-store`, `progress-store`, `compute-store`. Post-P3 they become derived views over the trace stream; `compute-store` retains domain ownership of run records.

---

## 3. Architecture

### 3.1 Two layers in PiPilot, one outside

```
+--------------------------------------------------------------+
|  Layer 3: post-hoc analysis (OUTSIDE PiPilot)                |
|  - Human annotators with codebooks                           |
|  - LLM annotators (offline scripts)                          |
|  - Reads Layer 1+2; writes annotation files in a separate    |
|    research repo.                                            |
+----+----------------------+----------------------------------+
     ^                      ^
     | reads only           | reads only
     |                      |
+----+--------+    +--------+----------+
|  Layer 1:   |    |  Layer 2:         |
|  Trace      |    |  Ledgers          |
|  (OTel,     |    |  (entity-keyed,   |
|   per-op,   |    |   project-life,   |
|   retention |    |   versioned)      |
|   per       |    |                   |
|   policy)   |    |                   |
+----+--------+    +--------+----------+
     |                      |
     | spans / events       | rows
     |                      |
+----+----------------------+----------------------------------+
|  Instrumented runtime                                        |
|  - AsyncLocalStorage propagated TraceContext                 |
|  - tracedCompleteSimple, beforeToolCall/after, ALS wrap      |
|  - ledger writers in the same call path                      |
+--------------------------------------------------------------+
```

**Lifetimes:** all telemetry data — traces, blobs, digest, ledgers, tracing-state log — is retained **forever**. There is no automatic eviction, no retention picker, no compaction action. Project deletion is the only purge mechanism. v0.5 deliberately removed the configurable-retention machinery because it added project-config surface area for marginal benefit; storage estimates (§5.6) show typical totals are tractable on modern SSDs.

Resource attributes are per-process, immutable for the process lifetime, and carry only app/build identity (§5.4). Per-project state (project id, session id, privacy profile) lives on span attributes, not Resource.

### 3.2 Components added

| Component | Location | Responsibility |
|---|---|---|
| `Tracer` interface | `lib/telemetry/tracer.ts` | thin wrapper over `@opentelemetry/api`'s tracer; project-scoped |
| `TraceStore` | `lib/telemetry/trace-store.ts` | append-only JSONL writer; batched flush; retention sweep |
| `JsonlSpanExporter` | `lib/telemetry/exporters/jsonl.ts` | implements OTel `SpanExporter` writing OTLP/JSON wire format |
| `OtlpSpanExporter` | `lib/telemetry/exporters/otlp.ts` | gated by `RESEARCH_COPILOT_OTLP_ENDPOINT` |
| `tracedCompleteSimple` | `lib/telemetry/llm-trace.ts` | wraps `completeSimple` with span + redaction |
| Redaction pipeline | `lib/telemetry/redaction.ts` | shared by trace events and ledger writes |
| `LedgerWriter` (artifact / memory / response-signal / view) | `lib/ledger/*.ts` | each ledger isolated; writers idempotent on `(traceId, spanId, op)` |
| `pipilot.*` semantic registry | `lib/telemetry/semantic-registry.ts` | enumerates allowed namespaced attributes; validates in dev mode |

### 3.3 What `coordinator.ts` does *not* do

- Does **not** allocate `traceId`. (See §4.1.)
- Does **not** hold mutable trace state on `ResearchToolContext`. (See §4.2.)
- Does **not** classify user messages, count referring expressions, or judge anchor-factness. (Layer 3 concerns.)

---

## 4. Identity, Concurrency, Propagation

### 4.1 ID hierarchy

```
project.id               (span attribute on every span, from ProjectConfig.id)
  session.id             (span attribute gen_ai.conversation.id, from session.json)
    trace.id             (per agent:send IPC entry — one user task)
      root span: invoke_agent
        span: invoke_agent step      (per pi-agent-core turn_start..turn_end)
          span: chat {model}         (every LLM call, root or sub)
          span: execute_tool {name}  (every tool invocation)
            span: chat {model}       (sub-LLM inside the tool)
            span: execute_tool ...   (rare nested tool)
          span: summarize context    (compaction, when triggered)
          span: extract memory       (memory extractor, when triggered)
      [linked, separate root]
        span: execute_task local_compute  (long-running async run)
```

- `traceId` per user task, allocated at `agent:send` IPC entry.
- `session.id` is a **span attribute** on every span (`gen_ai.conversation.id`), not a Resource attribute. Cross-trace continuity is reconstructed at analysis time by joining on `gen_ai.conversation.id`.
- `project.id` is a **span attribute** on every span (`pipilot.project.id`), not a Resource attribute. The Electron main process can manage multiple projects/windows simultaneously and the wiki background agent walks across project paths (`app/src/main/ipc.ts:917`); per-process Resource attributes would be incorrect per OTel spec.
- `turnId = clientMessageId`: the renderer already mints a stable id for each user chat message (`app/src/renderer/stores/chat-store.ts:59`). v0.4 requires the renderer to forward this id (and a `clientTimestamp`) in the `agent:send` IPC envelope:
  ```typescript
  // app/src/preload/index.ts (proposed addition to chat:send)
  chatSend(args: {
    text: string,
    model?: string,
    images?: ImageAttachment[],
    clientMessageId: string,         // NEW — renderer's existing message id
    clientTimestamp: number,         // NEW — ms since epoch when user pressed send
  }): Promise<ChatResult>
  ```
  Main process uses `clientMessageId` verbatim as `turnId`. This is one input → one `turnId`, deterministic across renderer/main/ledgers. Existing renderer code keeps owning message id minting; main never re-generates.
  Assistant-only events (e.g., background memory-extract on its own trace per §6.5) carry `pipilot.turn.id = null` and reference the most recent prior turn via `pipilot.turn.followsId`.

### 4.2 Concurrent parent-child

Pi-agent-core parallelizes tool calls. A shared mutable "active span" would cross-link siblings. Solution:

- **Primary**: `AsyncLocalStorage<TraceContext>` via `@opentelemetry/context-async-hooks`'s `AsyncLocalStorageContextManager`.
- **Fallback**: `Map<toolCallId, TraceContext>` populated in `beforeToolCall`, drained in `afterToolCall`.
- **Explicit override**: `tracedCompleteSimple(model, req, opts, { parent: explicitCtx })` for cases like the wiki background agent where the natural async parent has already exited.

### 4.3 What we do not propagate

- Trace context does not cross IPC into the renderer at runtime. Renderer subscribes to a separate `trace:live` channel (§6.7); it does not produce spans.
- Trace context is not propagated to external HTTP requests by default.

---

## 5. Storage Model

### 5.1 Trace store: append-only, bounded resources

**Format**: `.research-pilot/traces/spans.{date}.jsonl`, one OTLP/JSON `ResourceSpans` envelope per line, batched.

**Write path** (audit #7 — bounded queue + drop policy):

1. Span ends → enqueue to in-memory bounded ring queue.
   - Default capacity: **1024 spans** (configurable per project).
   - Capacity is hard. When full, oldest queued span is dropped and a counter `pipilot.trace.dropped_spans` is incremented in `tracing-state.jsonl`.
2. Background flush worker drains queue when: queue ≥ 64 spans **or** 200 ms idle.
3. Append-only `write()`. No fsync per write; fsync at flush boundary.
4. **Disk full / write error**: writer enters degraded mode — sets `pipilot.trace.degraded = true` in tracing-state log, drops new spans (counted), retries write at exponential backoff (1s, 2s, 4s, max 60s). Agent path is never blocked. UI surfaces a banner when degraded.
5. **Writer crash isolation**: trace writer runs in the same process as agent (no separate worker process to keep complexity down), but is wrapped in `try { ... } catch (e) { logToTracingState(e); markDegraded(); }`. Trace-path exceptions never propagate to agent path.
6. **Runtime disable**: `tracingMode = disabled` in project config drains the queue and stops the flush worker; subsequent spans are no-op.
7. **Process exit**: synchronous `flushNow()` with 5-second timeout. Beyond timeout, remaining spans are dropped + counted.

**Indices** (rebuilt on startup if missing, atomic temp+rename): `traces/index.{date}.json` for fast viewer lookup.

**Retention**: forever. No eviction, no automatic cleanup, no compaction action. Daily JSONL files accumulate for the project's lifetime. Project deletion (user-initiated, removes the entire `.research-pilot/` directory) is the only purge.

**Project-scoped knobs** (configured in `ProjectConfig`, see §10.2):

```typescript
// lib/types.ts (proposed addition to ProjectConfig)
export interface ProjectTelemetryConfig {
  tracingMode: 'enabled' | 'disabled'           // default: 'enabled'; opt-out only
  bufferCapacity?: number                        // default: 1024 spans
}
```

`tracingMode = 'disabled'` drains the queue and stops the flush worker; subsequent spans are no-op. There is no separate retention setting because there is no retention policy to choose.

### 5.2 Ledgers: entity-keyed, append-only event logs

| Ledger | Path | Key | Status |
|---|---|---|---|
| Artifact | `artifacts/ledger.jsonl` | `(artifactId, version)` | **new file** alongside existing per-file artifact JSON (audit #8 — current store at `lib/memory-v2/store.ts:412` is one JSON per artifact, overwritten in place at `:473`; v0.4 does **not** convert that store. The new ledger is append-only and writes one row per op; the per-file artifact JSON remains the read-side authority for current content. P1 migration adds the ledger writes to the existing edit/create paths.) |
| Memory | `memory-v2/ledger.jsonl` | `memoryId` | **new file** alongside existing memory store; same pattern as artifact ledger |
| User-response signals | `user-response-signals.jsonl` | `(turnId)` | new (§8.3) |
| View log | `view-log.jsonl` | `(viewId)` | new (§8.4) |
| Tracing state | `tracing-state.jsonl` | append-only | audit log of mode/retention/policy changes + degraded-state events (§5.1, §10.1) |

All ledgers retained forever. Project deletion removes them.

**Cross-reference**: each ledger row records `{ traceId?, spanId?, turnId?, toolCallId? }` so analysis can join either direction.

**Idempotency**: ledger writers are idempotent on the natural key. Replays during crash recovery do not duplicate.

### 5.3 Content blobs

Large content (turn text > 4 KB, tool I/O over cap, diagram SVG, base64 images) is content-addressed:

- Stored once at `.research-pilot/blobs/{sha256}` (single file per hash).
- Referenced from spans / ledgers as `{ contentHash, size, redactionLevel }`.
- **Retention**: forever. Blobs are never auto-GC'd; project deletion removes them.
- `privacy.level = high`: blobs are written with `blobEncryption = at-rest` (libsodium secretstream, key in OS keychain) or not at all (`blobEncryption = none` rejected by the export gate as a configuration error).

### 5.4 Resource attributes (per-process, immutable for process life)

Per OTel Resource semantics ([OpenTelemetry Resource Data Model](https://opentelemetry.io/docs/specs/otel/resource/data-model/)), Resource attributes are constant for the process lifetime and describe the *producer* of telemetry. They must not vary by project or session, because the Electron main process can manage multiple projects and windows simultaneously.

**Resource attributes (set once at TraceProvider initialization):**

```
service.name = "research-copilot"
service.version = <app/package.json version>
service.instance.id = <ULID minted at process start>
process.runtime.name = "node"
process.runtime.version = <process.version>
os.type = <process.platform>
pipilot.runtime.app_build_commit = <git rev-parse HEAD at build time>
pipilot.runtime.system_prompt_hash = sha256(baseSystemPrompt)   // OK at Resource: same for process life
```

**Span attributes (varying per task / project / session — set on every applicable span):**

```
gen_ai.conversation.id     = <session.id>
pipilot.project.id         = <project.json id>
pipilot.project.tag        = <free-form user-provided tag, optional>
pipilot.project.privacy_profile = <low | medium | high>
pipilot.runtime.agent_profile   = <coordinator profile id; can vary across coordinators in one process>
pipilot.runtime.workspace_commit = <git rev-parse HEAD of workspace; per-project>
pipilot.runtime.memory_index_version = <wiki manifest version; per-project>
```

These are propagated automatically by `Tracer` when a span is created in a given project context. Wiki background agent and other multi-project code paths set the appropriate context per project; spans from each project carry the right project id. (This is exactly the bug audit #1 caught.)

`pipilot.project.tag` is an **optional, free-form** label. There is no enum, no fixed taxonomy. Layer 3 may classify projects post-hoc using its own scheme.

### 5.5 Trace digest (query acceleration)

Trace files are slow to scan for cross-task questions ("how did prompt length evolve over 3 months?"). Digest provides a one-row-per-trace pre-aggregate, kept alongside the raw trace.

**Path**: `.research-pilot/trace-digest.jsonl` (retained forever, alongside raw traces).

**Trace closure semantics (audit #9):** a digest row is materialized when the trace's root span ends **AND** its active descendant refcount reaches zero **OR** a watchdog timeout fires. Concretely:

- **Root span**: `invoke_agent {agent.name}` ends when `chat()` returns.
- **Active descendant refcount**: a per-trace counter incremented when a span starts under that trace, decremented when it ends. Background spawns that legitimately outlive the root (memory extract, wiki bg) **do not increment this counter** — they live on their own trace per §6.5.
- **Watchdog**: if the refcount hasn't reached zero 30 seconds after root end (e.g., a tool span never closed due to a bug), the digest is materialized with `digestClosureReason = 'watchdog_timeout'` and the un-closed spans are noted in `pipilot.trace.unclosed_span_ids`. The trace is still queryable; it's marked degraded.
- **Crash recovery**: on startup, TraceStore scans `traces/spans.{date}.jsonl` for traces whose root has ended but whose digest row is missing; replays digest materialization. Idempotent on `traceId`.

This avoids two failure modes: (a) digest written too early and missing real children; (b) digest never written because a fire-and-forget background task never returned.

**Schema** (one row per `traceId`, materialized when the trace's last span ends):

```jsonc
{
  "traceId": "...",
  "sessionId": "...",
  "projectId": "...",
  "startedAt": "...",
  "endedAt": "...",
  "durationMs": 0,
  "stepCount": 0,
  "toolCallsByCategory": { "literature": 3, "data-analysis": 1 },
  "subLlmCallsByPurpose": { "skill_router": 1, "memory_extract": 1 },
  "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0 },
  "compactionTriggered": false,
  "compactionDiscardedTurnIds": ["..."],
  "artifactOps": [{ "op": "edit", "artifactId": "...", "version": 7 }],
  "memoryOps": [{ "op": "retrieve", "memoryId": "...", "scope": "project" }],
  "matchedSkills": ["..."],
  "activeSkillsByStep": [{ "stepId": "...", "active": ["..."] }],
  "turns": [
    { "turnId": "...", "role": "user", "timestamp": "...", "charLen": 0, "contentHash": "sha256:..." }
  ],
  "steps": [
    { "stepId": "...", "approxInputTokens": 0, "messageCount": 0, "artifactMentionCount": 0 }
  ],
  "tracePolicyVersion": "...",
  "redactionPolicyVersion": "...",
  "digestWrittenAt": "..."
}
```

Digest is **derived data**. Raw traces are retained forever, so the digest can always be regenerated from source if its schema changes. Schema versioned via `tracePolicyVersion`.

### 5.6 Storage size estimates

Per-task volumes are estimated from the proposed schema. Numbers are conservative (assume worst-case event sizes within the redaction cap):

**Per `chat()` task:**

| User profile | Spans | Events | Trace size | Blobs | Total per task |
|---|---|---|---|---|---|
| Light (Q&A, few tools) | 5–10 | 20–40 | ~80 KB | ~30 KB | ~110 KB |
| Average (research session) | 15–25 | 50–100 | ~200 KB | ~60 KB | ~260 KB |
| Heavy (literature search + compaction + multiple sub-LLM) | 40–80 | 150–300 | ~500 KB | ~150 KB | ~650 KB |

**Daily volume:**

| User profile | Tasks/day | Daily total |
|---|---|---|
| Light | 5 | ~550 KB |
| Average | 15 | ~3.9 MB |
| Heavy | 50 | ~32 MB |

**Cumulative totals (everything retained forever):**

| User profile | One year | Three years |
|---|---|---|
| Light | ~200 MB | ~600 MB |
| Average | ~1.4 GB | ~4.2 GB |
| Heavy | ~12 GB | ~36 GB |

**Reference comparisons:**
- One hour of 1080p screen recording: ~3 GB.
- Heavy researcher's full year of telemetry: less than four hours of video.
- Typical paper repo with figures and PDFs: often already 1–5 GB.

**Conclusion**: forever-retention totals are tractable on modern SSDs for typical use. v0.5 deliberately removed retention configurability to keep the system simple — telemetry data is treated like git history: it accumulates with the project and is purged with the project.

The estimates above will be validated empirically during P1 with a self-monitoring counter on the TraceStore that writes daily byte totals to `.research-pilot/trace-storage-stats.jsonl`. If real-world numbers significantly exceed estimates, the Settings panel surfaces a banner with the current footprint; users can choose to delete the project or move it to a larger volume. Re-introducing retention configurability is a future-spec decision, not a v0.5 fallback.

---

## 6. Span Schema

### 6.1 Naming convention

Per OpenTelemetry GenAI v1.37 conventions:

- Span name = `{operation} {target}` (e.g., `chat claude-opus-4-7`, `execute_tool web_search`).
- `gen_ai.operation.name` enum: `chat`, `embeddings`, `execute_tool`, `invoke_agent`, `create_agent`. PiPilot does not invent values for this field.
- Operations OTel does not cover (long-running async tasks, compaction, memory extraction) use OTel-style verbs but live in the `pipilot.*` operation namespace.

### 6.2 Span types

| PiPilot semantic | Span name | `gen_ai.operation.name` | Kind |
|---|---|---|---|
| User task | `invoke_agent {agent.name}` | `invoke_agent` | INTERNAL (root) |
| Agent step (pi-agent-core turn) | `invoke_agent step` | `invoke_agent` | INTERNAL |
| Main / sub LLM call | `chat {model}` | `chat` | CLIENT |
| Tool execution | `execute_tool {tool.name}` | `execute_tool` | INTERNAL |
| Local compute submit | `execute_tool local_compute_execute` | `execute_tool` | INTERNAL |
| Local compute async run | `execute_task local_compute` | `pipilot.execute_task` | INTERNAL (separate root, link `follows_from` to submit) |
| Compaction | `summarize context` | `pipilot.summarize` | INTERNAL |
| Memory extraction | `extract memory` | `pipilot.memory.extract` | INTERNAL |

### 6.3 Standard OTel attributes (every applicable span)

**Schema pinning (audit #6)**: this spec targets OpenTelemetry GenAI semantic conventions as of the version pinned in `lib/telemetry/semantic-registry.ts` (`schemaUrl`). Every emitted span carries the OTel `schema_url` resource attribute. P0 gate includes a schema-conformance test that validates emitted attributes against the pinned schema. When semconv ships a new stable version, we either bump `schemaUrl` and adjust the registry, or stay pinned with explicit deprecation notes.

**Current target: OTel GenAI semconv (Sept 2025+ stable), with these attributes:**

- `gen_ai.provider.name` ∈ `{anthropic, openai, gcp.gemini, anthropic.subscription, openai.codex}`. (Was `gen_ai.system` in older drafts; renamed.)
- `gen_ai.request.model`, `gen_ai.response.model`.
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` (Anthropic). Note dotted segment between `cache_*` and `input_tokens`.
- `gen_ai.response.finish_reasons`.
- `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` ∈ `{function, retrieval, extension}`.
- `gen_ai.conversation.id` (= session.id).
- `error.type`, `span.status` on failure.

**Migration note**: when this spec freezes (P0), the semantic registry locks to a specific `schema_url`. Backends (Langfuse / Phoenix) may parse newer or older fields differently; we document the chosen pin and require backends to handle our pinned schema, not vice-versa.

### 6.4 PiPilot extension attributes (`pipilot.*` namespace)

Validated against `lib/telemetry/semantic-registry.ts` in dev mode.

| Attribute | Where | Purpose |
|---|---|---|
| `pipilot.tool.category` | `execute_tool` spans | enum from tool factory: `file, shell, code, data-analysis, literature, web, memory, artifact, document, diagram, wiki, citation, compute` |
| `pipilot.tool.error_class` | failed `execute_tool` spans | mapped from `toolError` `error_code` |
| `pipilot.tool.retry_count` | `execute_tool` spans | tool-level retries (not LLM retries) |
| `pipilot.compaction.discarded_messages`, `.kept_tokens`, `.input_tokens`, `.output_tokens` | `summarize context` span | compaction counters |
| `pipilot.resumption.bootstrap_orphans`, `.summary_loaded`, `.first_artifact_op_at_step`, `.first_tool_call_at_step` | first step of a session | objective resumption signals (no judgments) |
| `pipilot.redaction.level`, `.fields_redacted_count`, `.policy_version` | every span | audit trail |
| `pipilot.privacy.flag` | spans where detector triggered | `{rule, severity, redaction_upgraded}` (objective regex hit, not a judgment about content) |
| `pipilot.turn.id`, `pipilot.turn.followsId` | every span | turnId propagation (§4.1) |
| `pipilot.matched_skills` | root `invoke_agent` span | objective record of which skills the router selected (a routing decision is a fact, not a judgment) |
| `pipilot.active_skills` | every `invoke_agent step` span | set of skills active at step start |

**Removed in v0.3** (subjective; moved to Layer 3): `pipilot.user_message_type`, `pipilot.user_message_type.v2`, `pipilot.referring_expressions`, `pipilot.intent_labels`.

### 6.5 Local compute and other long-running async tasks: separate-trace + Link

**Audit #2 fix**: a single OTel `traceId` describes one causally connected operation. Reusing a traceId with `parentSpanId = null` is invalid. Long-running async tasks that legitimately outlive their submit operation (local-compute runs, background memory extraction, wiki background agent) live on **their own trace** with an OTel `Link` back to the originating span.

**Local compute:**
- `execute_tool local_compute_execute` (submit): completes when `submitRun()` returns the `runId`. Lives on the user-task trace as a normal child span.
- `execute_task local_compute` (run): **separate trace** (new `traceId`), root span. The OTel root carries `Links: [{ context: <submit-span-context>, attributes: { 'pipilot.link.kind': 'follows_from' } }]`. The run trace's resource carries the same `pipilot.project.id` and `gen_ai.conversation.id` (as span attributes per §5.4) so it joins to the originating session at analysis time. Run lifetime — `runner.ts` updates produce span events; terminal state ends the span.

**Background memory extraction (`maybeExtractMemories`, `lib/agents/coordinator.ts:948`)**: same pattern — runs on its own trace with `Link { kind: "spawned_from", spanId: <invoke_agent root> }`. This is what audit #9 flagged: a fire-and-forget background task must not hold the user-task trace's refcount open.

**Wiki background agent (`app/src/main/ipc.ts:917`)**: own trace, no link to a user task (it's not initiated by a user turn). `pipilot.project.id` set to whichever project the wiki agent is currently visiting; per audit #1 this is correct precisely *because* project id is a span attribute, not a Resource attribute.

**Why this is correct OTel**: a trace = "what happened for one logical operation". The user's `chat()` is one operation; the long-running compute run is a different operation that *was caused by* the first. Links express that causal relationship without conflating the two operations into one trace.

### 6.6 Explain snapshot reconciliation

Existing `writeExplainSnapshot` (`lib/agents/coordinator.ts:230`) is deprecated. Its objective fields move to the root `invoke_agent` span:

- `matchedSkills` → `pipilot.matched_skills`.
- `selectedContext.mentionSelections`, `.approxTokens` → `pipilot.context.{mention_selections, approx_tokens}`.
- `sessionSummary.{included, turnRange, approxTokens}` → `pipilot.session_summary.{included, turn_start, turn_end, approx_tokens}`.
- `budget.*` → standard `gen_ai.usage.*` on the root span.

**Removed**: `intents`, `persistence.{decision, reason}` — these were rule-based judgments.

Standalone `.research-pilot/memory-v2/explain/*.turn.json` files continue during P1 for debugging continuity, then removed.

### 6.7 Skill activation events

Skills can be loaded mid-task via `load_skill` tool calls. Activation evolution is an objective fact (a load happened, the runtime knows the name and the cause).

**Event** on the step span where activation occurred:
```jsonc
pipilot.skill.load {
  skillName: string,
  trigger: "router-match" | "explicit-load" | "dependency",
  stepId: string,
  sourceToolCallId?: string
}
```

Every `invoke_agent step` carries `pipilot.active_skills` (array): the set active at step start.

### 6.8 Compaction discarded payload

**Event** on `summarize context` spans:
```jsonc
pipilot.compaction.discarded {
  turnIds: string[],
  roles: ("user" | "assistant" | "tool")[],
  charLens: number[],
  artifactMentionIds: string[][]
}
```

Content not included (already in blob store if retained). Pure facts.

### 6.9 Events (large / sensitive payloads)

Spans carry small attributes. Large or sensitive payloads attach as OTel events.

**OTel-standard event (audit #6)**: prompt/completion messages and tool I/O are emitted via the consolidated `gen_ai.client.inference.operation.details` event (current OTel GenAI convention; replaces older per-message events such as `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice`). The event body carries the full message array under `gen_ai.input.messages` / `gen_ai.output.messages` keys.

```jsonc
// gen_ai.client.inference.operation.details event body shape
{
  "gen_ai.input.messages":  [ { "role": "user", "parts": [ ... ] }, ... ],
  "gen_ai.output.messages": [ { "role": "assistant", "parts": [ ... ] } ],
  "gen_ai.system_instructions": [ ... ]   // optional, large content via blob ref
}
```

**PiPilot-specific events** (no OTel equivalent):

- `pipilot.artifact.op` — `{artifactId, op, version_after, contentHash, ledgerRowId}`.
- `pipilot.memory.op` — `{memoryId, op, scope, type, ledgerRowId}`.
- `pipilot.detector.flag` — `{rule, severity, action_taken}`.

Event bodies pass through redaction (§7) before being attached. Over-cap content goes to blob store and the event carries `{ contentHash, size, redactionLevel }` references.

---

## 7. Redaction Pipeline

Single shared pipeline applied to **both args and results**, on **trace events and ledger rows**.

**Stages (in order):**

1. **Field-level deny list**: `apiKey`, `password`, `Authorization`, `cookie`, `csc_*`, `APPLE_*_PASSWORD`, `secret`, plus user-configurable additions.
2. **Pattern-based scrubber**: Anthropic/OpenAI keys, GitHub tokens, AWS access keys, generic `Bearer <token>`, RFC822 emails when `privacy.level = high`. Replacement: `<redacted:type>`.
3. **Path scrubbing**: replace `$HOME`, `/Users/<name>` with `~`; preserve workspace-relative paths.
4. **Size cap**: per-field, default 4 KB. Over-cap → `{ truncated: true, contentHash, size }` and the full content goes to the blob store.
5. **Artifact reference shortcut**: if the field is already an artifact (artifactId present), emit `{ artifactRef }` only.
6. **Image / SVG / binary**: never inline; always `{ contentHash, mimeType, size }`.

Every span emits `pipilot.redaction.{level, fields_redacted_count, policy_version}`. Bumping the policy version is observable.

When a `pipilot.detector.flag` fires, the redaction pipeline upgrades for that span: more aggressive truncation, image hashes only, no raw content events.

---

## 8. Ledgers

Ledgers carry the entity-centric truth that traces only point to. **All ledgers in this section record only objective facts. Subjective interpretation is Layer 3.**

### 8.1 Artifact ledger

```jsonc
{
  "artifactId": "...",
  "version": 7,
  "op": "create | edit | overwrite | delete | convert | export | execute | read",
  "type": "note | paper | data | web-content | tool-output | manuscript | outline | slides | code | dataset | figure | bibliography | teaching-material",
  "path": "<workspace-relative>",
  "contentHash": "sha256:...",
  "diffPath": ".research-pilot/blobs/<hash>",
  "versionBefore": 6,
  "initiator": "user | assistant | tool | external",
  "traceId": "...",
  "spanId": "...",
  "turnId": "...",
  "toolCallId": "...",
  "timestamp": "..."
}
```

**Snapshot policy** (clarified in v0.3): for text-type artifacts (note, paper, outline, manuscript, code, slides) under 100 KB, the full content of every version is preserved in the blob store. For data-type artifacts (data, dataset) over 1 MB, only `contentHash` and metadata are kept; full historical content is **not** written to blob store. This is configurable per-project under `privacy.artifactSnapshotPolicy`.

### 8.2 Memory ledger

```jsonc
{
  "memoryId": "...",
  "op": "search | retrieve | create | update | delete",
  "scope": "session | project | user-global | cross-project | wiki",
  "type": "preference | decision | todo | rationale | artifact-summary | user-stated-fact | extracted-claim",
  "originatingProjectId": "...",
  "originatingArtifactId": "...",
  "provenance": { "source": "user-message | tool-output | extraction | import", "ref": "..." },
  "traceId": "...",
  "spanId": "...",
  "turnId": "...",
  "timestamp": "..."
}
```

**Removed in v0.3** (subjective; moved to Layer 3): `state`, `confidence`, `verifiedStatus`, `expirationTime`, `supersedes`, `supersededBy`, `conflictWith`. The memory ledger is now a pure event log: each operation is a fact. Whether an extracted claim is a "valid anchor fact", whether a memory has "gone stale", whether two memories "conflict" — all Layer 3 judgments.

`type` enum is descriptive of the source (`user-stated-fact` = came verbatim from user; `extracted-claim` = LLM extractor produced it), not evaluative.

Retrieval operations write `{ retrievedMemoryIds, scores }` to the corresponding `pipilot.memory.op` event in the trace.

### 8.3 User-response signals ledger

Renamed from "outcome ledger" in v0.3 to make the boundary explicit. **Records raw signals only.** No `signal` enum, no `confidence`, no `approval`/`rejection` labels.

**Path**: `.research-pilot/user-response-signals.jsonl`.

**Schema** (one row per user input):

```jsonc
{
  "turnId": "u-235",
  "previousTurnId": "u-234",
  "previousAssistantMsgId": "a-234",
  "gapMsSincePreviousAssistant": 73000,
  "messageContentHash": "sha256:...",
  "messageCharLen": 84,
  "referencedArtifactIds": ["paper.md@v7"],
  "uiInteractionsSincePreviousAssistant": [
    { "kind": "view", "target": "paper.md@v7", "durationMs": 8200 }
  ],
  "sessionTerminatedAfterThis": false,
  "traceId": "...",
  "timestamp": "..."
}
```

Layer 3 reads this ledger plus the trace (or its blob-stored content) to classify what the user response *meant*. PiPilot runtime never makes that classification.

### 8.4 View log

Renderer-side passive observation: artifact / memory / trace items the user looked at without speaking.

**Path**: `.research-pilot/view-log.jsonl`.

```jsonc
{
  "viewId": "...",
  "projectId": "...",
  "sessionId": "...",
  "turnId": "...",
  "target": { "kind": "artifact | memory | trace | session-summary", "id": "..." },
  "op": "view | hover | scroll | dismiss",
  "durationMs": 0,
  "timestamp": "..."
}
```

Privacy: inherits project privacy profile. `level = high` defaults view log off (UI toggle).

---

## 9. Layer 3 (out of scope, brief reference)

This spec **does not specify** Layer 3. It exists in a separate research codebase. PiPilot's only obligation to Layer 3 is to make Layer 1+2 data:

- Joinable by stable IDs (`traceId`, `spanId`, `turnId`, `artifactId`, `memoryId`, `viewId`, `sessionId`, `projectId`).
- Read-only accessible (Layer 3 must never modify Layer 1+2 data).
- Versioned (every record carries `tracePolicyVersion`, `redactionPolicyVersion` so Layer 3 knows what shape it's reading).

Layer 3 produces annotation files in its own repo (path and format determined by the analysis project). Whether those annotations are produced by humans, by LLM scripts, or by both is a Layer 3 design choice.

A reasonable Layer 3 annotation row, for orientation only:

```jsonc
{
  "traceId": "...",
  "spanId": "...",
  "turnId": "...",
  "label": "...",
  "rationale": "...",
  "annotator": "human:dong | llm:claude-opus-4-7+codebook-v3",
  "codebookVersion": "...",
  "createdAt": "..."
}
```

PiPilot runtime does not write, read, or schema-check this file.

---

## 10. Privacy Contract

Per-project, written once to `.research-pilot/project.json`:

```jsonc
"privacy": {
  "level": "low | medium | high",
  "containsUnpublished": false,
  "containsThirdPartyData": false,
  "publicationPermission": "none | aggregate-only | with-redaction | full",
  "benchmarkReleasePermission": "none | with-consent | full",
  "redactionPolicy": "default | strict",
  "blobEncryption": "none | at-rest",
  "artifactSnapshotPolicy": { "textCapKb": 100, "skipDataArtifactsOverMb": 1 }
}
```

**Enforcement**:
- Resource attributes carry the profile to every span.
- `level = high` upgrades default redaction; requires `blobEncryption = at-rest`.
- **Export gate**: any OTLP / file export checks `publicationPermission`. `none` blocks. `aggregate-only` strips event bodies. `with-redaction` re-runs the strict pipeline. Override requires per-export confirmation; the override itself writes a row to `tracing-state.jsonl`.
- `containsThirdPartyData = true` defaults OTLP export to disabled.

### 10.1 Tracing-state log

`tracing-state.jsonl` records every toggle (tracingMode change, redaction policy bump, export override, degraded-state events from §5.1, project-config migrations). Append-only; retained forever.

```jsonc
{ "timestamp": "...", "fromState": "...", "toState": "...", "actor": "user | system | export-gate", "reason": "..." }
```

Tracing cannot be silently disabled: any toggle while `tracingMode = enabled` is auditable.

### 10.2 Project-scoped configuration (audit #4)

`ProjectConfig` (`lib/types.ts:169`) gains three fields. v0.5 keeps this minimal — only privacy (necessarily per-project) and the on/off switch.

```typescript
// lib/types.ts (proposed extension)
export interface ProjectConfig {
  // Existing fields preserved...

  // NEW (v0.5):
  id: string                              // ULID, generated on first load if missing
  privacy: ProjectPrivacyConfig           // see §10
  telemetry: ProjectTelemetryConfig       // see §5.1
  configSchemaVersion: number             // for migration; v0.5 = 1
}
```

**Migration**: on project load, if `id` is missing, generate a ULID and write it back. If `privacy` or `telemetry` are missing, populate with defaults (privacy `level=low`, telemetry `tracingMode='enabled'`) and write back. Migration is one-shot, idempotent, recorded in `tracing-state.jsonl` with `actor=system, reason=config-migration-v1`.

**IPC**: project-scoped settings get their own IPC channels (`project:get-config`, `project:update-config`), distinct from the existing global-settings IPC. The settings UI surfaces these in a project-scoped panel; global settings remain in the main settings dialog. UI mockup required at P0 gate.

**No global telemetry counterpart**: telemetry config is project-only. Privacy is necessarily per-project (different projects have different sensitivity), and `tracingMode` is essentially a privacy switch, so it lives next to privacy.

---

## 11. Phased Delivery

### P0 — Interface freeze (no functional output)

- Span schema (§6), `pipilot.*` semantic registry, ID hierarchy (§4.1).
- **OTel schema pinning (audit #6)**: chosen `schema_url` committed to `lib/telemetry/semantic-registry.ts`; conformance test runs in CI.
- **Resource vs span attribute split (audit #1)** locked: Resource = process/build only; project/session/privacy on span attributes.
- **Local-compute trace model (audit #2)** locked: separate trace + Link, not shared traceId.
- **turnId IPC envelope (audit #5)**: `agent:send` IPC handler signature updated to require `clientMessageId` + `clientTimestamp`; preload bridge typed.
- **ProjectConfig migration (audit #4)**: `lib/types.ts` schema bump to v1 with `id`, `privacy`, `telemetry.{tracingMode, bufferCapacity}`; migration helper + idempotency proof.
- **Bounded queue + drop policy (audit #7)**: TraceStore queue/disk-full/disable-toggle behavior specified and unit-testable.
- **Trace closure (audit #9)**: refcount + watchdog + crash-recovery digest replay specified.
- `tracedCompleteSimple` helper signature.
- Privacy profile schema (§10).
- Tracing-state log schema (§10.1).
- Settings UI mockup for project-scoped Telemetry panel (§10.2). Panel contains: tracingMode toggle, privacy profile, current storage footprint (informational).

**Gate**: spec accepted; semantic registry committed; types compile; OTel conformance test green against pinned `schema_url`; settings UI mockup approved; no runtime behavior change.

### P1 — Sub-LLM coverage + tool spans + usage re-source + ledgers

- Wire `tracedCompleteSimple` for all 8 sub-LLM sites (§2.2).
- Wrap `beforeToolCall`/`afterToolCall` to emit `execute_tool` spans.
- Subscribe to `AgentEvent` to emit `invoke_agent` and `invoke_agent step` spans.
- Re-source usage totals: `app/src/main/ipc.ts:614` reads from trace aggregation; one-release dual-write window.
- Artifact ledger upgrade (§8.1) + `pipilot.artifact.op` events + snapshot policy.
- Memory ledger (§8.2) + `pipilot.memory.op` events.
- User-response signals ledger (§8.3) — pure facts only.
- View log (§8.4).
- Skill activation events (§6.7), compaction discarded payload (§6.8).
- Resumption attribute set (`pipilot.resumption.*`).
- Trace digest writer.
- Self-monitoring storage stats (§5.6 validation).
- Settings UI for project-scoped Telemetry panel wired up (tracingMode toggle + storage footprint readout).

**Gate**: traces produced for an end-to-end research session contain all 8 sub-LLM call sites; usage totals match dual-write within tolerance for two weeks; storage stats match estimates within 2×; no agent-path regressions.

### P1.5 — Privacy & export gate

- Detector pipeline (regex catalog) wired into redaction.
- Project privacy UI in `project.json` editor.
- Export gate enforced (§10).
- Audit log for export overrides.

**Gate**: external export impossible without configured privacy profile and per-export confirmation. Verified by red-team test.

### P2 — OTLP exporter

- `OtlpSpanExporter` behind `RESEARCH_COPILOT_OTLP_ENDPOINT`.
- Async batch, ring buffer for backpressure.
- Exporter failures isolated to `.research-pilot/traces/exporter-errors.log`.
- Verify with Langfuse + Phoenix end-to-end.

**Gate**: failure injection (kill endpoint) does not impact agent latency or cause data loss within the ring buffer's window.

### P3 — Renderer integration

- IPC channels: `trace:live`, `trace:snapshot(traceId)`.
- New `trace-store.ts` Zustand store; two-week diff vs `activity-store` before switching to derived selectors.
- View log writers wired up via renderer events.
- `compute-store` unchanged.
- `RealtimeBuffer` retained until trace channel demonstrates equivalent remount-recovery.

**Gate**: a renderer remount during an active trace produces an identical view via either path.

### P4 — Engineering diagnostic rules

CLI / notebook checks computed off the trace store:
- Prefill explosion.
- Slow-tool tail.
- Repeated work.
- Sequential dependency.
- Cache miss attribution.

### Deferred / out of scope

- Layer 3 annotation tooling (separate codebase).
- Renderer-side spans composing into the same trace.
- W3C `traceparent` propagation to external HTTP.
- Cross-project trace correlation UI.

---

## 12. Open Questions

All remaining open questions are engineering decisions; subjective/research questions were removed in v0.3 by clarifying the boundary.

### 12.1 Prompt/completion as events vs attributes

OTel recommends events; attributes easier to grep with `jq`. **Recommendation**: events; local CLI viewer auto-expands them. Phoenix and Langfuse both prefer events.

### 12.2 OpenInference dual-emit

Phoenix's native UI keys off OpenInference. Dual-emit costs ~2× span size on `chat` spans. **Recommendation**: default OTel-only; opt-in via `RESEARCH_COPILOT_TRACE_FORMAT=openinference`.

### 12.3 Cross-project trace isolation

When `privacy.containsThirdPartyData = true`, default-disable OTLP. **Recommendation**: yes, default-disable; require explicit per-project override; override writes an audit row.

### 12.4 Subscription provider naming

`anthropic-sub` → `gen_ai.provider.name = anthropic.subscription` (separate from direct API). **Recommendation**: keep separate; merging is a SQL operation, splitting after the fact is not.

### 12.5 Storage stats validation

§5.6 estimates need empirical validation. P1 introduces self-monitoring writing daily byte totals. If real-world numbers significantly exceed estimates, the Settings panel surfaces a banner showing the current footprint. v0.5 has no in-app remediation (no compaction action); the user's options are: leave it, delete the project, move the workspace to a larger volume. Re-introducing retention configurability is a future-spec decision if the data warrants it.

### 12.6 Redaction policy version drift

When we tighten redaction, old spans look more leaky than new ones. Recommendation: on policy bump, re-run redaction over recent spans before any export. Adds complexity; call before P1.5 closes.

### 12.7 View log default in `engineering` mode

(Carried over from v0.2.) View log is high signal for research uses but irrelevant to engineering debugging. **Recommendation**: default-on for `tracingMode = enabled`, simple toggle in Settings.

---

## 13. Self-Review Checklist

| Concern | Resolution | Section |
|---|---|---|
| `traceId` per coordinator was wrong | per `agent:send`, session as attribute/link | §4.1 |
| Shared mutable `activeSpan` was a concurrency hazard | AsyncLocalStorage primary, toolCallId-map fallback | §4.2 |
| Sub-LLM coverage incomplete | Eight sites enumerated; single `tracedCompleteSimple` helper | §2.2, §6.2 |
| Usage double-counting | Single source: leaf `chat` spans; ipc usage re-aggregated | §6.3, P1 |
| `agent.turn` clashed with pi-agent-core | `invoke_agent` (root), `invoke_agent step` (loop) | §6.2 |
| Local compute can't be sync child | Dual-span model with `follows_from` link | §6.5 |
| RunStore pattern doesn't scale | Append-only JSONL, batched flush, daily-file eviction | §5.1 |
| RealtimeBuffer semantics must be preserved | Phase gate requires equivalence diff before switching | P3 |
| `args` cannot be exempt from redaction | Redaction pipeline applies to args + result + events + ledgers | §7 |
| Trace ≠ Ledger | Two layers, two lifetimes (now both per-policy) | §3.1, A1 |
| OTel skeleton | OTel GenAI conventions throughout; PiPilot extensions namespaced | §6.1, A3 |
| Tracing must never block agent | A4; exporter failures isolated; ring buffer | §1.3, P2 |
| Span schema growth controlled | Semantic registry validates `pipilot.*` keys in dev | §3.2 |
| **NEW v0.3: Subjective fields contaminating runtime** | Removed from runtime; Layer 3 boundary made explicit | §0, §1.2, §6.4, §8.2, §8.3 |
| **NEW v0.3: Ledger lifecycle was a research judgment** | Memory ledger is a pure event log; lifecycle moved to Layer 3 | §8.2 |
| **NEW v0.3: Outcome ledger had embedded judgments** | Renamed to user-response-signals; raw facts only | §8.3 |
| **NEW v0.3: User shouldn't be a research labeler** | No thumbs UI in spec; signals ledger captures behavior, not user-provided labels | §8.3, §1.2 |
| **NEW v0.3: Trace retention was hardcoded 7d** | (Superseded by v0.5: retention is now forever, not configurable) | §5.1 |
| **NEW v0.5: Configurable retention added accidental complexity** | Retention configurability removed entirely; everything is forever; project deletion is the only purge | §3.1, §5.1, §5.2, §5.3, §10.2 |
| **NEW v0.4: Resource attributes carried per-project state (audit #1)** | project/session/privacy moved to span attributes; Resource = process/build only | §5.4 |
| **NEW v0.4: Local-compute reused traceId with null parent (audit #2)** | Async run is its own trace + OTel Link `follows_from`/`spawned_from` | §6.5 |
| **NEW v0.4: Retention statements contradicted (audit #3)** | (Superseded by v0.5: no retention configurability at all, no contradictions to resolve) | §3.1 |
| **NEW v0.4: Project settings designed as global (audit #4)** | ProjectConfig migration; project-scoped IPC + UI | §10.2 |
| **NEW v0.4: turnId not implementable across renderer/main (audit #5)** | Renderer's existing message id passed in `agent:send` envelope | §4.1 |
| **NEW v0.4: GenAI semconv outdated (audit #6)** | Migrated to current semconv; schema_url pinned + conformance test | §6.3 |
| **NEW v0.4: Local exporter lacked bounded queue (audit #7)** | Bounded queue + drop counter + degraded mode + disable toggle | §5.1 |
| **NEW v0.4: Artifact JSONL upgrade misrepresented (audit #8)** | Acknowledged per-file JSON store; ledger added alongside | §5.2, §8.1 |
| **NEW v0.4: Digest closure underspecified (audit #9)** | Root-end + active-child refcount + watchdog + crash replay | §5.5 |
| `turnId` undefined across ledgers | `turnId = clientMessageId`, propagated as `pipilot.turn.id` | §4.1 |
| Compaction loses what was dropped | `pipilot.compaction.discarded` event with turn IDs and artifact refs | §6.8 |
| Skill activation only captured at root | `pipilot.skill.load` events + per-step `pipilot.active_skills` | §6.7 |
| §5.3 retention contradicted §10 | Reference-counted GC tied to project policy; encryption required at `level=high` | §5.3, §10 |
| Coverage can be silently disabled | `tracingMode` + `tracing-state.jsonl` audit log | §10.1 |
| Passive verification invisible | View log `.research-pilot/view-log.jsonl` | §8.4 |

### 13.1 Known unresolved tensions

1. **Storage at forever-retention for very heavy users**: estimates suggest ~12 GB/year for the heaviest profile, ~36 GB at three years. Acceptable on modern SSDs; may surprise users on smaller laptops. v0.5 has no in-app remediation — the user's options are: leave it, delete the project, move the workspace. P1 self-monitoring + Settings banner gives visibility (§5.6, §12.5).
2. **Redaction policy version drift**: §12.6.
3. **Export gate trust model**: relies on user setting privacy profile honestly; no enforcement against mislabeling. Documented as known limitation.
4. **OTel semconv pin freshness**: pinning `schema_url` ensures internal correctness but may lag external tooling. Bumping the pin requires registry update + conformance test pass + backend re-verification (Langfuse/Phoenix). Process should be quarterly review.
5. **Trace closure watchdog timeout choice**: 30 seconds is a guess. Real applications may have legitimate background spans that take longer (e.g., a slow wiki indexing run). Watchdog firing produces a degraded-marker, not data loss. P1 should monitor watchdog firing rate and adjust if false-positive rate is high.

---

## 14. References

- OpenTelemetry GenAI Semantic Conventions v1.37 — `gen_ai.*` attributes, operation enums, message events.
- OpenTelemetry Trace Semantic Conventions v1.30+ — `error.type`, `service.*`, span status.
- OpenInference Specification — retrieval / embedding span conventions used as fallback.
- W3C Trace Context — `traceparent` header (deferred for HTTP propagation).
- Existing PiPilot specs: `docs/spec/local-compute.md`, `docs/spec/fulltext-retrieval.md`.
- pi-agent-core `AgentEvent` types — `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`.
- `shared-ui/settings-types.ts` — pattern for the 3-option Settings picker (Research Intensity / Web Search Depth) adopted for Trace Retention in §5.1.
