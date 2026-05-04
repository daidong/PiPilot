# Telemetry & Trace: Unified Observability and Research Data Capture

> Spec version: 0.1 (draft) | Last updated: 2026-05-04 | Status: PROPOSAL — NOT IMPLEMENTED

## 0. Reading Guide

This is a **design spec for review**, not a built feature. It supersedes ad-hoc proposals exchanged during the May 2026 design discussion. Two audiences:

1. **Engineering** — needs §1–§7 (architecture, schema, storage, integration points).
2. **Research (Paper 1)** — needs §1, §6, §8, §9 (what data we capture and why it supports empirical claims).

Sections marked **OPEN** require the project owner to decide before P0 freezes. Sections marked **DEFERRED** are intentionally out of scope for the first cut.

---

## 1. Goals and Non-Goals

### 1.1 Goals

1. **Engineering observability**: explain *why an agent run was slow / wrong / expensive* across the full execution tree (root LLM → tool → sub-LLM → retrieval → local-compute → memory compaction). The current `console.log + activity-store + explain-snapshot + run-store` patchwork only covers the surface.
2. **Research data capture**: produce trace + ledger artifacts sufficient to support Paper 1's empirical claims (artifact-centered collaboration, context debt, resumption cost, repair behavior, role migration, co-adaptation). Without this, Paper 1 degenerates into a longitudinal chatbot study.
3. **Standards-first portability**: emit OpenTelemetry-conformant traces so Langfuse, Phoenix, Tempo, Datadog, or any OTLP backend can consume our data without bespoke adapters.
4. **Pluggable export**: local JSONL by default (zero-dep), OTLP endpoint behind an env flag, never block the agent on exporter failure.

### 1.2 Non-Goals

- **Real-time alerting / SLO dashboards**: telemetry is for post-hoc analysis and developer debugging. No paging, no on-call.
- **Cross-user analytics**: we do not aggregate across users. Each install is its own data plane.
- **Replacing domain stores**: `compute-store`, `entity-store`, `session-store`, etc. remain authoritative for their domains. Trace references them by ID, never replicates them.
- **Automatic research labels**: the runtime never writes subjective judgments (e.g., `wrong_artifact_used`, `agent_overstepped`). Those belong in the annotation ledger (§8.4).

### 1.3 Design axioms

Anchors all subsequent decisions. If a later section appears to violate these, it is wrong, not the axioms.

- **A1 — Trace ≠ Ledger.** Traces are time-line + causal structure, append-only, retention-limited (default 7 days). Ledgers are entity-centric (artifact / memory / outcome / annotation), retained with the project. Research analysis joins them by ID; runtime writes them separately.
- **A2 — Capture facts, not judgments.** Runtime records observable events (calls, tokens, status, hashes). Subjective labels (repair type, context staleness, trust) are added in post-hoc annotation, not by detectors at runtime.
- **A3 — OTel skeleton, PiPilot semantics.** Standard OTel GenAI conventions for portability. PiPilot-specific schema lives under `pipilot.*` namespace and never overloads standard fields.
- **A4 — Never block the agent.** Tracing failures (disk full, OTLP endpoint down, exporter bug) must degrade silently. The agent path tolerates trace loss; trace path tolerates agent abort.
- **A5 — Privacy is a project-level contract, not a per-span flag.** Privacy profile is configured once per project; per-span detectors only adjust redaction aggressiveness.
- **A6 — Minimum discipline for survival.** Per the project-wide design axiom: we do not pursue complete instrumentation up front. P0 freezes interfaces; P1+ fills coverage incrementally with evidence.

---

## 2. Background: What We Already Have

This spec **must build on existing infrastructure**, not replace it. Inventory of reusable hooks:

### 2.1 Event sources already in place

| Source | File | What it gives us |
|---|---|---|
| `pi-agent-core` `AgentEvent` stream | subscribed at `lib/agents/coordinator.ts:635` | `agent_start/end`, `turn_start/end`, `message_*`, `tool_execution_*` |
| `beforeToolCall` / `afterToolCall` hooks | `lib/agents/coordinator.ts:612,619` | tool boundary with args/result/toolCallId |
| `transformContext` callback | `lib/agents/coordinator.ts:530` | compaction trigger + summarization input |
| Coordinator callbacks | `onStream/onToolCall/onToolResult/onToolProgress/onUsage/onSkillLoaded` | streamed back to renderer via IPC |
| `RealtimeBuffer` | `app/src/main/realtime-buffer.ts:41` | live push + remount-recovery snapshot for renderer stores |
| `RunStore` JSONL pattern | `lib/local-compute/run-store.ts` | atomic temp+rename, debounced flush, 7-day retention — **template only**, not direct reuse (§5) |
| Explain snapshot | `lib/agents/coordinator.ts:230,805–826` | per-`chat()` JSON dump (intents, matched skills, budget) — proto-task-span (§6.6) |
| Artifact JSONL | `lib/memory-v2/store.ts` | already an artifact ledger; needs version_before/initiator/turnId fields (§8.1) |
| Compute run ledger | `lib/local-compute/run-store.ts` (`.research-pilot/compute-runs/runs.jsonl`) | already long-running async records; integrates as §6.5 |
| `session.json` | `shared-electron/ipc-base.ts:260` | stable cross-process session id |

