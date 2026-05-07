# Telemetry & Trace: Objective Runtime Data Capture

> Spec version: 0.11 (draft) | Last updated: 2026-05-06 | Status: PROPOSAL — FREEZE CANDIDATE
>
> **Changelog v0.10 → v0.11** (post-implementation alignment, 2026-05-06):
>
> Code shipped on the spec/telemetry-trace branch closed several provenance gaps and made one product-policy reversal. Spec text updated to match what's running.
>
> - **Default tracingMode flipped to `disabled`** (commit `eb54009`). v0.10 said opt-out; in practice, wire-level capture + tool args/result events meant a typical project accrued ~250 KB/turn forever-retained. Without explicit user consent that's a meaningful storage commitment, so new projects now start opt-in. Existing projects with explicit `tracingMode: 'enabled'` are NOT auto-flipped — only configs without a `telemetry` block default to disabled. §5.1, §10.2, §14.1 updated.
> - **Provenance gaps closed** (commit `c062894`):
>   - `pipilot.thinking_level` attribute on root + step spans (§6.4). Mid-session UI changes were previously invisible.
>   - `pipilot.chat.response_text` event on step spans (§6.9). Main agent loop bypasses `tracedCompleteSimple`, so the per-step assistant message text was previously only in the session JSONL.
>   - `pipilot.compaction.summary_text` event on `summarize context` spans (§6.9). Per-event summary text was previously only recoverable via the next turn's `request_payload`.
>   - `model-change` kind in tracing-state log (§10.1). Mid-session model switches now leave an audit row with `fromState`/`toState`.
>   - Memory ledger now actually written by `save-memory` / `delete-memory` tools (§8.2). Previously the writer existed but had zero callers. `MemoryType` enum extended with `user | feedback | project | reference` to match the user-facing buckets exposed by the tool.
> - **Artifact-ledger turnId plumbed** (commit `934b978`). v0.10 schema had `turnId?` but no caller passed it; now `CLIContext.turnId` flows through `createArtifact` / `updateArtifact` / `deleteArtifact`. §8.1 schema unchanged; the field is now reliably populated for tool-driven writes.
> - **`pipilot.tool.args` / `pipilot.tool.result` / `pipilot.chat.request_payload` events documented** in §6.9. These were added in earlier commits (`67d0882`, `a2426ed`) but never made it into the §6.9 PiPilot-events list.
> - **G2 (artifact historical content reproducibility) explicitly accepted as a gap.** §8.1 mentioned a `diffPath` field in the schema but it's never populated; the spec wording remains, but a note now records that pre-version content reconstruction is out of scope. The §14.2 backfill CLI is also unimplemented and remains carry-over.
> - **Compaction `generateSummary` wire-capture gap** documented in `lib/telemetry/PARITY.md#wire-level-capture-coverage`. pi-coding-agent's internal summarizer call bypasses `tracedCompleteSimple` (no hook exposed). Accepted as span-only — the new `pipilot.compaction.summary_text` event closes the per-event summary visibility, just not the wire payload of the summarizer call itself.
>
> **Changelog v0.9 → v0.10** (final review-driven fixes):
>
> - **High — Tombstone vs pure OTLP/JSON file**: v0.9 wrote `{ kind: "trace_dropped" }` rows directly into `traces/spans.{date}.jsonl`, contradicting both the "one OTLP/JSON ResourceSpans envelope per line" claim and the "directly readable by any OTel-compatible tool" goal. Fixed: tombstones moved to a sidecar file `traces/tombstones.{date}.jsonl`. Spans file stays pure OTLP/JSON. PiPilot tools join spans + tombstones; third-party OTel tools see the spans file unchanged (they may see partial traces from drops, but PiPilot's own digest/viewer correctly filter).
> - **Medium — `gen_ai.provider.name` enum missed `deepseek`**: PiPilot already supports DeepSeek (`shared-ui/constants.ts:34`, `shared-electron/ipc-base.ts:399`) and OTel's GenAI semconv well-known list includes it. Added.
>
> **Changelog v0.8 → v0.9** (review-driven correctness fixes):
>
> - **High — P0 task list synced with v0.7/v0.8 deletions**: removed references to "privacy span attribute" and "ProjectConfig privacy field" (deleted in v0.7) and "refcount + watchdog closure" (deleted in v0.8). P0 is the implementation entry point and was still pulling deleted designs back in.
> - **High — Drop policy made consistent with append-only model**: a trace's early spans may already be flushed to JSONL when the queue fills. Old wording said "drop and resume after headroom," producing partial traces with mid-trace gaps. Fixed: dropped traces are tombstoned (single `kind: trace_dropped` row written to JSONL) and the traceId is permanently suppressed for the rest of its lifetime via in-memory `Set<string>`. Digest writer + viewer must skip any traceId with a tombstone.
> - **Medium — Axiom A5 corrected**: was still asserting "Privacy is a project-level contract" after v0.7 deleted privacy governance. Rewritten to "Local-first with always-on secret scrubbing".
> - **Medium — `gen_ai.tool.type` enum corrected**: was `{function, retrieval, extension}`; current GenAI semconv is `{function, extension, datastore}`. `retrieval` is an *operation* name, not a tool type. PiPilot wiki/literature/web tools now mapped to `datastore`.
> - **Medium — Trace closure leaked-child handling**: parent can end while a child span never closes (buggy tool). v0.8 said "root never sees end" but that's not always true. Fixed: at root-end, TraceStore checks AsyncLocalStorage for descendants without `end_time` and writes digest with `openChildSpanCount`, `openChildSpanIds`, `degraded=true`. Crash recovery re-emits digest if open-child set shrinks later.
> - **Low — §6.5 self-contradicting wording**: was "run trace's resource carries ... as span attributes". Fixed to "run-root span carries ... (these are span attributes per §5.4); OTel Resource remains process/build identity only".
>
> **Changelog v0.7 → v0.8** (design subtraction; net simpler):
>
> - **OTLP export removed from spec.** PiPilot writes traces in OTLP/JSON format to local JSONL only. No OtlpSpanExporter, no `RESEARCH_COPILOT_OTLP_ENDPOINT`, no Phase P2, no Langfuse/Phoenix end-to-end verification, no first-run notice (§14.6 deleted), no OpenInference dual-emit open question (§12.2 deleted). The OTel/JSON wire format is kept because it lets the local CLI viewer and any user-side tooling reuse `@opentelemetry/api` types — local format ≠ remote endpoint.
> - **Secret redaction confirmed always-on.** No change to §7; all paths through the spec verified to never imply it can be disabled.
> - **A — Compaction discarded event simplified**: `pipilot.compaction.discarded` now carries `turnIds` only. `roles`, `charLens`, `artifactMentionIds[][]` removed; Layer 3 can join via turn ledger and artifact ledger if needed.
> - **B — Skill load event `sourceToolCallId` removed**: parent `execute_tool` span is already in OTel context; explicit field was redundant.
> - **C — Trace closure simplified**: digest is written when the root `invoke_agent` span ends. No active-descendant refcount, no 30s watchdog. Background work (memory extract, wiki bg, async compute) is on its own trace per §6.5 and never extends the user-task trace. Crash recovery still scans for daily-JSONL traces with root-end-but-no-digest at startup, but the logic is "did root end?" instead of "did refcount reach zero?"
> - **D — Ring queue drop policy simplified**: queue full → drop the *newest in-flight trace* in its entirety. Counter `pipilot.trace.dropped_traces`. No criticality classification, no overflow ring, no five categories of drop counters. Viewer/digest never see orphans because whole traces are dropped or kept atomically.
> - **E — `pipilot.runtime.shell_prompt_hash` on Resource removed**: redundant with `service.version`. Only `pipilot.runtime.full_prompt_hash` on the root span remains.
> - **F — Auth/billing/transport collapsed**: `pipilot.billing_source` and `pipilot.transport` deleted. Single field `pipilot.auth.mode` ∈ `{api-key, anthropic-subscription, openai-codex}` carries the distinction.
> - **G — Resumption state-machine fields removed**: `pipilot.resumption.first_artifact_op_at_step` and `.first_tool_call_at_step` deleted (required state-machine bookkeeping for marginal value). Kept: `pipilot.resumption.bootstrap_orphans`, `.summary_loaded` (cheap booleans set once at first step).
> - **H — Trace digest fields trimmed**: 15 fields → 8 core fields (traceId, sessionId, projectId, startedAt/endedAt, tokens, toolCallsByCategory, turns[], digestWrittenAt). Steps[], subLlmCallsByPurpose, compactionDiscardedTurnIds, artifactOps[], memoryOps[], matchedSkills, activeSkillsByStep all derivable from raw trace; removed from digest.
> - **I — Phase plan compressed**: P2 deleted (was OTLP). Renumbered: P3 → P2 (renderer integration), P4 → P3 (engineering diagnostic rules).
>
> **Changelog v0.6 → v0.7**:
>
> - **Privacy governance removed.** PiPilot is a local-first desktop app: all data lives in the user's `.research-pilot/` directory and is never transmitted unless the user explicitly opts in (e.g., configures `RESEARCH_COPILOT_OTLP_ENDPOINT`). The previous privacy contract (`privacy.level`, `containsUnpublished`, `containsThirdPartyData`, `publicationPermission`, `benchmarkReleasePermission`, `redactionPolicy`, `blobEncryption`, `artifactSnapshotPolicy`, export gate's permission checks, level-based redaction upgrades, blob at-rest encryption, privacy migration dialog) is deleted. What remains: (a) OTLP export defaults disabled and requires explicit env var, (b) secret/key/token redaction (§7) always runs, (c) `tracingMode='disabled'` is a single hard off-switch.
> - **New §14 Migration & Backwards Compatibility**: spec previously implied migration but did not specify it. Now codified: `ProjectConfig` migration helper, `usage.json` pre-trace cutoff field, optional history-import CLI, explain-snapshot retirement plan, OTLP-export pre-existing-data warning.
> - **Cold-start buffer doubling: rejected.** Earlier draft proposed temporarily doubling the ring queue at cold start. On reflection: the wiki background agent already has its own pacing (`WikiPacingConfig`), so cold-start span burst is bounded; high-burst situations are anomalies that should surface via the drop counter, not be masked by elastic capacity. Buffer is fixed at 1024.
> - §10 Privacy Contract section deleted; §10.1 Tracing-state log + §10.2 Project-scoped configuration kept (renumbered; tracingMode + bufferCapacity are the only telemetry knobs).
>
> **Changelog v0.5 → v0.6** (review-driven correctness fixes):
>
> - **High — §10 Resource/span split residual contradiction**: §10's "Resource attributes carry the profile" rewritten to consistently say privacy profile is on **span attributes**, matching §5.4. Resource is process-life immutable; privacy profile is per-project and cannot live there.
> - **High — §5.4 system_prompt_hash placement**: `pipilot.runtime.system_prompt_hash` moved from Resource to root `invoke_agent` span attribute. The current `baseSystemPrompt` (`lib/agents/coordinator.ts:491`) embeds project-specific skills catalog, so it varies across projects/coordinators within one process — invalid as Resource. Resource keeps `pipilot.runtime.shell_prompt_hash` (hash of the global `SYSTEM_PROMPT` constant only).
> - **High — §6.3 OTel semconv stability claim**: GenAI semconv is still marked Development, not Stable. Wording corrected to "pinned development/experimental semconv with conformance tests"; bumping the pin requires re-verification when semconv graduates.
> - **Medium — §6.3 / §12.4 provider naming**: `gen_ai.provider.name` reverts to OTel's standard values (`anthropic`, `openai`, `gcp.gemini`). Subscription / Codex distinctions move to PiPilot-namespaced attributes: `pipilot.auth.mode` ∈ `{api-key, subscription, codex-cli}` and `pipilot.billing_source`. Cross-backend readability restored.
> - **Medium — §6.3 schema_url placement**: clarified — `schema_url` is set on the OTLP `ResourceSpans` envelope and on the OTel `Tracer` (instrumentation scope), not as a per-span attribute.
> - **Medium — §5.1 ring queue drop policy**: drop policy refined — never drop root spans, step spans, or `summarize context` spans (digest-critical). Drop newest non-critical span first; if queue is saturated with critical spans, drop oldest non-critical. Rationale: keeping orphan child spans without their root breaks digest materialization and viewer rendering.
> - **Cleanup**: removed v0.3/v0.4 residuals — `RunStore` row mentioning "retention sweep", §2.1 row labeling artifact JSONL "upgraded" (current store is per-file JSON, see §5.2 corrected wording), §2.1 reference to "3-option picker" precedent (no picker exists in v0.5), §13 self-review row mentioning "daily-file eviction".
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
2. **Standards-first format**: traces are written as OpenTelemetry-conformant OTLP/JSON envelopes locally. The local CLI viewer and any user-side tooling can reuse `@opentelemetry/api` types and OTel SDK helpers without adapters. (External export is deferred — see §11 Deferred.)
3. **Long-horizon retention**: traces and ledgers retained forever, for the lifetime of the project. Project deletion is the only purge.
4. **Local JSONL only**: traces written to `.research-pilot/traces/*.jsonl` in OTLP/JSON wire format (so user-side tooling can reuse `@opentelemetry/api` types). Never blocks the agent on writer failure. v0.8 deliberately drops the OTLP exporter — PiPilot is local-first, and external export is a future-spec decision if the need arises.
5. **Local-first**: all data lives in the user's `.research-pilot/` directory and is never transmitted. Secret/credential redaction (§7) always runs as a defense against accidental embedding of secrets in events the user might later choose to share.

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
- **A4 — Never block the agent.** Tracing failures (disk full, writer bug) must degrade silently. The agent path tolerates trace loss; trace path tolerates agent abort.
- **A5 — Local-first with always-on secret scrubbing.** All telemetry data lives in the user's `.research-pilot/` directory and is never transmitted by PiPilot. The only defense against accidental secret leakage (e.g., user shares a trace file in a bug report) is the always-on scrubber catalog (§7), which runs unconditionally on every event and ledger row. There is no privacy "level," no per-project privacy profile, no opt-in or opt-out.
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
| `RunStore` JSONL pattern | `lib/local-compute/run-store.ts` | atomic temp+rename, debounced flush — **template only**, not direct reuse (§5) |
| Explain snapshot | `lib/agents/coordinator.ts:230,805–826` | per-`chat()` JSON dump (matched skills, budget) — proto-task-span; deprecated by trace (§6.6) |
| Per-file artifact JSON store | `lib/memory-v2/store.ts:412` (write at `:473`) | current artifact storage — **not** a JSONL; v0.6 adds an append-only `artifacts/ledger.jsonl` alongside, leaving the per-file store as read-side authority (§5.2, §8.1) |
| Compute run ledger | `lib/local-compute/run-store.ts` | already long-running async records; integrates as §6.5 |
| `session.json` | `shared-electron/ipc-base.ts:260` | stable cross-process session id |

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

