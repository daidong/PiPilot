# Provenance & Prune — the first two stages of the audit system

Status: living overview. Summarizes **how the audit system works end-to-end so
far**, in two stages:

1. **Collect provenance** — record everything the agent did as telemetry +
   an artifact ledger, then materialize it into a provenance graph.
2. **Prune the graph** — deterministically partition that graph into the
   critical path (kept) and the noise around it (greyed), zero LLM.

Both stages are deterministic. The LLM only enters later (claim-level
faithfulness audit, see [audit-pipeline.md](./audit-pipeline.md)).

Design axiom (project CLAUDE.md): *minimum discipline to guarantee survival +
evidence-driven incremental improvement* — not complex architecture for its own
sake. Everything below is a derivation over data that already had to be written
to disk; nothing is a second source of truth.

---

## Stage 1 — Collect provenance

### Thinking

- **Telemetry is the source of truth.** Every LLM call, every tool call, every
  file touch, every artifact write is recorded as it happens. Nothing is
  reconstructed after the fact.
- **Two append-only streams, byte-stable on disk:** OTLP/JSON *spans* (the
  causal/temporal trace) and an *artifact ledger* (the lifecycle of every
  produced artifact). They cross-reference by `traceId` / `spanId` / `turnId`,
  so a ledger row joins back to the exact span that produced it.
- **The graph is a projection, never a store.** We never persist a graph; we
  re-derive it on demand from the spans + ledger. This keeps the recorded data
  authoritative and the graph disposable.

### How it's done — precise to the script

| Concern | Script | What it writes / does |
|---|---|---|
| Tracer init | `lib/telemetry/tracer.ts` (`PipilotTracer`) | One TracerProvider per Electron main process; resource = build identity; per-project/session attrs via `withProjectScope()`. |
| LLM spans | `lib/telemetry/llm-trace.ts` (`tracedCompleteSimple`) | `invoke_agent` / `invoke_agent step` / `chat` spans with `gen_ai.*` attrs + the `pipilot.chat.response_text` event (the final message claims are read from). |
| Sub-LLM spans | `lib/telemetry/sub-llm.ts` | Router / memory-extractor / audit-judge calls on a detached channel (judge calls emit **no** telemetry — isolation). |
| HTTP spans | `lib/telemetry/http-trace.ts` | `web_fetch` / `web_search` network calls. |
| Tool spans | coordinator hooks in `lib/agents/coordinator.ts` (`beforeToolCall` / `afterToolCall`) | `execute_tool <name>` spans carrying `gen_ai.tool.*`, the `pipilot.tool.args` / `pipilot.tool.result` events, `pipilot.tool.error_class`, retry count, category. |
| Size cap + blobs | `lib/telemetry/redaction.ts` + `lib/telemetry/blob-store.ts` | Caps span event bodies at 4 KB (`redactionLevel: 'size-cap'`), spilling full bytes to `.research-pilot/blobs/` (content-addressed by `sha256:`). |
| Span sink | `lib/telemetry/trace-store.ts` (SpanProcessor) + `lib/telemetry/exporters/jsonl.ts` (`JsonlSpanExporter`) | Appends OTLP/JSON, one `ResourceSpans` envelope per line, to `.research-pilot/traces/spans.{date}.jsonl`. Forces `\n` EOL + `O_APPEND` so files are byte-identical across OSes and concurrent writers can't interleave. |
| Per-trace digest | `lib/telemetry/digest.ts` (`TraceDigestProcessor`) | One row per `traceId` at root-span end → `.research-pilot/trace-digest.jsonl` (a query accelerator, not a snapshot; `degraded=true` if children leak). |
| Artifact ledger | `lib/ledger/artifact-ledger.ts` | Append-only artifact lifecycle events → `.research-pilot/artifacts/ledger.jsonl`; each row carries `traceId/spanId/turnId/toolCallId` for a 1-hop join to the originating span. |
| Live view / forward | `lib/telemetry/live-processor.ts`, `lib/telemetry/forwarder/` | Live UI summaries; optional OTLP forwarding to an external collector. |

Schema of record: [telemetry-trace.md](./telemetry-trace.md); the join rules
between spans and ledger: [trace-and-ledger-joins.md](./trace-and-ledger-joins.md).

### Materializing the graph (bridge into Stage 2)

`lib/audit-graph/project.ts` (`projectGraph`) reads the three on-disk streams
and produces an in-memory `AuditGraph` (`lib/audit-graph/types.ts`):

- **Nodes** (`NodeKind`): `session`, `trace`, `step`, `tool`, `chat`,
  `artifact`, `file`, `dir`, `span`, `skill`.