### 2.2 Sub-LLM blind spots (currently invisible)

These sites bypass `agent.subscribe`'s event stream and are the highest-value targets:

- `ResearchToolContext.callLlm` — `lib/agents/coordinator.ts:410` (used by literature-search, data-analyze, etc.)
- `ResearchToolContext.callLlmVision` — `lib/agents/coordinator.ts:425` (diagram tool)
- `matchSkillsWithLLM` — `lib/agents/coordinator.ts:100` (skill router)
- `maybeGenerateSummary` → `completeSimple` — `lib/agents/coordinator.ts:687` (session summary)
- `transformContext` → `generateSummary` — `lib/agents/coordinator.ts:580` (compaction)
- `maybeExtractMemories` — `lib/memory/extractor.ts:148` (auto memory extraction)
- Wiki background agent — `app/src/main/ipc.ts:917`
- Diagram backend direct `fetch()` to OpenAI/Anthropic — review/generation paths

All eight must be covered. P1 introduces a single `tracedCompleteSimple` helper plus closure-level wrappers for the two non-`completeSimple` cases (wiki bg agent, diagram fetch).

### 2.3 Renderer stores already consuming events

`activity-store`, `tool-events-store`, `tool-progress-store`, `usage-store`, `progress-store`, `compute-store`. Each is currently a parallel source of truth. Post-P3 they become derived views over the trace stream (§6.7) — except `compute-store`, which retains domain ownership of run records.

---

## 3. Architecture

### 3.1 Three layers, three lifetimes

```
+------------------------------------------------------------+
|  Layer 3: Research analysis (off-runtime)                  |
|  - CLI / notebook                                          |
|  - JOIN traces + ledgers + annotations + outcomes          |
|  - Derived fields (session.gap, repair.cost_turns, etc.)   |
+--------+----------------------+----------------------------+
         |                      |
         | reads                | reads
         |                      |
+--------+--------+    +--------+----------+
|  Layer 2: Trace |    |  Layer 2: Ledgers |
|  (append-only,  |    |  (entity-keyed,   |
|   7d retention, |    |   project-life,   |
|   OTel format)  |    |   versioned)      |
+--------+--------+    +--------+----------+
         |                      |
         | spans / events       | rows
         |                      |
+--------+----------------------+----------------------------+
|  Layer 1: Instrumented runtime                             |
|  - AsyncLocalStorage propagated TraceContext               |
|  - tracedCompleteSimple, beforeToolCall, after, ALS wrap   |
|  - ledger writers in the same call path                    |
+------------------------------------------------------------+
```

**Lifetimes:**
- Trace: 7 days (configurable), evicted by trace-id age.
- Ledgers: project lifetime (artifact, memory, outcome, annotation).
- Resource attributes (versions, hashes): per-process, attached to every span.

### 3.2 Components added

| Component | Location | Responsibility |
|---|---|---|
| `Tracer` interface | `lib/telemetry/tracer.ts` | thin wrapper over `@opentelemetry/api`'s tracer; project-scoped |
| `TraceStore` | `lib/telemetry/trace-store.ts` | append-only JSONL writer; batched flush; retention sweep |
| `JsonlSpanExporter` | `lib/telemetry/exporters/jsonl.ts` | implements OTel `SpanExporter` writing OTLP/JSON wire format |
| `OtlpSpanExporter` | `lib/telemetry/exporters/otlp.ts` | gated by `RESEARCH_COPILOT_OTLP_ENDPOINT` |
| `tracedCompleteSimple` | `lib/telemetry/llm-trace.ts` | wraps `completeSimple` with span + redaction |
| Redaction pipeline | `lib/telemetry/redaction.ts` | shared by trace events and ledger writes |
| `LedgerWriter` (artifact / memory / outcome / annotation) | `lib/ledger/*.ts` | each ledger isolated; writers idempotent on `(traceId, spanId, op)` |
| `pipilot.*` semantic registry | `lib/telemetry/semantic-registry.ts` | enumerates allowed namespaced attributes; validation in dev mode |

### 3.3 What `coordinator.ts` does *not* do

- Does **not** allocate `traceId`. (See §4.1.)
- Does **not** hold mutable trace state on `ResearchToolContext`. (See §4.2.)
- Does **not** become an "instrumentation hub"; it stays a coordinator. Instrumentation is a layer wrapped around it.

---

## 4. Identity, Concurrency, Propagation

### 4.1 ID hierarchy