Resource attributes are per-process, immutable for the process lifetime, and carry only app/build identity (§5.4). Per-project state (project id, session id) lives on span attributes, not Resource.

### 3.2 Components added

| Component | Location | Responsibility |
|---|---|---|
| `Tracer` interface | `lib/telemetry/tracer.ts` | thin wrapper over `@opentelemetry/api`'s tracer; project-scoped |
| `TraceStore` | `lib/telemetry/trace-store.ts` | append-only JSONL writer; batched flush; bounded queue with drop-policy ordering (§5.1) |
| `JsonlSpanExporter` | `lib/telemetry/exporters/jsonl.ts` | implements OTel `SpanExporter` writing OTLP/JSON wire format to `.research-pilot/traces/*.jsonl` |
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

**Format**: `.research-pilot/traces/spans.{date}.jsonl`, one OTLP/JSON `ResourceSpans` envelope per line, batched. **The spans file is pure OTLP/JSON** — it contains only `ResourceSpans` rows and is directly readable by any OTel-compatible tool.

PiPilot-specific control records (tombstones) live in a separate sidecar file `traces/tombstones.{date}.jsonl` so the spans file stays format-pure.

**Write path** (audit #7 — bounded queue + drop policy):

1. Span ends → enqueue to in-memory bounded ring queue.
   - Default capacity: **1024 spans** (configurable per project).
   - **Drop policy: trace-level tombstone.** When the queue is full, the writer picks the *newest in-flight trace* (the trace whose first span entered the queue most recently) and:
     1. Discards every span of that trace currently in the queue.
     2. Suppresses **all future spans** of that traceId for the rest of its lifetime — once dropped, a trace is dropped permanently. There is no "resume after headroom" window. Suppression is keyed on `traceId` in an in-memory `Set<string>`; cleared on process exit.
     3. Writes a single tombstone row to the sidecar file `traces/tombstones.{date}.jsonl`:
        ```jsonc
        { "traceId": "...", "kind": "trace_dropped", "reason": "queue_full",
          "droppedAtSpanCount": <how many of this trace's spans were already flushed>,
          "timestamp": "..." }
        ```
        The spans file (`traces/spans.{date}.jsonl`) is never touched; it stays pure OTLP/JSON.
     4. Increments counter `pipilot.trace.dropped_traces` in `tracing-state.jsonl`.
   - Digest writer, viewer, and any analysis tool consume the spans file **plus** the tombstones sidecar, then **skip any traceId that has a `trace_dropped` tombstone** — even if some early spans of that trace were already flushed before the queue filled. Crash recovery (§5.5) treats tombstoned traces as closed-with-no-digest.
   - Third-party OTel tools that don't know about tombstones can still read the spans file directly; they will see the dropped trace's early spans as a partial trace, but PiPilot's own tools always join with the sidecar to filter correctly.
   - Rationale: append-only JSONL means already-flushed spans cannot be retracted. Permanent suppression + sidecar tombstone is the only way to keep the dataset internally consistent **and** keep the OTLP/JSON file format-pure. A "resume on headroom" approach would silently produce partial traces with gaps in the middle, which is worse than a clean drop.
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
  tracingMode: 'enabled' | 'disabled'           // default for new projects: 'disabled' (opt-in, v0.11+)
  bufferCapacity?: number                        // default: 1024 spans
}
```

**Default policy (v0.11+)**: new projects start with `tracingMode: 'disabled'`. Users opt in via Settings → Telemetry → Trace recording. Existing projects with explicit `tracingMode: 'enabled'` keep their value across migrations — the migration writer at §14.1 only sets the default when the `telemetry` block is missing entirely.

`tracingMode = 'disabled'` drains the queue and stops the flush worker; subsequent spans are no-op. There is no separate retention setting because there is no retention policy to choose.

### 5.2 Ledgers: entity-keyed, append-only event logs

| Ledger | Path | Key | Status |
|---|---|---|---|
| Artifact | `artifacts/ledger.jsonl` | `(artifactId, version)` | **new file** alongside existing per-file artifact JSON (audit #8 — current store at `lib/memory-v2/store.ts:412` is one JSON per artifact, overwritten in place at `:473`; v0.4 does **not** convert that store. The new ledger is append-only and writes one row per op; the per-file artifact JSON remains the read-side authority for current content. P1 migration adds the ledger writes to the existing edit/create paths.) |
| Memory | `memory-v2/ledger.jsonl` | `memoryId` | **new file** alongside existing memory store; same pattern as artifact ledger |
| User-response signals | `user-response-signals.jsonl` | `(turnId)` | new (§8.3) |
| View log | `view-log.jsonl` | `(viewId)` | new (§8.4) |
| Tracing state | `tracing-state.jsonl` | append-only | audit log of mode/retention/policy changes + degraded-state events (§5.1, §10.1) |
| Trace tombstones | `traces/tombstones.{date}.jsonl` | `traceId` | sidecar to spans.{date}.jsonl marking traces dropped due to queue overflow (§5.1). Kept separate so spans file stays pure OTLP/JSON. |

All ledgers retained forever. Project deletion removes them.

**Cross-reference**: each ledger row records `{ traceId?, spanId?, turnId?, toolCallId? }` so analysis can join either direction.

**Idempotency**: ledger writers are idempotent on the natural key. Replays during crash recovery do not duplicate.

### 5.3 Content blobs

Large content (turn text > 4 KB, tool I/O over cap, diagram SVG, base64 images) is content-addressed:

- Stored once at `.research-pilot/blobs/{sha256}` (single file per hash).
- Referenced from spans / ledgers as `{ contentHash, size }`.
- **Retention**: forever. Blobs are never auto-GC'd; project deletion removes them.
- Stored in plaintext in the user's local workspace; same trust model as the rest of `.research-pilot/`.

### 5.4 Resource attributes (per-process, immutable for process life)

Per OTel Resource semantics ([OpenTelemetry Resource Data Model](https://opentelemetry.io/docs/specs/otel/resource/data-model/)), Resource attributes are constant for the process lifetime and describe the *producer* of telemetry. They must not vary by project or session, because the Electron main process can manage multiple projects and windows simultaneously.

**Resource attributes (set once at TraceProvider initialization, immutable for process life):**

```
service.name = "research-copilot"
service.version = <app/package.json version>
service.instance.id = <ULID minted at process start>
process.runtime.name = "node"
process.runtime.version = <process.version>
os.type = <process.platform>
pipilot.runtime.app_build_commit = <git rev-parse HEAD at build time>
```

The full prompt hash (varies per project, since `baseSystemPrompt = SYSTEM_PROMPT + skillsCatalog + (optionally) agent.md` per `lib/agents/coordinator.ts:491`) lives on the root span:

**Span attributes (varying per task / project / session — set on every applicable span):**

```
gen_ai.conversation.id     = <session.id>
pipilot.project.id         = <project.json id>
pipilot.project.tag        = <free-form user-provided tag, optional>
pipilot.runtime.agent_profile   = <coordinator profile id; can vary across coordinators in one process>
pipilot.runtime.workspace_commit = <git rev-parse HEAD of workspace; per-project>
pipilot.runtime.memory_index_version = <wiki manifest version; per-project>
pipilot.runtime.full_prompt_hash = <sha256(baseSystemPrompt) — root invoke_agent span only>
```

These are propagated automatically by `Tracer` when a span is created in a given project context. Wiki background agent and other multi-project code paths set the appropriate context per project; spans from each project carry the right project id. (This is exactly the bug audit #1 caught.)

`pipilot.project.tag` is an **optional, free-form** label. There is no enum, no fixed taxonomy. Layer 3 may classify projects post-hoc using its own scheme.

### 5.5 Trace digest (query acceleration)

Trace files are slow to scan for cross-task questions ("how did prompt length evolve over 3 months?"). Digest provides a one-row-per-trace pre-aggregate, kept alongside the raw trace.

**Path**: `.research-pilot/trace-digest.jsonl` (retained forever, alongside raw traces).

**Trace closure semantics:** a digest row is materialized when the trace's root span ends — that is when `invoke_agent {agent.name}` ends as `chat()` returns. By construction (§6.5), any background work that legitimately outlives the user task (memory extract, wiki bg, async compute) lives on its own trace, so the root-end signal is sufficient under normal operation.

**Open-child-span detection at root-end:** child spans can leak (a buggy tool implementation that never closes). When the root span ends, TraceStore checks the AsyncLocalStorage span map for any descendants of this `traceId` whose `end_time` is unset and writes the digest with:

```jsonc
{
  "traceId": "...",
  "openChildSpanCount": 3,                           // 0 in the happy path
  "openChildSpanIds": ["...", "...", "..."],         // for debugging
  "degraded": true,                                   // present only when openChildSpanCount > 0
  ...rest of digest fields...
}
```

This makes leaks observable in the digest itself rather than silent. A leaked span that closes *after* digest write is still appended to the trace JSONL (the trace file is append-only); on next startup, crash recovery re-reads the trace and updates the digest in place if the open-child set has shrunk.

**Crash recovery**: on startup, TraceStore scans `traces/spans.{date}.jsonl` for: (a) traces whose root has `end_time` but no digest row → write digest; (b) traces with digest `degraded=true` whose previously-open child spans now have `end_time` → re-emit digest. Idempotent on `traceId` (the latest digest row wins; analysis tools are responsible for picking it).

If the root span itself never ends (`chat()` never returns due to an unrecoverable bug), no digest is written. The trace is still in the JSONL but unindexed. This is the bug-surfaces-itself path — preferable to silently emitting partial digests under watchdog timeouts.

**Schema** (one row per `traceId`, written at root span end). Eight core fields only — anything else can be derived from raw trace by re-scanning, and trace is retained forever:

```jsonc
{
  "traceId": "...",
  "sessionId": "...",
  "projectId": "...",
  "startedAt": "...",
  "endedAt": "...",
  "tokens": { "input": 0, "output": 0, "cache_read": 0, "cache_creation": 0 },
  "toolCallsByCategory": { "literature": 3, "data-analysis": 1 },
  "turns": [
    { "turnId": "...", "role": "user", "timestamp": "...", "charLen": 0, "contentHash": "sha256:..." }
  ],
  "tracePolicyVersion": "...",
  "digestWrittenAt": "..."
}
```

Digest is **derived data**, optimized for the analysis questions that come up most often (token totals over time, tool-call mix evolution, turn timeline). Anything more specific (compaction events, skill activation timeline, sub-LLM purpose breakdown, artifact/memory op streams) is read from the raw trace. Schema versioned via `tracePolicyVersion`; if the analysis pattern stabilizes around different fields, regenerate digest from source.

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

**Schema pinning (review fix)**: OTel GenAI semantic conventions are currently marked **Development / Experimental** (not Stable). This spec pins to a specific development-stage `schema_url` as of P0; the pin is recorded in `lib/telemetry/semantic-registry.ts` and surfaced through OTel's standard mechanisms:

- The `schema_url` is set on the OTLP `ResourceSpans` envelope at export time.
- The `schema_url` is associated with the OTel `Tracer` (instrumentation scope) at acquisition time via `tracerProvider.getTracer(name, version, schemaUrl)`.
- It is **not** a per-span attribute; the OTel data model places `schema_url` on the export envelope and the instrumentation scope, not on individual spans.

P0 gate includes a schema-conformance test validating emitted attribute names/types against the pinned schema. Bumping the pin (e.g., when semconv graduates from Development to Stable) requires: registry update, conformance test re-pass. Treat as a quarterly review.

**Pinned attributes (current Development semconv):**

- `gen_ai.provider.name` ∈ `{anthropic, openai, gcp.gemini, deepseek}` — OTel well-known values only. Add new providers here only after verifying they appear in OTel's GenAI semconv well-known list; otherwise emit `pipilot.auth.mode` and leave `gen_ai.provider.name` unset.
- `gen_ai.request.model`, `gen_ai.response.model`.
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` (Anthropic). Dotted segment between `cache_*` and `input_tokens` is intentional per current semconv.
- `gen_ai.response.finish_reasons`.
- `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` ∈ `{function, extension, datastore}` (per current GenAI semconv — `retrieval` is an *operation* name, not a tool type; PiPilot's wiki/literature/web tools map to `datastore`).
- `gen_ai.conversation.id` (= session.id).
- `error.type`, `span.status` on failure.

**PiPilot-namespaced auth attribute**:

- `pipilot.auth.mode` ∈ `{api-key, anthropic-subscription, openai-codex}` — how this call was authenticated. Single field carries billing source, transport, and subscription/Codex distinction. If a real-world need ever splits these, we'll add fields then.

This keeps `gen_ai.provider.name` cross-backend readable while preserving PiPilot's cost-accounting needs in one targeted field.

**Migration note**: schema is local-only; we are the only consumer of our own pinned schema. We do not chase semconv churn until graduation.

### 6.4 PiPilot extension attributes (`pipilot.*` namespace)

Validated against `lib/telemetry/semantic-registry.ts` in dev mode.

| Attribute | Where | Purpose |
|---|---|---|
| `pipilot.tool.category` | `execute_tool` spans | enum from tool factory: `file, shell, code, data-analysis, literature, web, memory, artifact, document, diagram, wiki, citation, compute` |
| `pipilot.tool.error_class` | failed `execute_tool` spans | mapped from `toolError` `error_code` |
| `pipilot.tool.retry_count` | `execute_tool` spans | tool-level retries (not LLM retries) |
| `pipilot.compaction.discarded_messages`, `.kept_tokens`, `.input_tokens`, `.output_tokens` | `summarize context` span | compaction counters |
| `pipilot.resumption.bootstrap_orphans`, `.summary_loaded` | first step of a session | objective booleans set once at first step (was a session resumption? did we load a prior summary?). Note: removed the `.first_artifact_op_at_step` / `.first_tool_call_at_step` state-machine fields — Layer 3 can compute them from raw trace if needed. |
| `pipilot.redaction.fields_redacted_count`, `.scrubber_version` | every span | audit trail of how many fields a span had scrubbed and which scrubber version ran |
| `pipilot.blob.write_failed_count`, `.write_failed_message` | `chat` / `execute_tool` / `invoke_agent step` spans, only when set | counter + last-error string for blob writes that failed during redaction. Set only on **sync** failures (queue saturation in the async-queue BlobStore). Async drain I/O failures land on already-ended spans and instead surface via the TraceStore degraded-mode log (`tracing-state.jsonl` — `trace-store-degraded-enter`). Trade-off accepted in v0.11 when blob writes moved off the LLM critical path. |
| `pipilot.turn.id`, `pipilot.turn.followsId` | every span | turnId propagation (§4.1) |
| `pipilot.matched_skills` | root `invoke_agent` span | objective record of which skills the router selected (a routing decision is a fact, not a judgment) |
| `pipilot.active_skills` | every `invoke_agent step` span | set of skills active at step start |
| `pipilot.thinking_level` | root `invoke_agent` + `invoke_agent step` spans | agent thinking level at span open (`xhigh \| high \| medium \| low \| minimal \| off`). Read at span-open time so mid-session UI changes land on the next span. |

**Removed in v0.3** (subjective; moved to Layer 3): `pipilot.user_message_type`, `pipilot.user_message_type.v2`, `pipilot.referring_expressions`, `pipilot.intent_labels`.

### 6.5 Local compute and other long-running async tasks: separate-trace + Link

**Audit #2 fix**: a single OTel `traceId` describes one causally connected operation. Reusing a traceId with `parentSpanId = null` is invalid. Long-running async tasks that legitimately outlive their submit operation (local-compute runs, background memory extraction, wiki background agent) live on **their own trace** with an OTel `Link` back to the originating span.

**Local compute:**
- `execute_tool local_compute_execute` (submit): completes when `submitRun()` returns the `runId`. Lives on the user-task trace as a normal child span.
- `execute_task local_compute` (run): **separate trace** (new `traceId`), root span. The OTel root carries `Links: [{ context: <submit-span-context>, attributes: { 'pipilot.link.kind': 'follows_from' } }]`. The run-root span carries `pipilot.project.id` and `gen_ai.conversation.id` (these are span attributes per §5.4; the OTel Resource for the run process remains process/build identity only). This lets the run trace join back to its originating project/session at analysis time. Run lifetime — `runner.ts` updates produce span events; terminal state ends the span.

**Background memory extraction (`maybeExtractMemories`, `lib/agents/coordinator.ts:948`)**: same pattern — runs on its own trace with `Link { kind: "spawned_from", spanId: <invoke_agent root> }`. A fire-and-forget background task must not extend the user-task trace's lifetime; living on a separate trace makes the user-task root-end signal clean (§5.5).

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
  stepId: string
}
```

When `trigger="explicit-load"`, the parent `execute_tool` span is already in OTel context (visible from the span tree); no separate id field is needed.

Every `invoke_agent step` carries `pipilot.active_skills` (array): the set active at step start.

### 6.8 Compaction discarded payload

**Event** on `summarize context` spans:
```jsonc
pipilot.compaction.discarded {
  turnIds: string[]
}
```

Just the dropped turn ids. Layer 3 can join to turn-level data (role, char_len, content hash) via the user-response-signals ledger and the trace's user message events, and to artifact mentions via the artifact ledger. No reason to duplicate the join here.

**Implementation note (v0.11)**: the runtime currently emits `msg-idx-N` placeholders rather than real turnIds (the in-process `AgentMessage` doesn't carry turnId). Consumers recover real turnIds by walking `user-response-signals.jsonl` for the same session and taking the first N entries with timestamps before the compaction span's start time. See `docs/spec/trace-and-ledger-joins.md` §4.1.

The actual generated summary text is captured separately via `pipilot.compaction.summary_text` (§6.9) on the same span — without it, per-event summary content is recoverable only from the latest-state file or the next turn's request_payload.

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
- `pipilot.tool.args` (on `execute_tool` spans) — `{ body: <redacted JSON> }`. Tool input arguments after validation. >4 KB → blob ref. PiPilot extension because no GenAI semconv covers tool I/O.
- `pipilot.tool.result` (on `execute_tool` spans) — `{ body: <redacted JSON> }`. Tool output (`content[]` + `details` + `isError`). >4 KB → blob ref.
- `pipilot.chat.request_payload` (on `invoke_agent step` and `chat` spans) — `{ body: <wire-format JSON> }`. The final provider request body captured via pi-ai's `onPayload` hook (post-`convertMessages`, post-`cache_control` markers). Distinct from `gen_ai.client.inference.operation.details` which carries pre-translation `PiContext`. >4 KB content within the body → blob ref.
  - **Emission policy (v0.12)**: emitted only on **step 1 of each user turn** (first `invoke_agent step` under each root `invoke_agent` span). Steps 2..N suppress this event because each step's wire payload differs from step (N-1) by exactly one assistant response + one tool_result, already captured as `pipilot.chat.response_text` + `pipilot.tool.result` on those steps. Recording on every step was O(steps²) bytes for O(steps) novel content; field traces showed ~95% of blob bytes came from this redundancy. The only information lost is cache_control marker placement shifts between mid-turn steps. Sub-LLM calls via `tracedCompleteSimple` (router, summarizer, wiki-bg) still emit on their single chat span — they aren't in a multi-step loop.
- `pipilot.chat.response_text` (on `invoke_agent step` spans) — `{ body: <redacted assistant content[]> }`. Per-step assistant message text captured at `turn_end`. The main agent loop bypasses `tracedCompleteSimple`, so without this event the response text for the final step of a turn is only in the session JSONL. Added in v0.11.
- `pipilot.compaction.summary_text` (on `summarize context` spans) — `{ body: <redacted summary text> }`. The text body of the running compaction summary, attached right after `generateSummary` returns. Added in v0.11. The wire payload of pi's internal summarizer call is **not** captured (pi doesn't expose a hook); see `lib/telemetry/PARITY.md#wire-level-capture-coverage`.