- **Edges** (`EdgeRel`): `contains`, `precedes`, `invokes`, `returns`,
  `sub-llm`, `reads`, `writes`, `creates`, `retrieved`, `mentions`, `listed`,
  `applies`.

**Skills** (`skill` node + `applies` edge). Skill usage is already in the trace
as `pipilot.skill.load` events; the projection lifts them into the graph so
prune and support metrics can see which skill guided a step. A skill node is
**project-shared** (`id = skill:<name>`, like `file`/`artifact`), so "which
steps used skill X" reads as a fan-in. Two triggers, two attach points:
  - **router-match** — the intent router pre-selects the skill at turn start;
    the event rides the **root** `invoke_agent` span (no step exists yet), so
    the `applies` edge attaches to the trace's **first step** (the skill is in
    the system prompt from turn start).
  - **explicit-load** — the agent calls `load_skill` mid-turn; the event rides
    the active step span, so `applies` attaches to **that** step.
  - A skill both router-matched and explicitly loaded across different turns
    carries `skillTrigger: 'mixed'`.

The projection is permissive (drops malformed lines rather than throwing) so a
half-written trace during a live session can't break the Audit tab. It is the
**input to the prune** — the full graph the user first sees.

---

## Stage 2 — Prune the graph

### Thinking

- The Audit tab shows the **full** provenance graph. A real run is mostly
  scaffolding (session/trace containers), timeline edges, parallel/background
  traces, and abandoned tool attempts. The signal — *what actually produced the
  answer* — is a thin spine through all of that.
- **Prune is a view, not a deletion.** Pressing "Prune" greys the noise; it
  never removes nodes. The critical path is highlighted and only routes through
  kept nodes/edges. The user can always see what was set aside.
- **Zero LLM, bit-reproducible.** The same graph prunes to byte-identical
  output every time. Output arrays are sorted; no wall clock is read.
- **No deliverable identification.** We do not try to name an "output
  artifact". The terminal step of the focused trace is the natural sink. A real
  deliverable is, by construction, a *product of a kept step's tool*, so it is
  **always kept** — it can never be greyed.
- **Errors are flagged, not pruned.** Whether an error was abandoned or
  actually poisoned later reasoning is a semantic judgement, deferred to the LLM
  stage. Here we only tag.

### How it's done — `lib/audit-graph/prune.ts` (`pruneGraph`)

Stages, mapped to the code:

- **Stage 0 — edge typing** (`edgeCausalClass`). Three classes:
  - `causal`: `invokes`, `returns`, `reads`, `retrieved`, `writes`, `creates`,
    **`sub-llm`**, **`listed`**, **`applies`** (a skill conditions the step's
    reasoning, so it belongs in the step's backward support closure).
  - `structural`: `contains`, **`mentions`** (a path referenced but not read).
  - `temporal`: `precedes`.
  - There is no `derived_from` edge in the projection, so it is not in the
    causal set.
- **Stage 0 — node typing** (`nodeRole`). An explicit role layer decoupled from
  the projection's `kind`, collapsing the 10 kinds into 6 audit roles:
  `container` (session/trace), `step`, `tool` (also chat/span — tool-like
  executions that carry the observation role), `artifact`, `file` (also dir),
  `skill`. `deliverable` is intentionally absent (we never name an output artifact).
  Both classifications are surfaced: per-class edge counts and per-role node
  counts ride in `PruneResult.stageStats` (`edgeClasses` / `nodeRoles`).
- **Stage 1 — drop non-causal.** Only `causal` edges are kept; `temporal`
  (`precedes`, the step timeline) and `structural` (`contains`, `mentions`)
  edges are **greyed even between two kept steps**. The step ordering is
  scaffolding — the causal flow already threads the steps together via
  `invokes → tool → returns`, so greying the temporal line leaves the spine
  connected. The step *nodes* stay kept (they are closure seeds); only the
  green temporal line greys.
- **Stage 2 — span collapse: dropped.** The projection emits a flat
  `trace contains span`, never a span→span tree, so there is nothing to fold.
- **Terminal selection.** The critical-path sink is *not* simply the
  chronologically-last step. Real telemetry interleaves the main agent loop with
  single-step background sub-agents (memory extractor, intent router, title
  generator), each in its own 1-step trace, and one of those usually runs last —
  seeding from it collapses the whole prune to a single node. So `pruneGraph`
  picks the latest step that belongs to a **multi-step trace** (a genuine agent
  turn), falling back to the global latest step only when no trace has >1 step.
- **Stage 3 — kept = focused trace's causal subgraph.** Seed from the **entire
  step spine** of the terminal trace (not just the last step — a pure-text final
  step has no causal predecessors and would otherwise yield an empty closure).
  Flood `causal` edges in **both** directions: backward pulls inputs
  (reads / returns / retrieved / listed / invokes / **applies** — the skills
  that guided the step), forward pulls products (writes / creates) and sub-LLM
  children. A trace-scoped node (step/tool/chat) is admitted only if it belongs
  to the focused trace, so a *shared* node (file/artifact/skill) can be
  kept without dragging in the parallel trace that also touched it.
- **Stage 4 — dead-end pruning, absorbed into deliverable safety.** A product of
  a kept tool stays kept even if nobody reads it (that is the deliverable shape).
  Such nodes get the `unused_output` flag — signalled, not greyed. Only nodes a
  surviving step never touched end up pruned.
- **Stage 5 — error handling.** Only the `error` flag is set; nothing is pruned
  or archived on account of an error.
- **Stage 5(6) — suspicious tagging** (`computeFlags`). Per-node flags:
  - `error` — tool span errored. `retried` — tool retryCount > 0.
  - `reread` — a file read ≥2×. `overwritten` — a file written ≥2× (or an
    artifact with >1 version).
  - `ungrounded_step` — a **non-first** step with no incoming `returns` (consumed
    no tool output). The first step of each trace is excluded — it has no prior
    step to feed it, so flagging it is a guaranteed false positive.
  - `repeated_intent` — the same **tool name** invoked ≥3× within a window of 3
    consecutive step indices (K=3), per trace; flags the clustered tool nodes.
    Name-based only (args are the `redundancy` metric's concern, not this flag).
  - `unused_output` — a product (written file / created artifact) nothing reads.
  - **Deliberately excluded:** `high_latency` and `long_output` — they answer
    "how slow / how big", not "is it wrong".
- **Stage 6(7) — support metrics** (`computeSupportMetrics`). Per focused-trace
  step: `nGroundingTools`, `toolKindDiversity`, `redundancy` (upstream artifacts
  consumed by ≥2 distinct intent classes, where an intent class is the
  deterministic proxy `toolName + hash(args[:200])`), `suspiciousRatio`
  (fraction of upstream nodes carrying ≥1 flag). Raw numbers, no aggregate score.

Output (`PruneResult`): `keptNodes` / `keptEdges` / `prunedNodes` /
`prunedEdges` (sorted ids and `edgeKey` strings), `spineNodes`, `flags`,
`supportMetrics`, and `stageStats` (G0 / causalEdges / kept / pruned counts).

Tests: `lib/audit-graph/__tests__/prune.test.ts` — cover edge classification,
the kept/pruned partition, **deliverable safety** (an unread product of a kept
tool is never pruned), errored-tool retention + flagging, spine survival on a
pure-text terminal step, support metrics, and **bit-reproducibility** (two runs
serialize identically).

### UI

A single **Prune toggle** acts on the full graph in
`app/src/renderer/components/center/audit/ProvenanceGraph.tsx`: off → full graph
unchanged; on → the pruned set is rendered at low alpha (grey) and the critical
path is highlighted, with edges never routing through grey nodes (an edge is
greyed unless it is in `keptEdges`, and kept edges only connect kept nodes). The
right rail (`AuditSidePanels.tsx`) shows before/after stats — full-graph node
count when off; `kept · greyed · flagged · on-path` plus the terminal step's
support metrics when on — and, always, the **Stage-0 typing breakdown**
(`edge classes: causal/temporal/structural` and `node roles:
container/step/tool/artifact/file`). Per-node flags from the prune drive the
canvas suspicion rings and the inspector's flag list, sourced in `AuditView.tsx`
from `pruneGraph(graph).flags`.

Edges on the canvas are **coloured by their Stage-0 class** (not per-rel):
causal edges keep their relation hue and an arrow, temporal edges (the step
timeline) render as a dashed neutral grey with no arrow, and structural
scaffolding is barely visible.

An **always-visible legend** sits at the canvas bottom-left: the three edge
classes (with line-style samples) and the five node roles (with colour swatches),
each with its live count from `stageStats`. It requires no node selection — it is
the at-a-glance key to both classifications. (The inspector repeats the same
counts when a node is selected.)

This replaced the old remove-based `Audit | Full` mode and deleted the
standalone `auto-suspect.ts`. (`system-audit-projection.ts` is no longer used by
the canvas; it is left in place with its test until its remaining helpers are
either folded into `prune.ts` or removed.)

---

## What is explicitly deferred to the LLM stage

- Whether an error node was abandoned vs. poisoned later reasoning.
- Semantic intent-class merging (beyond the deterministic args-hash proxy).
- Whether an observation was actually used by the model.
- Cross-step reasoning inheritance.
- Claim-level evidence binding (the faithfulness audit).