```
project.id               (resource attribute, from .research-pilot/project.json)
  session.id             (gen_ai.conversation.id, from session.json)
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

Decisions:
- **`traceId` per user task**, allocated at `agent:send` IPC entry. Not per-coordinator (coordinators rebuild on settings/model changes; one coordinator handles many tasks).
- **`session.id` is an attribute and link target, not a span.** A months-long session does not become a months-long trace. Cross-trace continuity is reconstructed at analysis time by joining on `gen_ai.conversation.id`.
- **`project.id` is a resource attribute** (per process), not per span — it does not change for the life of a coordinator process.

### 4.2 Concurrent parent-child

`pi-agent-core` parallelizes tool calls. A single mutable "active span" on `ResearchToolContext` would cross-link siblings. Solution:

- **Primary**: `AsyncLocalStorage<TraceContext>` via `@opentelemetry/context-async-hooks`'s `AsyncLocalStorageContextManager`. Each `tool.execute` and each `tracedCompleteSimple` runs in a child context. This is the same mechanism OTel auto-instrumentations expect, so future automatic instrumentation will compose cleanly.
- **Fallback**: `Map<toolCallId, TraceContext>` populated in `beforeToolCall`, drained in `afterToolCall`. Used when ALS is unavailable (rare; e.g., callbacks crossing IPC boundaries) or when an explicit `parentToolCallId` hint is provided.
- **Explicit override**: `tracedCompleteSimple(model, req, opts, { parent: explicitCtx })` for cases like the wiki background agent where the natural async parent has already exited.

### 4.3 What we do not propagate

- We do not propagate trace context across the IPC boundary into the renderer at runtime. The renderer subscribes to a separate `trace:live` channel (§6.7); it does not produce spans. (Adding renderer-side spans is DEFERRED.)
- We do not propagate trace context to external HTTP requests (web_search, web_fetch, fulltext) by default. OPEN: should we inject W3C `traceparent` headers? Backend cooperation is rare and adds fingerprinting risk. Default off.

---

## 5. Storage Model

### 5.1 Trace store: append-only

Rejects the `RunStore` pattern of "Map-of-records, full rewrite on flush" (`lib/local-compute/run-store.ts:60`). Trace span counts will exceed run counts by 2–3 orders of magnitude.

**Format**: `.research-pilot/traces/spans.{date}.jsonl`, one OTLP/JSON `ResourceSpans` envelope per line, batched.

**Write path**:
1. Span ends → in-memory queue.
2. Batch trigger: 64 spans **or** 200ms idle.
3. Flush: append-only `write()`, no rewrite.
4. Process exit: synchronous `flushNow()`.

**Indices** (rebuilt on startup, atomic temp+rename):
- `traces/index.{date}.json`: `{ traceId → { firstByteOffset, byteLen, rootSpanId, status } }` for fast viewer lookup.
- In-memory `Map<traceId, SpanIndex>` is a query cache, not source of truth.

**Retention**:
- Default 7 days, configurable via `pipilot.trace.retention_days`.
- Eviction: drop entire daily file when newest span in it ages past threshold. Never partial-rewrite.
- Project deletion deletes the trace directory.

### 5.2 Ledgers: entity-keyed, versioned

Each ledger is its own JSONL file under `.research-pilot/`:

| Ledger | Path | Key | Status |
|---|---|---|---|
| Artifact | `artifacts/ledger.jsonl` | `(artifactId, version)` | upgrade existing artifact JSONL |
| Memory | `memory-v2/ledger.jsonl` | `memoryId` (with lifecycle transitions) | upgrade existing memory store |
| Outcome | `outcomes.jsonl` | `(turnId, signal)` | new |
| Annotation | `annotations/{traceId}.jsonl` | `(traceId, spanId, label)` | new (Layer 3 tool writes here) |

**Cross-reference**: each ledger row records `{ traceId, spanId, turnId, toolCallId? }` so analysis can join either direction.

**Idempotency**: ledger writers are idempotent on the natural key. Replays during crash recovery do not duplicate.

### 5.3 Content blobs

Large content (turn text > 4 KB, tool I/O over cap, diagram SVG, base64 images) is content-addressed:

- Stored once at `.research-pilot/blobs/{sha256}` (single file per hash).
- Referenced from spans / ledgers as `{ contentHash, size, redactionLevel }`.
- Garbage-collected when no reference remains and project explicitly compacts (no auto-GC; cheap-to-keep, expensive-to-lose).

### 5.4 Resource attributes (per-process)

Set once at TraceProvider initialization, attached to every span via OTel `Resource`:

```
service.name = "research-copilot"
service.version = <app/package.json version>
pipilot.runtime.agent_profile = <coordinator profile id>
pipilot.runtime.system_prompt_hash = sha256(baseSystemPrompt)
pipilot.runtime.workspace_commit = git rev-parse HEAD (best effort)
pipilot.runtime.memory_index_version = <wiki manifest version>
pipilot.project.id = <project.json id>
pipilot.project.type = <enum: research-cycle | paper-writing | teaching-cycle | coding | analysis | literature-review | course-material | other>
pipilot.project.privacy_profile = <low | medium | high>
gen_ai.conversation.id = <session.id>
```

---

## 6. Span Schema

### 6.1 Naming convention

Per OpenTelemetry GenAI v1.37 conventions:

- Span name = `{operation} {target}` (e.g., `chat claude-opus-4-7`, `execute_tool web_search`).
- `gen_ai.operation.name` enum: `chat`, `embeddings`, `execute_tool`, `invoke_agent`, `create_agent`. PiPilot does **not** invent values for this field.
- Operations OTel does not cover (long-running async tasks, compaction, memory extraction) use OTel-style verbs but live in the `pipilot.*` operation namespace.

### 6.2 Span types

| PiPilot semantic | Span name | `gen_ai.operation.name` | Kind | Lifetime |
|---|---|---|---|---|
| User task | `invoke_agent {agent.name}` | `invoke_agent` | INTERNAL (root) | one `chat()` call |
| Agent step (pi-agent-core turn) | `invoke_agent step` | `invoke_agent` | INTERNAL | turn_start..turn_end |
| Main / sub LLM call | `chat {model}` | `chat` | CLIENT | single LLM round-trip |
| Tool execution | `execute_tool {tool.name}` | `execute_tool` | INTERNAL | tool.execute() |
| Local compute submit | `execute_tool local_compute_execute` | `execute_tool` | INTERNAL | submit only |
| Local compute async run | `execute_task local_compute` | (custom: `pipilot.execute_task`) | INTERNAL (separate root, link follows_from to submit) | run lifetime |
| Compaction | `summarize context` | (custom: `pipilot.summarize`) | INTERNAL | one compaction event; child `chat` span for the LLM call |
| Memory extraction | `extract memory` | (custom: `pipilot.memory.extract`) | INTERNAL | one extraction; child `chat` span |

### 6.3 Standard OTel attributes (every applicable span)

- `gen_ai.system` ∈ `{anthropic, openai, gcp.gemini, anthropic.subscription, openai.codex}`.
  Subscription tiers are kept distinct from direct API to enable separate cost accounting.
- `gen_ai.request.model`, `gen_ai.response.model` (post-resolution model id).
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
- `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_creation_input_tokens` (Anthropic).
- `gen_ai.response.finish_reasons` (array).
- `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` ∈ `{function, retrieval, extension}`.
- `gen_ai.conversation.id` (= session.id).
- `error.type`, `span.status` on failure; `error.type=client.aborted` for user abort, `server.error` for upstream LLM errors.

### 6.4 PiPilot extension attributes (`pipilot.*` namespace)

Validated against `lib/telemetry/semantic-registry.ts` in dev mode (drops invalid keys, warns).

| Attribute | Where | Purpose |
|---|---|---|
| `pipilot.tool.category` | `execute_tool` spans | enum from `lib/tools/index.ts` factory: `file, shell, code, data-analysis, literature, web, memory, artifact, document, diagram, wiki, citation, compute` |
| `pipilot.tool.error_class` | failed `execute_tool` spans | mapped from `toolError` `error_code` |
| `pipilot.tool.retry_count` | `execute_tool` spans | tool-level retries (not LLM retries) |
| `pipilot.user_message_type` | root `invoke_agent` span | rule-based classifier (§9.2): `new-request \| correction \| approval \| rejection \| clarification \| status-query \| preference \| planning \| continuation \| unknown` |
| `pipilot.compaction.discarded_messages`, `.kept_tokens`, `.input_tokens`, `.output_tokens` | `summarize context` span | compaction metrics |
| `pipilot.resumption.bootstrap_orphans`, `.summary_loaded`, `.first_artifact_op_at_step`, `.first_tool_call_at_step`, `.user_reexplained_context` | first step of a session | resumption signals |
| `pipilot.redaction.level`, `.fields_redacted_count`, `.policy_version` | every span | audit trail of what was redacted |
| `pipilot.privacy.flag` | spans where detector triggered | `{rule, severity, redaction_upgraded}` |

### 6.5 Local compute: dual-span model

Submission and execution are split:

- `execute_tool local_compute_execute` (**submit span**): completes when `submitRun()` returns the `runId`. Status `ok` means submission succeeded, not run succeeded. Attributes include `pipilot.local_compute.run_id`.
- `execute_task local_compute` (**run span**): independent root, `traceId` matches the submitting trace, `parentSpanId = null`, has OTel `Link { type: "follows_from", spanId: <submit_span_id> }`. Run lifetime — emits `start_time` on `runner.ts:queue`, attribute updates on progress events, `end_time + status` on terminal state.

This avoids a long-running run holding the user's task span open across hours/days.

### 6.6 Explain snapshot reconciliation

Existing `writeExplainSnapshot` (`lib/agents/coordinator.ts:230`) becomes part of the root `invoke_agent` span:

- `intents` → `pipilot.intent_labels` array attribute.
- `matchedSkills` → `pipilot.matched_skills` array attribute.
- `selectedContext.mentionSelections`, `.approxTokens` → `pipilot.context.{mention_selections, approx_tokens}`.
- `persistence.{decision, reason}` → `pipilot.persistence.{decision, reason}`.
- `sessionSummary.{included, turnRange, approxTokens}` → `pipilot.session_summary.{included, turn_start, turn_end, approx_tokens}`.
- `budget.*` → standard `gen_ai.usage.*` on the root span (aggregated from children — see §7).

Standalone `.research-pilot/explain/*.turn.json` files are deprecated once trace is GA. During P1 they continue to be written for debugging continuity.

### 6.7 Events (large / sensitive payloads)

Spans carry small attributes. Large or sensitive payloads attach as OTel events:

- `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice` — OTel-standard events for prompt/completion content.
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` — tool I/O.
- `pipilot.artifact.op` — `{artifactId, op, version_after, contentHash, ledgerRowId}`.
- `pipilot.memory.op` — `{memoryId, op, scope, type, lifecycle_transition, ledgerRowId}`.
- `pipilot.detector.flag` — `{rule, severity, action_taken}`.

Event bodies pass through redaction (§7) before being attached.

---

## 7. Redaction Pipeline

Single shared pipeline, applied to **both args and results**, on **trace events and ledger rows**. Args are not exempt: tools include `write/edit` (file content), `local_compute_execute` (env vars, scripts), diagram (SVG), and prompts that may include base64 images or secrets.

**Stages (applied in order):**

1. **Field-level deny list**: `apiKey`, `password`, `Authorization`, `cookie`, `csc_*`, `APPLE_*_PASSWORD`, `secret`, plus user-configurable additions. Match by key name (case-insensitive).
2. **Pattern-based scrubber**: regex catalog (Anthropic/OpenAI keys, GitHub tokens `ghp_*`, AWS access keys, generic `Bearer <token>`, RFC822 emails when privacy=high). Replacement: `<redacted:type>`.
3. **Path scrubbing**: replace `$HOME`, `/Users/<name>` prefixes with `~`; preserve workspace-relative paths.
4. **Size cap**: per-field, default 4 KB. Over-cap → `{ truncated: true, contentHash, size }` and the full content goes to the blob store (§5.3) with privacy-aware retention.
5. **Artifact reference shortcut**: if the field is already an artifact (artifactId present), emit `{ artifactRef }` only.
6. **Image / SVG / binary**: never inline; always `{ contentHash, mimeType, size }`.

**Auditability**: every span emits `pipilot.redaction.{level, fields_redacted_count, policy_version}`. Bumping the policy version is observable in retrospective analysis.

**Privacy escalation**: when a `pipilot.detector.flag` fires (e.g., regex hit on a secret), the redaction pipeline **upgrades** for that span: more aggressive truncation, image hashes only, no raw content events. The flag itself is recorded.

**Out-of-scope for redaction**: ledger content is also redacted, but blob store contents are not (they are intentionally the raw fallback). Blob retention is bounded by privacy profile (§9.4).

---

## 8. Ledgers (research data backbone)

Ledgers carry the entity-centric truth that traces only point to.

### 8.1 Artifact ledger

Upgraded from existing artifact JSONL.

```jsonc
{
  "artifactId": "...",
  "version": 7,
  "op": "create | edit | overwrite | delete | convert | export | execute | read",
  "type": "note | paper | data | web-content | tool-output | manuscript | outline | slides | code | dataset | figure | bibliography | teaching-material",
  "path": "<workspace-relative>",
  "contentHash": "sha256:...",
  "diffPath": ".research-pilot/blobs/<hash>",   // for edit ops
  "versionBefore": 6,
  "initiator": "user | assistant | tool | external",
  "traceId": "...",
  "spanId": "...",
  "turnId": "...",
  "toolCallId": "...",
  "timestamp": "..."
}
```

**Migration**: existing artifact JSONL gains `versionBefore`, `initiator`, `traceId`, `spanId`, `turnId`, `toolCallId`. New writes populate them; old rows stay readable.

### 8.2 Memory ledger

Upgrades memory-v2 with explicit lifecycle:

```jsonc
{
  "memoryId": "...",
  "op": "search | retrieve | create | update | delete | summarize | retire",
  "scope": "session | project | user-global | cross-project | wiki",
  "type": "preference | decision | anchor-fact | todo | rationale | artifact-summary",
  "state": "proposed | accepted | active | superseded | retired | disputed",
  "confidence": 0.0,
  "verifiedStatus": "unverified | confirmed | contradicted",
  "expirationTime": null,
  "supersedes": ["..."],
  "supersededBy": null,
  "conflictWith": [],
  "provenance": { "source": "user-message | tool-output | extraction | import", "ref": "..." },
  "traceId": "...",
  "spanId": "...",
  "turnId": "...",
  "timestamp": "..."
}
```

Retrieval ops also write `{ retrievedMemoryIds, scores }` to the corresponding `pipilot.memory.op` event in the trace, enabling "was retrieved memory used in the final answer?" questions to be answered by joining trace + ledger.

### 8.3 Outcome ledger

Captures explicit user signals.

```jsonc
{
  "turnId": "...",
  "signal": "approval | rejection | revision-request | correction | abandonment",
  "targetArtifact": "artifactId@version",
  "targetTurn": "turnId",
  "freeText": "...",
  "source": "ui-button | text-classifier | timeout-heuristic",
  "traceId": "...",
  "spanId": "...",
  "timestamp": "..."
}
```

Sources:
- `ui-button`: explicit thumbs / revision-request UI (proposed P1 add — OPEN, see §10).
- `text-classifier`: rule-based reading of the next user message.
- `timeout-heuristic`: no follow-up + session ended → `abandonment`.

`output_status` (accepted / reused / revised / rejected / abandoned) is **derived** at analysis time from this ledger plus subsequent artifact reads; not written at runtime.

### 8.4 Annotation ledger

Out-of-band labels added by Layer 3 tooling. Runtime never writes here.

```jsonc
{
  "traceId": "...",
  "spanId": "...",
  "label": "wrong-artifact-used | stale-goal | false-continuity | provenance-loss | citation-uncertainty | memory-conflict | cross-project-contamination | downstream-error | agent-overstep | privacy-issue | repair-factual | repair-style | resumption-success | ...",
  "annotator": "...",
  "rationale": "...",
  "createdAt": "..."
}
```

---

## 9. Research Coverage (Paper 1 mapping)

Map of Paper 1 claims → telemetry support. If a row says "annotation", runtime cannot supply it; Layer 3 tooling must.

| Paper 1 claim | Support |
|---|---|
| Prompt compression | turn span tokens + `pipilot.user_message_type` (`continuation`, `clarification`) + `pipilot.context.approx_tokens` over time |
| Artifact-centered collaboration | artifact ledger + `pipilot.artifact.op` events; reuse graph derived |
| Anchor facts | memory ledger `state=accepted, type=anchor-fact` over time + retrieval frequency |
| Context debt | derived: span tokens growth + retrieved-but-unused memories + repair turns + annotation |
| Stale memory | memory ledger lifecycle transitions + annotation (`stale-goal`) |
| Resumption cost | `pipilot.resumption.*` attributes + session.gap (derived) + `turns_until_productive_work` (derived) |
| Role migration | annotation-driven (over-time series of `agent.role` labels per project phase) |
| Co-adaptation | derived: prompt length, implicit-reference rate, tool mix evolution, plus annotation |
| User verification / repair | outcome ledger + annotation (repair-* labels); `repair.cost_turns` derived |

### 9.1 Project type & phase

`project.type` is fixed enum + `other` + free-form `pipilot.project.subtype`. Configured in `.research-pilot/project.json` UI. **Project phase** is annotation-only (we do not auto-detect).

### 9.2 User message classifier

Rule-based v1, run at chat() entry. Reuses the regex style of `classifyPersistenceDecision` (`lib/agents/coordinator.ts:179`). Outputs `pipilot.user_message_type`. Goals: cheap, deterministic, good-enough for repair detection. Precision-recall tuning is a research task; runtime only commits the regex set + version (`pipilot.user_message_type.classifier_version`).

### 9.3 Derivable fields (do not instrument)

- `session.gap_since_previous`, `project.age`
- `prompt.length_chars`, `implicit_reference_rate`
- `tool_call_mix`, `artifact_reuse_graph`, `memory_reuse_frequency`
- `repair_loop_length`, `topic_drift`, `phase_transition_matrix`
- `burstiness`
- `output_status`

These are SQL/notebook problems, not runtime problems.

### 9.4 Privacy contract

Per-project, written once to `.research-pilot/project.json`:

```jsonc
"privacy": {
  "level": "low | medium | high",
  "containsUnpublished": false,
  "containsThirdPartyData": false,
  "publicationPermission": "none | aggregate-only | with-redaction | full",
  "benchmarkReleasePermission": "none | with-consent | full",
  "redactionPolicy": "default | strict",
  "blobRetentionDays": 7
}
```

**Enforcement**:
- Resource attributes carry the profile to every span.
- `level=high` upgrades default redaction (image hashes only, narrower size cap, email scrubbing).
- **Export gate**: any OTLP / file export (manual or automated) checks `publicationPermission`. `none` blocks export. `aggregate-only` strips event bodies. `with-redaction` re-runs the strict pipeline. Override requires explicit user confirmation per export, which itself writes an outcome ledger row.
- `containsThirdPartyData=true` defaults OTLP export to disabled.

---

## 10. Phased Delivery

Each phase has explicit gates. Phase Pn does not start until Pn-1's gate is met.

### P0 — Interface freeze (no functional output)

Defines and freezes:
- Span schema (§6), `pipilot.*` semantic registry, ID hierarchy (§4.1).
- Ledger schemas (§8.1–§8.4).
- Redaction policy v1 (§7).
- TraceStore append-only model + JsonlSpanExporter shape (§5.1).
- AsyncLocalStorage propagation contract (§4.2).
- `tracedCompleteSimple` helper signature.
- Privacy profile schema (§9.4).
- `project.json` upgrade with `type` + `privacy.*`.

**Gate**: spec accepted; semantic registry committed; types compile; no runtime behavior change.

### P1 — Sub-LLM coverage + tool spans + usage re-source

- Wire `tracedCompleteSimple` for all 8 sub-LLM sites (§2.2).
- Wrap `beforeToolCall`/`afterToolCall` to emit `execute_tool` spans.
- Subscribe to `AgentEvent` to emit `invoke_agent` and `invoke_agent step` spans.
- Re-source usage totals: `app/src/main/ipc.ts:614` reads from trace aggregation, not directly from `turn_end.usage`. Run dual-write (old + new) for one release; reconcile diffs in CI.
- Artifact ledger upgrade (§8.1) + `pipilot.artifact.op` events.
- Memory ledger lifecycle (§8.2) + `pipilot.memory.op` events.
- `pipilot.user_message_type` classifier v1.
- `pipilot.resumption.*` attributes.
- Outcome ledger writers from text-classifier + timeout-heuristic (UI button DEFERRED to P3).

**Gate**: traces produced for an end-to-end research session contain all 8 sub-LLM call sites; usage totals match dual-write within tolerance for two weeks; no agent-path regressions.

### P1.5 — Privacy & export gate (must precede any external sink)

- Detector pipeline (regex catalog) wired into redaction.
- Project privacy UI in `.research-pilot/project.json` editor.
- Export gate enforced (§9.4).
- Audit log for export overrides.

**Gate**: external export is impossible without a configured privacy profile and per-export confirmation. Verified by red-team test (attempted export with `level=high`, `permission=none` must fail).

### P2 — OTLP exporter

- `OtlpSpanExporter` behind `RESEARCH_COPILOT_OTLP_ENDPOINT`.
- Async batch, 64-span / 200ms triggers, ring buffer for backpressure.
- Exporter failures never bubble to agent; failures themselves logged to a separate `.research-pilot/traces/exporter-errors.log`.
- Verify with Langfuse + Phoenix end-to-end on a sample session.

**Gate**: failure injection (kill endpoint mid-session) does not impact agent latency or cause data loss within the ring buffer's retention window.

### P3 — Renderer integration

- New IPC channels: `trace:live` (push), `trace:snapshot(traceId)` (pull).
- New `trace-store.ts` Zustand store, parallel to existing stores.
- Diff tool runs for two weeks comparing `activity-store` events vs trace-derived events; gate on zero divergence.
- Then: switch `activity-store` and `tool-events-store` to derived selectors over `trace-store`. `compute-store` unchanged (domain state). `usage-store` unchanged (already trace-aggregated by P1).
- Outcome UI (thumbs / revision-request) writes to outcome ledger.
- `RealtimeBuffer` retained until trace channel demonstrates equivalent remount-recovery.

**Gate**: a renderer remount during an active trace produces an identical view via either path.

### P4a — Engineering diagnostic rules

CLI / notebook checks computed off the trace store:
- Prefill explosion (per-step input_token growth > N% with no compaction).
- Slow-tool tail (per-tool p99/mean ratio).
- Repeated work (same tool name + args hash within one task).
- Sequential dependency (linear chain depth > K with single child each level — missed parallelization).
- Cache miss attribution (input_tokens up + cache_read_input_tokens flat → likely cache invalidation).

### P4b — Research analysis layer (Paper 1)

Off-runtime CLI / notebook joining traces + ledgers + annotations + outcomes. Computes derived fields (§9.3). Not part of the app.

### P5 — Annotation tool

Electron view or CLI for adding annotations against traces. Blocks Paper 1's subjective claims if absent. **OPEN**: priority depends on Paper 1 deadline (§11.3).

### Deferred

- Renderer-side spans (composing into the same trace) — DEFERRED.
- Automatic phase detection — DEFERRED, annotation only.
- Cross-project trace correlation UI — DEFERRED.
- W3C `traceparent` propagation to external HTTP — DEFERRED.

---

## 11. Open Questions (require maintainer decision before P0 closes)

### 11.1 Prompt/completion as events vs attributes

OTel recommends events (sampling-friendly, easier to disable for PII). Attributes are easier to grep with `jq`. **Recommendation**: events; local CLI viewer auto-expands them. Phoenix and Langfuse both prefer events.

### 11.2 OpenInference dual-emit

Phoenix's native UI keys off OpenInference (`llm.input_messages`, `llm.token_count.*`). To work out-of-the-box there, we'd dual-emit OTel GenAI + OpenInference mirror attributes. Cost: ~2× span size on `chat` spans. **Recommendation**: default OTel-only; opt-in via `RESEARCH_COPILOT_TRACE_FORMAT=openinference` for users targeting Phoenix.

### 11.3 Annotation tool priority (P5 vs earlier)

Paper 1's subjective claims (§9 rows tagged "annotation") cannot be analyzed without P5. If Paper 1 deadline is within ~3 months, P5 must move ahead of P3/P4. **Needs maintainer call.**

### 11.4 Outcome UI scope

P3 proposes thumbs + revision-request buttons. Without UI, outcome capture relies on next-message text classification + timeout heuristics → low recall, biased. **Recommendation**: include UI in P3, classifier as fallback, not the primary source.

### 11.5 Cross-project trace isolation

When `privacy.containsThirdPartyData=true`, default-disable OTLP. **Recommendation**: yes, default-disable; require explicit per-project override; override writes an audit row.

### 11.6 Subscription provider naming

`anthropic-sub` → `gen_ai.system=anthropic.subscription` (separate from direct API). This separates cost accounting at the cost of one extra system value. **Recommendation**: keep separate; merging is a SQL operation, splitting after the fact is not.

### 11.7 Span context propagation across IPC

Renderer-originated work (e.g., user clicks artifact reuse) is currently invisible to the trace. P3+ adds renderer push only; renderer-originated spans are DEFERRED. **Confirm acceptable for Paper 1.**

---

## 12. Self-Review Checklist (consistency with prior axioms)

This section is a sanity audit. Each row tests this spec against earlier review feedback.

| Concern | Resolution in this spec | Section |
|---|---|---|
| `traceId` per coordinator was wrong | `traceId` per `agent:send`, session as attribute/link | §4.1 |
| Shared mutable `activeSpan` was a concurrency hazard | AsyncLocalStorage primary, toolCallId-map fallback, explicit override | §4.2 |
| Sub-LLM coverage was incomplete | Eight sites enumerated; single `tracedCompleteSimple` helper | §2.2, §6.2 |
| Usage double-counting between turn and sub-LLM | Single source: leaf `chat` spans; ipc usage re-aggregated; dual-write window | §6.3, P1 gate |
| `agent.turn` clashed with pi-agent-core's `turn_*` events | Renamed: `invoke_agent` (root) and `invoke_agent step` (loop) | §6.2 |
| Local compute can't be a sync child of submit | Dual-span model with `follows_from` link | §6.5 |
| RunStore "Map + full rewrite" doesn't scale | Append-only JSONL, batched flush, daily-file eviction | §5.1 |
| RealtimeBuffer semantics must be preserved | Phase gate requires equivalence diff before switching | P3 |
| `args` cannot be exempt from redaction | Redaction pipeline applies to args + result + events + ledgers | §7 |
| Subjective labels must not be auto-emitted | Annotation ledger; runtime emits detector flags only | §8.4, A2 |
| Privacy as per-span flag is fragile | Project-level privacy profile, span-level upgrade only | §9.4, A5 |
| Trace ≠ Ledger | Three layers, three lifetimes | §3.1, A1 |
| OTel must be the skeleton | OTel GenAI conventions throughout; PiPilot extensions are namespaced | §6.1, A3 |
| Tracing must never block agent | A4 axiom; exporter failures isolated; ring buffer for backpressure | §1.3, P2 gate |
| Span schema growth must be controlled | Semantic registry validates `pipilot.*` keys in dev | §3.2 |

### 12.1 Known unresolved tensions

Honest list of where this spec is **not yet self-consistent**:

1. **§4.3 deferral vs §11.7**: renderer-originated work is deferred, but Paper 1's "user verification / repair" partly depends on it (e.g., a user editing an artifact directly without chatting). Outcome ledger + artifact ledger `initiator=user` partially compensate. Unresolved whether sufficient — research call.
2. **§5.1 retention vs §9 longitudinal claims**: 7-day trace retention conflicts with multi-month project trajectories. Mitigation: ledgers retain forever; trace eviction loses fine timing but preserves causal facts via ledgers. Acceptable for Paper 1 *if* the analysis budget tolerates lower temporal resolution on old sessions. Open for confirmation.
3. **§6.4 `pipilot.user_message_type` classifier v1 reliability**: rule-based classifier will mislabel ambiguous Chinese-English mixed messages. We commit `classifier_version` so re-classification is possible at analysis time; the runtime label is advisory, not authoritative.
4. **§7 redaction policy version drift**: when we tighten redaction, old spans look more leaky than new ones. Recommendation (not yet specified): on policy bump, re-run redaction over recent spans before any export. Adds complexity — call before P1.5 closes.
5. **§9.4 export gate trust model**: the gate relies on the user setting privacy profile honestly. There is no enforcement against a user marking a project `low / full permission` when it actually contains third-party data. Out of scope for this spec; documented as a known limitation.

---

## 13. References

- OpenTelemetry GenAI Semantic Conventions v1.37 — `gen_ai.*` attributes, operation enums, message events.
- OpenTelemetry Trace Semantic Conventions v1.30+ — `error.type`, `service.*`, span status.
- OpenInference Specification — retrieval / embedding span conventions used as fallback.
- W3C Trace Context — `traceparent` header (DEFERRED for HTTP propagation).
- Existing PiPilot specs: `docs/spec/local-compute.md`, `docs/spec/fulltext-retrieval.md`, `docs/spec/trust-audit.md` (referenced by user memory).
- pi-agent-core `AgentEvent` types — `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`.