Event bodies pass through redaction (§7) before being attached. Over-cap content goes to blob store and the event carries `{ contentHash, size, redactionLevel }` references.

---

## 7. Secret Scrubbing & Size Capping

PiPilot is local-first; data lives in the user's workspace and is not transmitted. The pipeline below is therefore not a "privacy" system — it's a defense against secrets being embedded in trace events that the user might later choose to share (e.g., attaching a trace file to a bug report, or adding external export in a future spec), plus a size cap so individual span events stay queryable.

Single shared pipeline applied to **both args and results**, on **trace events and ledger rows**.

**Stages (in order):**

1. **Field-level deny list (always on)**: keys named `apiKey`, `password`, `Authorization`, `cookie`, `csc_*`, `APPLE_*_PASSWORD`, `secret`, `token` are replaced with `<redacted:field>` regardless of value.
2. **Pattern-based scrubber (always on)**: regex catalog matches Anthropic/OpenAI API keys (`sk-...`), GitHub tokens (`ghp_...`), AWS access keys, generic `Bearer <token>`. Replacement: `<redacted:type>`. Emails are **not** scrubbed (would degrade utility for academic data); paths and content are not scrubbed.
3. **Path scrubbing**: replace `$HOME`, `/Users/<name>` with `~`; preserve workspace-relative paths. (Comfort feature — keeps traces portable across machines.)
4. **Size cap**: per-field, default 4 KB. Over-cap → `{ truncated: true, contentHash, size }` and the full content goes to the blob store.
5. **Artifact reference shortcut**: if the field is already an artifact (artifactId present), emit `{ artifactRef }` only.
6. **Image / SVG / binary**: never inline; always `{ contentHash, mimeType, size }`.

Every span emits `pipilot.redaction.{fields_redacted_count, scrubber_version}`. Bumping the scrubber version (e.g., adding a new key pattern) is observable in the audit trail.

There is no "privacy level" knob, no `level=high` mode, no aggressive-redaction toggle. The scrubber catalog is fixed; if a new secret pattern needs covering, the catalog gets a new version and every project benefits on next start.

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

**Snapshot policy** (clarified in v0.3, simplified in v0.7): for text-type artifacts (note, paper, outline, manuscript, code, slides) under 100 KB, the full content of every version is preserved in the blob store. For data-type artifacts (data, dataset) over 1 MB, only `contentHash` and metadata are kept; full historical content is **not** written to blob store. The thresholds are fixed in v0.7 (no per-project configuration); they are tuned for typical research projects and can be revisited if storage estimates (§5.6) prove off.

### 8.2 Memory ledger

```jsonc
{
  "memoryId": "...",
  "op": "search | retrieve | create | update | delete",
  "scope": "session | project | user-global | cross-project | wiki",
  "type": "user | feedback | project | reference | preference | decision | todo | rationale | artifact-summary | user-stated-fact | extracted-claim",
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

**v0.11 addition**: the first 4 values (`user | feedback | project | reference`) match the user-facing buckets exposed by the `save-memory` tool (`lib/memory/memory-tools.ts`). The remaining 7 are inherited from v0.3 for finer-grained provenance categories used by future LLM-side extractors. The `save-memory` and `delete-memory` tool paths now actually write to this ledger (previously the writer was defined but uncalled — the v0.10 spec implied wiring that wasn't there).

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

View log can be disabled by setting `tracingMode='disabled'` (which disables all telemetry); there is no separate per-feature toggle in v0.7.

---

## 9. Layer 3 (out of scope, brief reference)

This spec **does not specify** Layer 3. It exists in a separate research codebase. PiPilot's only obligation to Layer 3 is to make Layer 1+2 data:

- Joinable by stable IDs (`traceId`, `spanId`, `turnId`, `artifactId`, `memoryId`, `viewId`, `sessionId`, `projectId`).
- Read-only accessible (Layer 3 must never modify Layer 1+2 data).
- Versioned (every record carries `tracePolicyVersion` so Layer 3 knows what shape it's reading).

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

## 10. Project Configuration & Audit Log

### 10.1 Tracing-state log

`tracing-state.jsonl` records every operational toggle and degraded-state event. Append-only; retained forever.

Recorded events:
- `tracingMode` change (enabled ↔ disabled)
- Scrubber catalog version bump (§7)
- TraceStore degraded mode entry / exit (§5.1)
- Drop-counter increments by category (§5.1)
- Project-config migration completion (§14)
- `model-change` (v0.11): user changed the active model mid-session. `fromState` and `toState` carry the composite model key (e.g. `openai:gpt-5.5`). The next root `invoke_agent` span will reflect the new model in `gen_ai.request.model`, but the change point itself is recorded here.

```jsonc
{ "timestamp": "...", "kind": "...", "fromState": "...", "toState": "...", "actor": "user | system", "reason": "..." }
```

This log is the audit trail for "did we lose any spans, and why."

### 10.2 Project-scoped configuration

`ProjectConfig` (`lib/types.ts:169`) gains three fields:

```typescript
// lib/types.ts (proposed extension)
export interface ProjectConfig {
  // Existing fields preserved...

  // NEW (v0.7):
  id: string                              // ULID, generated on first load if missing
  telemetry: ProjectTelemetryConfig       // see §5.1
  configSchemaVersion: number             // for migration; v0.7 = 1
}

export interface ProjectTelemetryConfig {
  tracingMode: 'enabled' | 'disabled'   // default for new projects: 'disabled' (v0.11+)
  bufferCapacity?: number                  // default: 1024 spans
}
```

**Migration**: see §14.

**IPC**: project-scoped settings get their own IPC channels (`project:get-config`, `project:update-config`), distinct from the existing global-settings IPC. The settings UI surfaces these in a project-scoped panel; global settings remain in the main settings dialog. UI mockup required at P0 gate.

**External export**: not part of v0.8. All trace data stays in the user's workspace. If an analyst wants to ship traces somewhere, the JSONL files are directly readable by any OTel-compatible tool (the wire format is OTLP/JSON). External-export-as-a-feature is deferred (§11 Deferred).

---

## 11. Phased Delivery

### P0 — Interface freeze (no functional output)

- Span schema (§6), `pipilot.*` semantic registry, ID hierarchy (§4.1).
- **OTel schema pinning**: chosen `schema_url` committed to `lib/telemetry/semantic-registry.ts`; conformance test runs in CI.
- **Resource vs span attribute split** locked: Resource = process/build identity only (§5.4); `pipilot.project.id`, `gen_ai.conversation.id`, `pipilot.runtime.full_prompt_hash`, `pipilot.runtime.workspace_commit`, `pipilot.runtime.memory_index_version` are span attributes (varying per task / project).
- **Local-compute trace model** locked: separate trace + OTel Link, not shared traceId (§6.5).
- **turnId IPC envelope**: `agent:send` IPC handler signature updated to require `clientMessageId` + `clientTimestamp`; preload bridge typed.
- **ProjectConfig migration**: `lib/types.ts` schema bump to v1 with `id`, `telemetry.{tracingMode, bufferCapacity}`, `configSchemaVersion`; migration helper + idempotency proof. (No `privacy` field — privacy governance was removed in v0.7.)
- **Bounded queue + trace-level atomic drop**: TraceStore queue, drop semantics (§5.1), disk-full degraded mode, runtime disable toggle — all specified and unit-testable.
- **Trace closure**: digest written when root `invoke_agent` span ends (§5.5). Background work is on its own trace per §6.5; no refcount or watchdog needed. Crash recovery scans for traces with root end_time but no digest at startup.
- `tracedCompleteSimple` helper signature.
- Tracing-state log schema (§10.1).
- Migration plan for existing projects (§14).
- Settings UI mockup for project-scoped Telemetry panel (§10.2). Panel contains: tracingMode toggle, current storage footprint (informational).

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

### P2 — Renderer integration

- IPC channels: `trace:live`, `trace:snapshot(traceId)`.
- New `trace-store.ts` Zustand store; two-week diff vs `activity-store` before switching to derived selectors.
- View log writers wired up via renderer events.
- `compute-store` unchanged.
- `RealtimeBuffer` retained until trace channel demonstrates equivalent remount-recovery.

**Gate**: a renderer remount during an active trace produces an identical view via either path.

### P3 — Engineering diagnostic rules

CLI / notebook checks computed off the trace store:
- Prefill explosion.
- Slow-tool tail.
- Repeated work.
- Sequential dependency.
- Cache miss attribution.

### Deferred / out of scope

- OTLP / external export. The local OTLP/JSON format makes it tractable to add later if a real need surfaces.
- Layer 3 annotation tooling (separate codebase).
- Renderer-side spans composing into the same trace.
- W3C `traceparent` propagation to external HTTP.
- Cross-project trace correlation UI.

---

## 12. Open Questions

All remaining open questions are engineering decisions; subjective/research questions were removed in v0.3 by clarifying the boundary.

### 12.1 Prompt/completion as events vs attributes

OTel recommends events for prompt/completion content (sampling-friendly, easier to scope). Attributes are easier to grep with `jq`. **Recommendation**: events; local CLI viewer auto-expands them.

### 12.2 Storage stats validation

§5.6 estimates need empirical validation. P1 introduces self-monitoring writing daily byte totals. If real-world numbers significantly exceed estimates, the Settings panel surfaces a banner showing the current footprint. v0.8 has no in-app remediation; the user's options are: leave it, delete the project, move the workspace to a larger volume.

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
| RunStore pattern doesn't scale | Append-only JSONL, batched flush, bounded queue with trace-level drop policy | §5.1 |
| RealtimeBuffer semantics must be preserved | Phase gate requires equivalence diff before switching | P2 |
| `args` cannot be exempt from redaction | Scrubbing pipeline applies to args + result + events + ledgers | §7 |
| Trace ≠ Ledger | Two layers, both forever-retained | §3.1, A1 |
| OTel skeleton | OTel GenAI conventions throughout; PiPilot extensions namespaced | §6.1, A3 |
| Tracing must never block agent | A4; writer crash isolated; bounded queue | §1.3, §5.1 |
| Span schema growth controlled | Semantic registry validates `pipilot.*` keys in dev | §3.2 |
| **NEW v0.3: Subjective fields contaminating runtime** | Removed from runtime; Layer 3 boundary made explicit | §0, §1.2, §6.4, §8.2, §8.3 |
| **NEW v0.3: Ledger lifecycle was a research judgment** | Memory ledger is a pure event log; lifecycle moved to Layer 3 | §8.2 |
| **NEW v0.3: Outcome ledger had embedded judgments** | Renamed to user-response-signals; raw facts only | §8.3 |
| **NEW v0.3: User shouldn't be a research labeler** | No thumbs UI in spec; signals ledger captures behavior, not user-provided labels | §8.3, §1.2 |
| **NEW v0.3: Trace retention was hardcoded 7d** | (Superseded by v0.5: retention is now forever, not configurable) | §5.1 |
| **NEW v0.5: Configurable retention added accidental complexity** | Retention configurability removed entirely; everything is forever; project deletion is the only purge | §3.1, §5.1, §5.2, §5.3, §10.2 |
| **NEW v0.6: §10 still claimed Resource carried privacy profile (review High #1)** | (Superseded by v0.7: privacy contract removed entirely; data is local-first, redaction is fixed scrubber catalog) | §7, §10 |
| **NEW v0.7: Privacy contract was over-engineered for a local-first app** | Privacy profile, export gate's permission checks, level-based redaction, blob encryption all removed. What remains: secret/key scrubbing always on. | §7, §10 |
| **NEW v0.7: Existing projects had no migration story** | New §14 codifies ProjectConfig migration, usage-cutoff field, history-import CLI | §14 |
| **NEW v0.8: OTLP export added complexity for an unconfirmed need** | OTLP exporter, env var, P2 phase, OpenInference dual-emit question all removed. Local OTLP/JSON format kept so external export can be added later if a real need arises. | §1.1, §3.2, §11, §12 |
| **NEW v0.8: Trace closure refcount + watchdog was over-built** | Digest writes at root span end. Background work is on its own trace per §6.5, so refcount is structurally trivial. | §5.5 |
| **NEW v0.8: Drop policy with criticality classification was over-built** | Trace-level drop: a full queue drops the newest in-flight trace atomically. No criticality flag, no overflow ring, no five drop counters. | §5.1 |
| **NEW v0.8: Auth/billing/transport split into 3 fields** | Single `pipilot.auth.mode` field. Will split later if real-world need surfaces. | §6.3 |
| **NEW v0.8: Compaction discarded payload over-specified** | Just `turnIds`. Layer 3 joins to ledgers for the rest. | §6.8 |
| **NEW v0.8: Skill load event redundant fields** | `sourceToolCallId` removed; parent context comes from OTel span tree. | §6.7 |
| **NEW v0.8: Resumption state-machine fields high cost / low value** | Removed `.first_artifact_op_at_step` and `.first_tool_call_at_step`. Kept the two cheap booleans. | §6.4 |
| **NEW v0.8: Digest schema bloat** | 15 fields → 8 core. Anything Layer 3 might want can be re-derived from raw trace; trace is forever-retained. | §5.5 |
| **NEW v0.8: Resource shell_prompt_hash was redundant with service.version** | Removed. Only the per-task full prompt hash on root span remains. | §5.4 |
| **NEW v0.9: P0 task list pulled deleted designs back in (review High #1)** | Synced with v0.7/v0.8 deletions: removed privacy attribute, removed refcount+watchdog references | §11 P0 |
| **NEW v0.9: Drop policy was incompatible with append-only writes (review High #2)** | Trace tombstone + permanent traceId suppression; viewer/digest must skip tombstoned traces | §5.1 |
| **NEW v0.9: Axiom A5 still claimed privacy contract (review Medium #1)** | Rewritten to "Local-first with always-on secret scrubbing" | §1.3 A5 |
| **NEW v0.9: gen_ai.tool.type used wrong enum (review Medium #2)** | Aligned with semconv: `{function, extension, datastore}`; retrieval tools now `datastore` | §6.3 |
| **NEW v0.9: Leaked child spans invisible at root-end digest (review Medium #3)** | openChildSpanCount/Ids + degraded flag in digest; crash-recovery re-emits when open set shrinks | §5.5 |
| **NEW v0.9: §6.5 wording self-contradicted on Resource vs span attribute (review Low #1)** | Clarified: span attributes on run-root, Resource stays process/build only | §6.5 |
| **NEW v0.10: Tombstone broke pure OTLP/JSON file format (review High)** | Tombstones moved to sidecar `traces/tombstones.{date}.jsonl`; spans file stays format-pure | §5.1, §5.2 |
| **NEW v0.10: gen_ai.provider.name enum missed DeepSeek (review Medium)** | Added `deepseek` (already supported in product, also OTel well-known) | §6.3 |
| **NEW v0.6: system_prompt_hash misplaced as Resource (review High #2)** | (Superseded by v0.8: shell-prompt hash deleted; only `pipilot.runtime.full_prompt_hash` on root span remains) | §5.4 |
| **NEW v0.6: GenAI semconv claimed "stable" (review High #3)** | Corrected to "pinned development/experimental"; quarterly review on graduation | §6.3 |
| **NEW v0.6: Subscription/Codex stuffed into gen_ai.provider.name (review Medium #1)** | OTel-standard provider values only; single `pipilot.auth.mode` field carries the distinction (v0.8 collapsed three fields to one) | §6.3 |
| **NEW v0.6: schema_url described as per-span (review Medium #2)** | Clarified — set on OTLP envelope and Tracer scope, not span attribute | §6.3 |
| **NEW v0.6: Drop policy could orphan child spans (review Medium #3)** | (Superseded by v0.8: trace-level atomic drop, no criticality classification) | §5.1 |
| **NEW v0.4: Resource attributes carried per-project state (audit #1)** | project/session moved to span attributes (privacy removed in v0.7); Resource = process/build only | §5.4 |
| **NEW v0.4: Local-compute reused traceId with null parent (audit #2)** | Async run is its own trace + OTel Link `follows_from`/`spawned_from` | §6.5 |
| **NEW v0.4: Retention statements contradicted (audit #3)** | (Superseded by v0.5: no retention configurability at all, no contradictions to resolve) | §3.1 |
| **NEW v0.4: Project settings designed as global (audit #4)** | ProjectConfig migration; project-scoped IPC + UI | §10.2 |
| **NEW v0.4: turnId not implementable across renderer/main (audit #5)** | Renderer's existing message id passed in `agent:send` envelope | §4.1 |
| **NEW v0.4: GenAI semconv outdated (audit #6)** | Migrated to current semconv; schema_url pinned + conformance test | §6.3 |
| **NEW v0.4: Local exporter lacked bounded queue (audit #7)** | Bounded queue + drop counter + degraded mode + disable toggle | §5.1 |
| **NEW v0.4: Artifact JSONL upgrade misrepresented (audit #8)** | Acknowledged per-file JSON store; ledger added alongside | §5.2, §8.1 |
| **NEW v0.4: Digest closure underspecified (audit #9)** | (Superseded by v0.8: just root-end, since background work is on separate traces) | §5.5 |
| `turnId` undefined across ledgers | `turnId = clientMessageId`, propagated as `pipilot.turn.id` | §4.1 |
| Compaction loses what was dropped | `pipilot.compaction.discarded` event with turn IDs and artifact refs | §6.8 |
| Skill activation only captured at root | `pipilot.skill.load` events + per-step `pipilot.active_skills` | §6.7 |
| §5.3 retention contradicted §10 | (Superseded by v0.5+v0.7: forever-retention only, no privacy contract) | §5.3 |
| Coverage can be silently disabled | `tracingMode` + `tracing-state.jsonl` audit log | §10.1 |
| Passive verification invisible | View log `.research-pilot/view-log.jsonl` | §8.4 |

### 13.1 Known unresolved tensions

1. **Storage at forever-retention for very heavy users**: estimates suggest ~12 GB/year for the heaviest profile, ~36 GB at three years. Acceptable on modern SSDs; may surprise users on smaller laptops. v0.8 has no in-app remediation — the user's options are: leave it, delete the project, move the workspace. P1 self-monitoring + Settings banner gives visibility (§5.6, §12.2).
2. **OTel semconv pin freshness**: pinning `schema_url` ensures internal correctness; since we don't export to external backends in v0.8, drift is purely a future-portability concern, not a runtime issue.
3. **Pre-trace usage history**: §14 codifies a `preTraceCutoffTotals` field on `usage.json`, but this means usage analytics permanently bifurcate into "pre-cutoff (rough)" and "post-cutoff (full trace)". UI must present this honestly. Acceptable tradeoff for not pretending old data is full-fidelity.

---

## 14. Migration & Backwards Compatibility

PiPilot has existing projects in users' workspaces today. They have `.research-pilot/` directories with artifacts, sessions, usage totals, compute runs, etc. — but no traces, no ledgers, no `id` field on `project.json`, no `telemetry` config. v0.7 must handle these gracefully on first load.

### 14.1 ProjectConfig migration (one-shot, idempotent)

On every project load, run a migration check before any other PiPilot code touches the config:

```
1. Read project.json.
2. If 'configSchemaVersion' is missing or < 1:
   a. If 'id' is missing, generate ULID, set 'configSchemaVersion' = 1.
   b. If 'telemetry' is missing, set { tracingMode: 'disabled', bufferCapacity: 1024 }.
      (v0.11+: opt-in default. Existing projects with explicit
      `tracingMode: 'enabled'` are NOT auto-flipped — the `if (!config.telemetry)`
      guard runs only when the block is missing entirely.)
   c. Write project.json atomically (temp + rename).
   d. Append a row to .research-pilot/tracing-state.jsonl:
      { "kind": "config-migration", "fromVersion": 0, "toVersion": 1,
        "actor": "system", "reason": "first-run-on-v0.7" }
3. If 'configSchemaVersion' >= 1: skip (already migrated).
```

Idempotent: running migration twice is a no-op. Crash-safe: temp-rename atomicity means a partial write leaves the old config intact.

### 14.2 Existing artifacts and memories — no backfill by default

Old projects have potentially hundreds of `artifacts/{notes,papers,...}/*.json` files and `memory/*.json` entries. v0.7 deliberately does **not** backfill these into the new ledgers:

- `artifacts/ledger.jsonl` is empty at first load on an old project. Future `op` records start being written from the next artifact create/edit/delete.
- `memory-v2/ledger.jsonl` similarly starts empty.
- Per-file artifact storage remains the read-side authority (§5.2 audit #8 fix). Existing artifacts are still fully readable; they just lack version history in the ledger.

**Tradeoff**: research analyses that rely on ledger history will see "born in v0.7" data as having full lineage and "pre-v0.7" data as having only the current snapshot. This is honest — we genuinely don't know the version history of artifacts created before instrumentation.

**Optional backfill**: a CLI command `pipilot migrate-import-history --project=X` (lands in P1 alongside ledger writers) walks the existing artifact JSON files and writes one synthetic ledger row per artifact:
```jsonc
{ "artifactId": "...", "version": 1, "op": "imported",
  "type": "...", "path": "...", "contentHash": "sha256:...",
  "versionBefore": null, "initiator": "external",
  "traceId": null, "spanId": null, "turnId": null, "toolCallId": null,
  "timestamp": "<file mtime>",
  "importMeta": { "source": "v0.7-migration", "fileMtime": "..." } }
```
The `op: "imported"` value flags these rows so analysis can distinguish them from real op events. CLI is opt-in; there is no auto-import on project load (some users may not want synthetic rows mixed with real history).

### 14.3 Usage totals — pre-trace cutoff field

Existing `.research-pilot/usage.json` has accumulated totals from before traces existed. The P1 dual-write window (§11) compares old-path totals (direct from `turn_end.usage`) against new-path totals (aggregated from trace spans across all sub-LLM call sites). For old projects this comparison has a structural floor: the new path has no historical traces, so trace-aggregated totals start at zero.

v0.7 adds a field to `usage.json`:

```jsonc
{
  "tokens": <current cumulative total>,
  "cost": <current cumulative cost>,
  "preTraceCutoffTotals": {
    "tokens": <total at the moment the project was first loaded under v0.7>,
    "cost": <cost at the same moment>,
    "cutoffTimestamp": "..."
  }
}
```

The cutoff field is set once during config migration (§14.1) and never updated again. Dual-write reconciliation now reads:
```
expected_diff = old_path_total - new_path_total
acceptable    = preTraceCutoffTotals.tokens
delta         = expected_diff - acceptable  // should be ≈ 0 for new chats
```
Discrepancies in `delta` indicate real bugs in the new path; matches mean the new path is correct and the historical floor is just `preTraceCutoffTotals`.

UI displays usage as either:
- One number (`tokens`) with a tooltip noting "X of these were estimated pre-cutoff", or
- Two numbers ("Pre-cutoff: 5,000,000  •  Since v0.7: 12,345") if the user opens detailed stats.

### 14.4 Explain snapshots — retirement plan

`memory-v2/explain/*.turn.json` files exist on old projects. Spec §6.6 deprecates them in favor of root span attributes.

- **P1**: continue writing explain snapshots alongside trace spans. Reading code (`lib/commands/memory-explain.ts`) is unchanged — it reads from the file. This preserves any external tooling that depended on the format.
- **P2**: explain-snapshot writes stop. Old files remain on disk (forever, like all telemetry). `lib/commands/memory-explain.ts` is updated to read from trace spans for new traces and fall back to the file for old turns.
- **P3+**: `lib/commands/memory-explain.ts` removed. Old files become inert data on disk; user can delete them manually if desired.

Old explain files are never auto-deleted; like the rest of `.research-pilot/`, they are project-scoped and removed only on project deletion.

### 14.5 Sessions and session.json — no change

`session.json` schema is unchanged in v0.7. Existing sessionId values flow through to `gen_ai.conversation.id` on every span as before. Old `sessions/{sessionId}.jsonl` orphan-message logs continue to be written and read by the bootstrap path (`lib/agents/coordinator.ts:786`).

Old chat history is therefore queryable by sessionId at analysis time, even though no traces exist for those turns. This matches the "trace data starts at v0.7 install" cutoff cleanly.

### 14.6 Compute runs and other domain stores — unchanged

`compute-runs/runs.jsonl` and `experience.jsonl` are domain stores owned by local-compute, not by telemetry. v0.7 does not change their schema, retention, or read paths. Trace integration with local-compute (the dual-span model in §6.5) only affects new runs.

---

## 15. References

- OpenTelemetry GenAI Semantic Conventions (Development) — `gen_ai.*` attributes, operation enums, `gen_ai.client.inference.operation.details` event.
- OpenTelemetry Trace Semantic Conventions v1.30+ — `error.type`, `service.*`, span status.
- OpenTelemetry Resource Data Model — process-life immutability of Resource attributes (informs §5.4).
- OpenTelemetry Schema URLs — `schema_url` placement on ResourceSpans envelope and Tracer scope (informs §6.3).
- OpenInference Specification — retrieval / embedding span conventions used as fallback.
- W3C Trace Context — `traceparent` header (deferred for HTTP propagation).
- Existing PiPilot specs: `docs/spec/local-compute.md`, `docs/spec/fulltext-retrieval.md`.
- pi-agent-core `AgentEvent` types — `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`.
- `shared-ui/settings-types.ts` — existing Settings infrastructure (Research Intensity / Web Search Depth precedent for the project-scoped Telemetry panel pattern).
