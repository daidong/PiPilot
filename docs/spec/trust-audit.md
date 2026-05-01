# Trust & Audit: Provenance Graph + Adversarial Auditor

> Spec version: 0.9 (draft) | Last updated: 2026-05-01
>
> **What changed since 0.8** (after first end-to-end audits on a real paper):
> - **A3 added** (paper-centric audit): the audit subject is the *paper*, not the agent's record-keeping. Provenance gaps are not findings; only contradicted or missing evidence is. See §1 Axioms and §4.
> - **`reproducibility` finding category removed.** It conflated "graph is incomplete" with "paper has a problem." Removed from `lib/audit/types.ts`, the auditor's typebox schema, and the renderer types. Orphan-from-graph and draft drift no longer file findings (§4.4).
> - **Auditor prompt rewritten** as workspace-first / paper-centric (§4.6). Provenance demoted from primary scope to secondary evidence index. Draft-inline cap raised from 2K to 50K chars.
> - **`provenance_check_drift`** returns `draft-evolving` (not `drifted`) for `draft`-kind nodes — separates user-editing-manuscript from data drift (§3.8).
> - **`consumed` channel** added to `ProvenanceFacts` for read-only tools. Per-turn pool of refs is folded into the next producer's inputs (PROV `wasInformedBy` semantics). New `read` adapter wired in. `grep` / `find` / `ls` deliberately stay uncaptured (§3.5).
> - **Audit tab UI** delivered: cmd+4, sub-tab persistence, follow-entity report selection, "referred from" banner for indirect reports, audited markers, sidebar scroll/highlight on detail traversal, two-line edge rows with relationship phrases, copy-as-Markdown for findings, sticky-bottom history, body-level `user-select: text`. (§5.)

## 1. Overview

Research Copilot produces convincing artifacts — analyses, drafts, citations. Convincing is not the same as trustworthy. This spec defines the discipline that lets a user **trust, review, and audit** the work without reading every intermediate step.

### Design Axioms

**A1. The system does not pursue exhaustive review. It pursues minimum discipline + targeted adversarial review.**

**A2. The system records and warns; it never fights user modifications.**

User edits, manual file changes, deletions — the system *never* tries to preserve, recover, or revert them. Snapshots happen only at meaningful boundaries (agent-creation moments and audit-run moments), not throughout continuous editing. Drift between graph claims and live state is *always* surfaced visibly (⚠️ badges, drift findings) rather than silently reconciled. The graph and the file system are allowed to diverge — the graph's job is to record what was true at capture time, not to enforce that truth on the user. This axiom drives §3.7 (snapshot policy) and §3.8 (drift handling).

**A3. The audit subject is the paper, not the agent's record-keeping.**

For every empirical assertion in the draft, the auditor's job is to ask "does the workspace contain evidence that supports it?" — and to file findings only when evidence is *missing*, *contradicted*, or *methodologically wrong*. Provenance-graph completeness is **not** a criterion. Files the user produced manually (in their IDE, in another shell, on another machine) are real evidence even though no provenance node points at them. "Not in the graph" is never a finding by itself. This axiom replaces the v0.8 implication that orphan-from-graph or draft drift constitute findings; it drives §4 (auditor prompt + workflow + categories).

Two pillars, in order of foundation:

1. **Provenance graph** — captured at creation time, immutable, queryable. Every artifact knows its causal ancestors.
2. **Adversarial auditor agent** — a separate, isolated, prosecutor-posture agent that audits a scoped subgraph with maximum access and zero contamination from the producing agent's reasoning.

### Storage discipline (the graph is an *index*, not a store)

The provenance graph is connective tissue. Content lives in fit-for-purpose stores, and the graph references them by typed `ref`:

| Node kind          | Content lives in                                    | Notes                                       |
| ------------------ | --------------------------------------------------- | ------------------------------------------- |
| `memory-artifact`  | Memory V2 (untouched: `note \| paper \| data \| web-content \| tool-output`) | Ref = `{ artifactType, artifactId }`        |
| `workspace-file`   | The user's workspace (raw data files, imports)      | Ref = `{ path, contentHash? }`              |
| `draft`            | Workspace markdown files (user-edited in editor)    | Ref = `{ path, contentHash }`; dedup on save |
| `audit-report`     | `.research-pilot/audit-reports/{id}.json` (new store) | **Only visible in the Audit tab.**          |
| `computation`      | No content — node is metadata about the *act*       | Ref = `{ toolCallId }`                      |

**Memory V2 is not extended.** No new `ArtifactType`. No new directories under `.research-pilot/artifacts/`. The 5 existing types and the type-directory layout in `lib/memory-v2/store.ts` stay as-is.

**Audit reports are quarantined to the Audit tab.** They are *not* surfaced in Library, Papers, or any chat view. They are *not* `@`-mentionable. They are *not* indexed by the mention/search systems. This is intentional: an audit report is an adversarial second opinion, and treating it like a regular artifact would erode that framing.

**Drafts stay as workspace files.** No draft store. No JSON envelope. The graph captures `{ path, contentHash }` on save with content-hash dedup (see §9.1).

Two pillars explicitly out of scope for v1 (revisit later):

- **Claim ledger** — a model that can reliably extract claims at audit time does not need them pre-materialized. Avoid the schema.
- **Reproducibility runner** — without content-addressed data and pinned environments, "rerun and diff" is theatre. Defer until proper versioning exists (separate RFC).
- **Memory V2 schema changes.** Audit reports and drafts do *not* become new `ArtifactType` values. See "Storage discipline" above.

### Trust-by-construction vs. trust-by-review

| Mechanism            | Catches                                                          | Cost                                |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| Provenance graph     | "Where did this number come from?" — answers in milliseconds     | Tool wrapper changes; storage append |
| Adversarial auditor  | Method errors, citation drift, narrative overreach, data misuse   | LLM tokens at audit time            |
| Audit tab UI         | Cognitive burden — ranked findings, scoped runs, graph drill-down | Renderer work                       |

---

## 2. File Structure

```
lib/
├── provenance/
│   ├── types.ts             # NodeKind, NodeRef, ProvenanceNode, ProvenanceEdge, ProvenanceFacts (incl. consumed), ProvenanceAdapter
│   ├── store.ts             # append-only JSONL persistence + params + blobs
│   ├── graph.ts             # in-memory graph, queries (incl. findOrphanWorkspaceFiles diagnostic)
│   ├── capture.ts           # CaptureContext: recordToolCall, syncTurnBoundary, pendingConsumed pool
│   ├── draft.ts             # draft save hook
│   └── adapters/            # one file per registered tool
│       ├── index.ts         # registry — defaultAdapters
│       ├── web-fetch.ts
│       ├── literature-search.ts
│       ├── convert-document.ts
│       ├── data-analyze.ts
│       ├── generate-diagram.ts
│       ├── entity-tools.ts  # artifact-create, artifact-update
│       ├── write.ts
│       ├── edit.ts
│       ├── bash.ts
│       └── read.ts          # consumer adapter — emits `consumed` only
├── audit/
│   ├── auditor.ts           # entrypoint: runAudit({scope, draft?})
│   ├── prompt.ts            # paper-centric prosecutor system prompt (v0.9)
│   ├── tools.ts             # createAuditorTools — read/grep/find/ls/bash/web_fetch + provenance_* + submit_audit_report
│   └── types.ts             # AuditScope, FindingCategory, Finding, AuditReport, TimelineItem

app/src/main/
└── ipc.ts                   # provenance:*, audit:* handlers

app/src/preload/
└── index.ts                 # ElectronAPI bridge additions

app/src/renderer/
├── stores/
│   ├── provenance-store.ts  # graph state
│   ├── audit-store.ts       # reports, run state, selectedAuditId, selectedFindingId
│   └── ui-store.ts          # auditTrail, auditRunTab (sub-tab persistence)
└── components/
    ├── left/
    │   └── AuditSidebar.tsx     # entity list + filters + audit markers + auto-scroll
    └── center/
        ├── AuditView.tsx        # three-pane container (detail + run panel)
        └── audit-graph.ts       # bipartite → entity-only projection

.research-pilot/
├── provenance/
│   ├── graph.jsonl          # append-only event log (the index)
│   ├── params/
│   │   └── {toolCallId}.json # raw tool-call params (referenced by parametersRef)
│   └── blobs/
│       └── {sha256}         # content-addressed snapshots
├── audit-reports/           # quarantined; only the Audit tab reads this
│   └── {auditId}.json
├── artifacts/               # Memory V2 — UNCHANGED
│   ├── notes/
│   ├── papers/
│   ├── data/
│   ├── web-content/
│   └── tool-outputs/
└── memory-v2/               # session summaries, focus, etc. — UNCHANGED
```

---

## 3. Provenance Graph

### 3.1 Data Model

The graph is a thin index. Each node has a discriminated `ref` pointing into the appropriate store; the graph itself never stores content.

```ts
// lib/provenance/types.ts
import type { ArtifactType } from '../types.js'

export type NodeKind =
  | 'memory-artifact'   // pointer into Memory V2 (note | paper | data | web-content | tool-output)
  | 'workspace-file'    // raw input file in the workspace (CSV, PDF, etc.)
  | 'computation'       // the *act* of running a tool — no content payload
  | 'draft'             // workspace markdown file the user edits
  | 'audit-report'      // pointer into .research-pilot/audit-reports/

export type NodeRef =
  | { kind: 'memory-artifact'; artifactType: ArtifactType; artifactId: string }
  | { kind: 'workspace-file';  path: string; contentHash?: string }
  | { kind: 'computation';     toolCallId: string }
  | { kind: 'draft';           path: string; contentHash: string }
  | { kind: 'audit-report';    path: string }       // .research-pilot/audit-reports/{id}.json

export interface ProvenanceNode {
  id: string                    // graph-local ID, e.g. "pn_01HXYZ..."
  kind: NodeKind
  ref: NodeRef                  // discriminator MUST match `kind`
  label: string                 // human-readable (filename, artifact title, "audit 2026-04-29")
  createdAt: string             // ISO timestamp
  toolCall?: {
    name: string                // e.g. 'data-analyze', 'literature-search'
    parametersHash: string      // sha256 of canonicalized params
    parametersRef: string       // path to stored parameters JSON
  }
  agentTurn?: {
    sessionId: string
    turnIndex: number
    model: string
  }
}

export interface ProvenanceEdge {
  from: string                  // ancestor node id (input)
  to: string                    // descendant node id (output)
  role: 'input' | 'code' | 'parameter' | 'cited-by' | 'derived-from'
  // 'code' and 'parameter' are reserved in the type but not currently emitted
  // by any adapter. See §3.5 — defer until a use case (e.g. attaching the
  // generated Python script to a `data_analyze` computation) justifies them.
}

export type GraphEvent =
  | { type: 'node'; node: ProvenanceNode }
  | { type: 'edge'; edge: ProvenanceEdge }
```

**Resolving content from a node.** The graph never returns content directly; consumers resolve through the appropriate store and follow the immutability rules in §3.7:
- `memory-artifact` → `memoryV2.getArtifact(artifactType, artifactId)`; if the captured `contentHash` no longer matches, the resolver returns the snapshot from `provenance/blobs/{contentHash}` (or surfaces a drift warning — see §3.7).
- `workspace-file` → read file at `ref.path`; on drift, surface warning. Snapshot only if the adapter requested it (rare; large datasets opt out by default).
- `draft` → **always** read from snapshot at `provenance/blobs/{contentHash}`. The live path is informational only.
- `audit-report` → read file at `ref.path` (Audit tab only — see §3.6). Audit reports are written once and never modified, so no snapshot is needed.
- `computation` → no content; metadata-only node.

This keeps Memory V2 untouched and lets each content type live in the store that fits it.

### 3.2 Storage

Append-only JSONL at `.research-pilot/provenance/graph.jsonl`. One `GraphEvent` per line. Loaded into memory on startup; updated by appending. Never rewritten.

Rationale: append-only is robust to crashes, cheap to replay, easy to inspect. Compaction is a future optimization (only if the file grows past tens of MB).

### 3.3 Capture

**Capture happens in the coordinator's lifecycle hooks, not in `toAgentResult`.**

`toAgentResult(toolName, result)` (in `lib/tools/tool-utils.ts:168`) is a result-formatting helper — it has no access to params, tool-call IDs, project context, declared inputs, or output artifact refs. Some tools (web-tools, literature-search, data-analyze, convert-document) call it internally; others go through `wrapResearchTool` (in `lib/tools/index.ts:36`). Putting capture there would either miss fields or fragment across two paths.

The correct layer is **`beforeToolCall` / `afterToolCall` on the coordinator's pi-mono Agent** (already present at `lib/agents/coordinator.ts:612-622`). Those hooks see every tool call uniformly with full context: `ctx.toolCall.name`, `ctx.toolCall.id`, `ctx.args`, `ctx.result`, plus the surrounding session.

**Architecture: hooks + per-tool adapters.**

Adapters speak in `NodeRef`s (typed discriminated unions), never in raw strings. The `recordToolCall` layer is the single place that resolves a `NodeRef` to a graph-local `nodeId` — this is where edges are created.

```ts
// lib/provenance/capture.ts
import type { NodeKind, NodeRef, ProvenanceAdapter } from './types.js'

// A registry: tool name → function that maps (args, result) → provenance facts.
// Each tool that produces artifacts contributes one adapter; tools that
// don't produce artifacts but DO read content into the agent's context
// (e.g. `read`) declare a `consumed` set instead — see below.
export interface ProvenanceFacts {
  // Outputs the tool call produced. Each becomes (or finds) a graph node.
  outputs: Array<{
    kind: NodeKind
    ref: NodeRef                 // typed; discriminator MUST match `kind`
    label: string
    contentHash?: string         // sha256 if computed by the adapter; else recordToolCall computes when feasible
  }>
  // Inputs the tool call consumed. Each is a NodeRef the resolver maps to a node ID.
  inputs: NodeRef[]
  // Things the tool call cited (e.g. @-mentions in a prompt). NodeRef so the resolver works uniformly.
  cited?: NodeRef[]
  // Refs whose content flowed into the agent's context without this tool
  // itself producing a node — e.g. `read` loads a file's bytes into the LLM
  // conversation but emits no artifact. Capture pools these per agent turn
  // (PROV `wasInformedBy` semantics); the next call in the same turn that
  // has outputs picks them up as additional inputs. Pool is cleared at turn
  // boundaries, NOT on each producer flush. See §3.5.
  consumed?: NodeRef[]
}

export type ProvenanceAdapter = (
  args: Record<string, unknown>,
  result: unknown,
  ctx: { sessionId: string; turnIndex: number; model: string }
) => ProvenanceFacts | null   // null = nothing to capture

export const adapters: Record<string, ProvenanceAdapter> = {
  'data-analyze':       dataAnalyzeAdapter,
  'literature-search':  literatureSearchAdapter,
  'convert-document':   convertDocumentAdapter,
  'web-fetch':          webFetchAdapter,
  'artifact-create':    artifactCreateAdapter,
  'artifact-update':    artifactUpdateAdapter,
  // … one per artifact-producing tool
}
```

**Why `NodeRef` everywhere, not bare IDs.** Memory V2 artifact IDs, workspace file paths, and audit-report paths live in different namespaces. A bare `string[]` cannot tell `recordToolCall` which store to consult. `NodeRef` carries the discriminator with the data, so the resolver always knows which lookup to perform.

**Wiring in the coordinator** (additive — does not modify existing behavior):

```ts
// lib/agents/coordinator.ts (sketch)
beforeToolCall: async (ctx) => {
  onToolCall?.(ctx.toolCall.name, ctx.args, ctx.toolCall.id)
  // Provenance: just stash a start timestamp keyed by toolCall.id
  provenance.markStart(ctx.toolCall.id, { name: ctx.toolCall.name, args: ctx.args })
  return undefined
},
afterToolCall: async (ctx) => {
  wrappedOnToolResult(...)
  // Provenance: hand off to the adapter registry
  const adapter = adapters[ctx.toolCall.name]
  if (adapter) {
    const facts = adapter(ctx.args, ctx.result, {
      sessionId, turnIndex, model: coordinatorModel
    })
    if (facts) {
      await provenance.recordToolCall({
        toolCallId: ctx.toolCall.id,
        toolName: ctx.toolCall.name,
        params: ctx.args,
        facts,
      })
    }
  }
}
```

**What `provenance.recordToolCall` does** (the only layer that knows about graph-local node IDs):

0. **Sync turn boundary.** If the incoming `agentTurn = { sessionId, turnIndex }` differs from the last seen pair, clear the per-turn `pendingConsumed` pool (see step 1.5 below). This guarantees reads from turn N never leak into producers in turn N+1.
1. **Persist params.** Hash canonicalized `params` → `parametersHash`; write raw params at `.research-pilot/provenance/params/{toolCallId}.json` → `parametersRef`.
1.5. **Absorb `consumed` refs into the per-turn pool.** If `facts.consumed` is non-empty, push each ref into `pendingConsumed: Map<refKey, NodeRef>` (last-write-wins by refKey, so multiple reads of the same path collapse). If the call has no outputs (pure read), early-return here — there's nothing to emit beyond updating the pool.
2. **Resolve every `NodeRef` to a `nodeId`** via `resolveRef(ref): nodeId` — find-or-create semantics:
   - Look up an existing node whose `ref` deep-equals the given ref *and* (if `contentHash` is present) whose `contentHash` matches.
   - If found → return its `nodeId`.
   - If not found → create a new `ProvenanceNode` with a fresh `nodeId`, append to `graph.jsonl`, return the new id.
   - This is what makes inputs (which reference *prior* artifacts) cleanly attach to existing nodes rather than duplicating them.
3. **Fold the consumption pool into inputs (producer flush).** For producer calls (`facts.outputs.length > 0`), every entry in `pendingConsumed` whose refKey is not already in `facts.inputs` is appended to `facts.inputs`. The pool is **NOT** cleared on flush — within a single turn, every producer sees every consumed ref ("reads in this turn inform all producers in this turn"). Duplicates across producers in the same turn are accepted on purpose; precise read-vs-write ordering is not something the agent reliably exposes, so we don't pretend to.
4. **Create output nodes.** For each `outputs[i]`: call `resolveRef` (which will create-new because the output is fresh), populating `toolCall = { name, parametersHash, parametersRef }` and `agentTurn` on the new node.
5. **Create edges using resolved node IDs:**
   - `for each inputId in resolved(facts.inputs):  appendEdge({ from: inputId, to: outputNodeId, role: 'input' })`
   - `for each citedId in resolved(facts.cited):   appendEdge({ from: citedId, to: outputNodeId, role: 'cited-by' })`
   - When the same call emits a `computation` node alongside other outputs, also `appendEdge({ from: computationId, to: outputId, role: 'derived-from' })` for each non-computation output. This is what links each produced file back to the act that produced it.
   - The `code` / `parameter` edge roles are reserved in the type but not emitted (see §3.1 note).

**Resolver invariant.** Adapters never see node IDs. `recordToolCall` is the single boundary between the typed-ref world (adapters) and the graph-ID world (edges, queries). Two refs that are deep-equal (and content-hash-equal where applicable) always resolve to the same node — so re-running an adapter on the same inputs is idempotent and does not fork the graph.

**Drafts.** Drafts are not produced by tool calls; capture them on save in the draft store, with content-hash dedup as decided in §9.1. Resolved `@`-mention IDs become `inputs`; the draft's prior version becomes `derived-from`.

**`toAgentResult` is not touched.** It stays a result formatter. This isolates the provenance system from result-formatting concerns and avoids breaking any existing tool.

**Adapter responsibilities (per tool).** Each adapter is small and pure:
- Inspect `args` to find input artifact references (e.g. `data-analyze`'s `dataset_id`, mention-resolution output, file paths).
- Inspect `result` to find produced artifact refs (e.g. saved file path, new artifact ID).
- Compute content hashes when feasible (cheap for files; skipped otherwise).

Tools that already return artifact IDs in their structured `ToolResult.data` make this trivial; tools that don't will need a small follow-up to surface those IDs (separate one-line PRs per tool).

### 3.4 Queries

```ts
// lib/provenance/graph.ts
getNode(id): ProvenanceNode | null
getOutgoing(id): ProvenanceEdge[]
getIncoming(id): ProvenanceEdge[]
getUpstreamCone(id, maxDepth?): { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] }
getDownstreamCone(id, maxDepth?): { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] }
findByKind(kind): ProvenanceNode[]
latestDraft(): ProvenanceNode | null
```

### 3.5 What gets captured (v1 scope)

Capture has **three** classes of participation, all routed through the same adapter registry:

- **Producer adapters** — emit `outputs` (and optional `inputs` / `cited`).
- **Consumer adapters** (added in v0.9) — emit only `consumed`. Pool refs into the per-turn `pendingConsumed`; the next producer in the same turn picks them up as inputs. PROV `wasInformedBy` semantics.
- **Skipped** — no adapter registered; tool call is invisible to the graph.

#### Surface A — coordinator tool-call hooks (per adapter)

Inventory for v1, derived from `lib/provenance/adapters/index.ts`:

| Tool                  | Class      | Outputs                                                    | Inputs / consumed                                          | Notes                                          |
| --------------------- | ---------- | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `literature-search`   | producer   | one `workspace-file` (review.json)                         | none (external fetch)                                      | Per-paper `memory-artifact` nodes deferred (P1) |
| `convert_document`    | producer   | one `memory-artifact` (note/paper) per output              | one `workspace-file` (source PDF/DOCX path)                |                                                |
| `data_analyze`        | producer   | one `computation` node + one `memory-artifact` (tool-output) | dataset(s) as `memory-artifact`/`workspace-file`         | Computation node carries toolCall/params       |
| `generate_diagram`    | producer   | one `memory-artifact` (tool-output)                        | usually none; `cited` if the prompt referenced artifacts   |                                                |
| `web_fetch`           | producer   | one `memory-artifact` (web-content)                        | none                                                       | URL + fetched-at recorded in `params`          |
| `artifact-create`     | producer   | one `memory-artifact` of the declared type                 | resolved @-mentions deferred (P2)                          | Explicit-create path                           |
| `artifact-update`     | producer   | one new `memory-artifact` node + `derived-from` edge to prior version | resolved @-mentions deferred (P2)               | Old node retained; auto version-link           |
| `write`               | producer   | one `computation` node + one `workspace-file` node         | `derived-from` edge: computation → workspace-file          | File content snapshotted to `blobs/{hash}`     |
| `edit`                | producer   | one `computation` node + new `workspace-file` version      | computation → new file; new file → prior file (`derived-from`) | New version snapshotted                  |
| `bash`                | producer   | one `computation` node only (no output inference)          | per-turn pool flush (reads observed earlier in turn)       | Command + stdout (truncated) in params blob    |
| `read`                | **consumer** | none                                                     | `consumed`: the `workspace-file` it read                   | New in v0.9. Pooled per turn; folded into next producer's `inputs`. |
| `web_search` / `artifact-search` | skipped | n/a                                                  | n/a                                                        | Navigation, not content consumption (paths/snippets only)  |
| `grep` / `find` / `ls` | skipped   | n/a                                                       | n/a                                                        | Same reason — paths and matched fragments, not document content |
| `wiki_*`              | skipped (mostly) | n/a                                                 | n/a                                                        | `wiki_get` could become a consumer once a node-kind decision is made (currently no adapter); `wiki_search` etc. stay skipped |
| `local_compute_*`     | not yet adapted | —                                                    | —                                                          | Gated by `ENABLE_LOCAL_COMPUTE=1`; adapter not yet written  |

For each capture, `recordToolCall` also persists the canonicalized params blob at `provenance/params/{toolCallId}.json` (for bash this includes the full command and a truncated stdout, ~10KB cap) and stamps `agentTurn = { sessionId, turnIndex, model }` on every output node.

**The `consumed` channel — wasInformedBy semantics.**
Read-only content tools (`read`, in v0.9) declare what they pulled into the agent's context. The capture layer pools these refs per agent turn. Any subsequent producer call in the same turn folds the pool into its `inputs`. This is how a turn that does `read analysis.md` → `write summary.md` gets an `input` edge `analysis.md → summary.md` — without `read` itself trying to be a producer (it has no output node of its own). Pool is cleared on `(sessionId, turnIndex)` change, not on each producer flush, so within one turn every producer sees every read.

**Why grep / find / ls / search tools are skipped.**
They reveal *paths* and *match fragments*, not document content. Treating them as inputs would over-count navigation as evidence — every `grep` for a number would suggest the matched file informed every later write, which is rarely true. A `read` after the `grep` is what actually ingests content; that's the point at which capture engages.

**Why bash is tracked but its file outputs are not inferred.**
Tracking `bash` as a `computation` node is cheap and high-value: it makes "the agent ran this command at turn N" visible in the graph. We do *not* try to detect what files bash created (no mtime scanning, no FS watcher) — those heuristics are brittle and noisy (logs, `__pycache__`, parallel writes). Bash *does* benefit from the consumption pool: any `read` earlier in the same turn flushes into the bash computation's `input` edges, so "agent read script.py then ran bash python3 script.py" links up automatically.

**Orphan workspace-files** (files with no `derived-from` from a computation) are still detectable via `graph.findOrphanWorkspaceFiles()` for diagnostic UI, but per axiom A3 they are **not** findings on their own. The auditor searches the workspace for evidence either way; orphan-from-graph is signal, not verdict.

#### Surface B — draft save hook (in the renderer's draft store)

On every save:
1. Compute `contentHash` of current draft text.
2. If a `draft` node with that hash already exists for this draft path → only update `lastSeenAt` (dedup).
3. Otherwise: write blob to `provenance/blobs/{hash}`; emit a new `draft` node with `ref = { kind: 'draft', path, contentHash }`; if a prior draft node exists for the same path, add an edge `{ from: prior, to: new, role: 'derived-from' }`.
4. Resolved @-mentions in the draft become `cited-by` edges from the cited artifact to the new draft node.

#### Explicitly NOT captured (v1)

- **Chat messages** — narration, not artifacts.
- **Skill loads** (`load_skill`) — agent self-state.
- **Navigation tools** — `grep`, `find`, `ls`, `web_search`, `artifact-search`, most `wiki_*` queries (paths / snippets only).
- **Most read-only tools other than `read`** — see the `wiki_*` line above.
- **Bash side effects we cannot see** — files subprocess writes are not auto-detected. The bash call itself is captured; consumed reads earlier in the turn link in via the per-turn pool.
- **Structured memory tools** (`save-memory`, `delete-memory`) — agent self-state, not research output.
- **pi-mono internal narration** — beforeToolCall / afterToolCall hooks fire but adapters are absent, so capture is a no-op.

**The capture rule is mechanical:** the adapter registry decides. If a tool name is in the registry, it captures (as producer or consumer); otherwise it doesn't. To add coverage, add an adapter — never modify the hook.

#### Known gaps / planned work

| Priority | Gap | Plan |
| -------- | --- | ---- |
| P1 | `literature-search` saves N papers to Memory V2 but tool payload doesn't return their IDs → papers appear as orphan `memory-artifact` nodes | Add `savedPaperIds: string[]` to tool result; adapter emits per-paper nodes + `derived-from` edges to the run |
| P2 | `artifact-create` `cited-by` edges from @-mentions | Renderer resolves mentions before invoking the tool; passes `_resolvedMentions: NodeRef[]` in args; adapter reads it |
| P3 | `local_compute_*` adapters | One adapter per tool; emit computation node + declared outputs |
| P? | `wiki_get` adapter | Needs a node-kind decision — wiki content isn't `memory-artifact` / `workspace-file` / `draft`. Either reuse `workspace-file` with a `wiki://` path scheme, or add `external-source` kind |

### 3.6 Audit report storage and quarantine

Audit reports live at `.research-pilot/audit-reports/{auditId}.json` — a new store, not Memory V2.

**Hard constraints (enforced in code, not just convention):**

1. The audit-report store has **no integration with Memory V2 reads/writes**. `lib/memory-v2/store.ts` does not know about it.
2. Audit reports are **not indexed by the mention system** (`lib/mentions/`). They cannot be `@`-mentioned.
3. Audit reports are **not surfaced in Library, Papers, Knowledge, Focus, Tasks, Runs**, or any chat view.
4. The only UI surface that reads `.research-pilot/audit-reports/` is the **Audit tab** (§5).
5. The only IPC handlers that touch the store are `audit:list`, `audit:get`, `audit:run`, `audit:resolve-finding`. No `artifact:*` handler reads it.

**Rationale.** An audit report is an adversarial second opinion. If it appears alongside regular artifacts it acquires the same epistemic status as the work it critiques, which defeats the point. Quarantine preserves the framing: "this is what the prosecutor said, viewed only in the prosecutor's tab."

### 3.7 Immutability — content-addressed snapshots

The graph claims "node N had content X at time T." When that claim is *referenced by an audit*, it must be verifiable forever. Per axiom **A2**, however, the system does not snapshot continuously — it snapshots at **meaningful boundaries** only. Two boundaries matter:

1. **Agent-creation moments** — the instant an agent produces an artifact (memory-artifact, write/edit output). This is the agent's claim, must be evidenced.
2. **Audit-run moments** — the instant the auditor reads content. The audit report must be anchored to immutable evidence forever.

Between those moments — when the user is editing, browsing, or rummaging — the system records hash drift and walks away. No continuous snapshotting. No "every save = blob."

**Snapshot store.** Content-addressed blob store at `.research-pilot/provenance/blobs/{contentHash}`. Files are immutable, deduplicated by hash. Write-once: if `blobs/{hash}` exists, skip. Garbage collection is out of scope for v1.

**Universal size cap (system-level, not adapter-overridable).**

```
const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024  // 10 MB

function snapshotIfFits(content: Buffer): SnapshotRecord {
  const hash = sha256(content)
  const sizeBytes = content.length
  if (sizeBytes > SNAPSHOT_MAX_BYTES) {
    return { contentHash: hash, sizeBytes, snapshotted: false, oversizeSkipped: true }
  }
  if (!exists(`blobs/${hash}`)) writeFile(`blobs/${hash}`, content)
  return { contentHash: hash, sizeBytes, snapshotted: true, oversizeSkipped: false }
}
```

The cap is a **system-level safeguard**: adapters can request a snapshot but cannot override the cap. This prevents one careless adapter from filling `blobs/` with 200MB datasets.

**Per-kind snapshot policy:**

| Node kind         | When snapshotted?                       | Rationale                                                                 |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `memory-artifact` | At capture time (creation + each `artifact-update`) | Agent-produced; "moment of creation" is the claim. Typically KB-scale.    |
| `draft`           | **At audit-run time only**              | User-edited continuously; snapshotting every save would balloon `blobs/`. Only the version reviewed by an audit needs to be anchored. |
| `workspace-file` (write/edit output) | At capture time                | Captures the moment the agent wrote the file.                             |
| `workspace-file` (input/dataset)     | **Default hash-only**; adapter opt-in   | Datasets can be multi-GB; default opt-out. Adapter can request snapshot for small canonical inputs (config files, parameter sheets) — still subject to the 10 MB cap. |
| `audit-report`    | n/a (write-once by design)              | The store *is* the snapshot.                                              |
| `computation`     | n/a (no content payload)                | Metadata-only node.                                                       |

**Draft handling — explicit walkthrough** (since this changed substantively from v0.7):

1. **On save** (in the renderer's draft store):
   - Compute `contentHash` of current text.
   - If matches the most-recent draft node's hash → noop.
   - If differs → mark the most-recent draft node with `lastDriftAt = now, observedHash = newHash`. **Do not create a new node. Do not write a blob.**

2. **On audit run** (before the auditor sees anything):
   - For each draft in scope, recompute current `contentHash`.
   - If the most-recent draft node's `contentHash` matches → reuse it.
   - If it differs → create a new `draft` node with the current state, `snapshotIfFits` the content (subject to 10 MB cap), add a `derived-from` edge from the prior draft node.
   - The audit report references this audit-time draft node. It is now anchored permanently.

3. **Result**: a user who edits a draft 100 times and then runs one audit creates **one** new draft node and (if size permits) **one** new blob — not 100.

**Why memory-artifacts snapshot at capture (not at audit time).** Memory V2 artifacts are agent claims with a defined creation moment. They're typically small (KB). Each `artifact-update` is an explicit agent action, not a stream of micro-saves. Snapshotting at capture is cheap and gives auditors immediate ground truth without extra round-trips.

**Why workspace-files (datasets) stay hash-only.** Raw datasets can be GB-scale. Auto-snapshotting every input would balloon the project. The honest contract: graph records what hash was present, user is responsible for not overwriting raw data, drift is surfaced visibly.

**Storage shape.**
```
.research-pilot/provenance/
├── graph.jsonl
├── params/{toolCallId}.json
└── blobs/
    └── {sha256}              # raw bytes, no extension; size-capped at 10 MB per blob
```

**Draft drift is not a finding (A3).**
The mechanical drift tool `provenance_check_drift` returns rows with status `'draft-evolving'` (not `'drifted'`) for any `draft`-kind node whose live hash diverges from the captured snapshot. Drafts are user-edited manuscripts; that is normal authorship state. The auditor prompt explicitly forbids filing such a finding; the row is informational only. Drift on `workspace-file` / `memory-artifact` data IS still surfaced as drifted and may inform a finding when a draft claim depends on the as-captured version.

### 3.8 Drift handling

When a node is resolved (Audit tab opens it, auditor reads it, etc.) and the live store's current hash differs from the captured `contentHash`, that is **drift**. Per axiom A2, drift is recorded and surfaced — never silently reconciled.

**Resolver semantics:**

```ts
function resolveContent(node: ProvenanceNode): ResolvedContent {
  const { contentHash, snapshotted, oversizeSkipped } = node.snapshot ?? {}
  const liveHash = computeLiveHash(node.ref)   // null if file/artifact missing

  // 1. Snapshot exists → always return the blob (immutable evidence).
  if (snapshotted && exists(`blobs/${contentHash}`)) {
    const blob = readFile(`blobs/${contentHash}`)
    return {
      content: blob,
      driftDetected: liveHash !== null && liveHash !== contentHash,
      missingLive: liveHash === null,
      oversize: false,
    }
  }

  // 2. No snapshot (oversize or hash-only) → fall back to live.
  if (liveHash === null) {
    return { content: null, driftDetected: false, missingLive: true, oversize: oversizeSkipped }
  }
  return {
    content: readLive(node.ref),
    driftDetected: liveHash !== contentHash,
    missingLive: false,
    oversize: oversizeSkipped,
  }
}
```

**UI surfacing rules** (Audit tab, node inspector):

| Condition                                | Badge        | Tooltip                                                          |
| ---------------------------------------- | ------------ | ---------------------------------------------------------------- |
| Snapshot exists, no drift                | (none)       | Verified at capture time                                         |
| Snapshot exists, drift detected          | ⚠️           | Live content has changed since capture (snapshot still authoritative) |
| No snapshot (oversize), no drift         | 📦           | Too large to snapshot at capture; current state matches captured hash |
| No snapshot (oversize), drift detected   | 📦 ⚠️        | Too large to snapshot AND content has changed — current state may not reflect what was reviewed |
| Hash-only by policy, no drift            | (none)       | Hash recorded; current state matches                             |
| Hash-only by policy, drift detected      | ⚠️           | Hash recorded; current state has changed                         |
| Live content missing                     | ❓            | File/artifact no longer exists at recorded path                  |

**The auditor's contract**: when the auditor reads a node during a run, it always gets the snapshotted blob if one exists. If a node has no snapshot and the live content has drifted, the auditor sees a drift warning in its tool output and can flag the audit as "performed against drifted inputs" in its summary.

**Universal application of A2.** This same record-and-warn discipline applies to every user/system boundary:

| User action                                            | System response                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Edits a draft in their editor                          | Save records drift on most-recent node; no blob, no new node             |
| Manually edits `.research-pilot/artifacts/notes/foo.json` | Next read detects hash drift → ⚠️ in any UI that surfaces it          |
| Deletes a workspace data file                          | Next read returns `missingLive: true` → ❓ badge in UI                   |
| Rummages through `.research-pilot/` directory          | Drift logged on next access; system never auto-repairs                   |
| Edits an audit report JSON (audit reports are write-once but the FS is theirs) | Hash drift recorded; UI shows "audit report has been modified" |

**No self-healing logic.** The system never re-snapshots reactively, never overwrites user edits, never restores deleted files. Three responsibilities only: (1) record agent actions truthfully, (2) make drift visible, (3) give the user enough context to decide whether the drift invalidates a finding.

---

## 4. Adversarial Auditor

### 4.1 Posture

The auditor is a **prosecutor**, not an assistant. Operational rules:

1. **Isolated context.** New pi-mono session. No coordinator history, no prior agent messages, no skill-loading trace, no chat transcript.
2. **Maximum read access.** Raw data, all artifacts, full provenance graph, code, parameters, citations, the draft under review.
3. **No write access** to project artifacts. Auditor's only output is the audit report.
4. **Different model by default — same vendor, dedicated `auditor` tier.** Cheap source of disagreement while keeping the user's existing credentials sufficient.

   **The `light` tier is wrong for this.** `light` is the *routing* tier (intent classification, enrichment) — currently `gpt-5.4-nano` for OpenAI and `claude-haiku-4-5` for Anthropic. Both are too weak to act as an adversarial reviewer; using them would produce shallow findings.

   **Solution: extend `lib/models.ts` with a new `auditor` field on `ModelTier`**, parallel to `light`. The auditor tier sits between flagship and routing — capable enough to mount a credible critique, distinct enough from flagship to add disagreement value.

   ```ts
   // lib/models.ts (extension)
   export interface ModelTier {
     flagship: string
     previous: string | null
     light: string | null      // routing / enrichment (cheap, fast)
     auditor: string | null    // adversarial review (capable, distinct from flagship)
   }
   ```

   **Pairing values:**

   | Coordinator provider | Coordinator flagship | Auditor model           | Notes                                  |
   | -------------------- | -------------------- | ----------------------- | -------------------------------------- |
   | `anthropic`          | claude-opus-4-7      | **claude-sonnet-4-6**   | Sonnet, not Haiku                      |
   | `anthropic-sub`      | claude-opus-4-7      | **claude-sonnet-4-6**   | Same as API mode — see below           |
   | `openai`             | gpt-5.5              | **gpt-5.4-mini**        | Mini, **not** nano (`light` tier is nano) |
   | `openai-codex`       | gpt-5.5              | gpt-5.4-mini            | Same model; codex provider has no nano |

   **Subscription vs. API has no effect on the auditor.** `MODEL_TIERS.anthropic` and `MODEL_TIERS['anthropic-sub']` already use identical model IDs at every tier — the difference is auth (Anthropic API key vs. Claude subscription), not model availability. Sonnet 4.6 is reachable in both modes. No conditional logic needed.

   **Fallbacks:**
   - If `auditor` is `null` for the active provider → fall back to `previous`.
   - If `previous` is also `null` → the audit run errors out with a clear message; user must set `audit.modelOverride`.
   - User can pin any model via `audit.modelOverride` in settings.

   **UI surfacing.** The audit run header always shows: model used, input/output token counts, estimated cost. No silent model selection.
5. **Adversarial system prompt.** Prosecutorial, specific, citation-required.

### 4.2 Entrypoint

```ts
// lib/audit/auditor.ts

export interface AuditScope {
  // The set of nodes whose upstream cone is in scope.
  // For "audit current draft": [latestDraft.id]
  rootNodeIds: string[]
  maxDepth?: number
}

export interface AuditRequest {
  scope: AuditScope
  draftText?: string           // when scope includes a draft, pass its text
  model?: string               // override; defaults from settings
  focus?: AuditFocus[]         // optional: ['method', 'citation', 'data-use', 'overreach']
}

export interface AuditReport {
  id: string
  createdAt: string
  scope: AuditScope
  model: string
  findings: Finding[]
  summary: string              // one-paragraph executive summary
  upstreamNodeCount: number
  durationMs: number
}

export async function runAudit(req: AuditRequest): Promise<AuditReport>
```

### 4.3 Default scope

When the user clicks "Audit project" without a selection: scope = upstream cone of the **latest draft**. Drafts are where claims crystallize.

When the user selects a node and clicks "Audit upstream": scope = upstream cone of that node.

### 4.4 Findings

```ts
export type Severity = 'critical' | 'major' | 'minor' | 'info'

export type FindingCategory =
  | 'data-misuse'        // wrong slice, wrong filter, wrong cohort
  | 'method'             // wrong test, violated assumptions, p-hacking
  | 'citation'           // wrong source, fabricated, misattributed
  | 'overreach'          // claim exceeds evidence
  | 'inconsistency'      // numbers don't match across artifacts

export interface Finding {
  id: string
  severity: Severity
  category: FindingCategory
  claim: string                  // one-line: what the auditor alleges
  evidence: string               // multi-paragraph: quotes from data/code/draft
  implicatedNodeIds: string[]    // graph nodes to highlight on click; may be empty when evidence is a workspace file not in the graph
  suggestedAction?: string       // optional: what would resolve this
}
```

Severity is the auditor's call, not a heuristic — the prompt enforces calibration (`critical` reserved for findings that invalidate a headline claim).

**`reproducibility` was removed in v0.9.** Per axiom A3, provenance gaps are not findings. The category conflated "graph is incomplete" with "paper has a problem", which generated false positives whenever the user worked outside the agent. The schema is enforced at three layers: `lib/audit/types.ts`, the `submit_audit_report` typebox in `lib/audit/tools.ts`, and the renderer's `audit-store.ts`. The auditor literally cannot emit the category.

**`implicatedNodeIds` may be empty.** Under A3, the supporting (or contradicting) evidence is sometimes a workspace file that has no provenance node — that's fine. The finding's `evidence` field cites the workspace path directly; the UI handles empty implicated lists gracefully.

### 4.5 Restricted tool set

Auditor's **primary loop tools** (workspace-first under A3):
- `read` (workspace-relative paths)
- `grep` (search inside files)
- `find` / `ls` (enumerate paths)
- `bash` (Python spot-checks; stateless invocations)
- `web_fetch` (citation grounding)

Auditor's **secondary loop tools** (provenance graph as evidence index):
- `provenance_get_node` — node metadata
- `provenance_get_upstream` — cone walk in one call
- `provenance_get_params` — exact args for a computation (mismatch with draft-claimed params = `method` finding)
- `provenance_check_drift` — confirm whether captured evidence still matches live (`drifted` actionable; `draft-evolving` informational; `missing` / `no-snapshot` informational)
- `provenance_read_blob` — read as-captured bytes by hash, when live has drifted

Auditor's **terminal tool**:
- `submit_audit_report` — exactly once; report submission terminates the run.

Auditor does NOT get:
- `artifact-create`, `artifact-update` (no writes to project state)
- Skill loading (no behavioral steering — auditor is domain-skeptic)
- Coordinator's chat history or session summaries

### 4.6 System prompt (v0.9)

Stored at `lib/audit/prompt.ts`. The prompt is **paper-centric** (A3): the audit subject is the draft, not the agent's record-keeping. Concrete shape:

- **Audit question (single)**: "For every empirical assertion in the draft — numbers, tables, statistical claims, citations, 'data available at...' / 'code available at...' statements, methodological claims — does the workspace contain evidence that supports it?"
- **Finding criteria (closed list)**:
  1. Workspace **lacks** evidence for the assertion → finding.
  2. Workspace contains evidence that **contradicts** the assertion → `inconsistency` / `data-misuse` / `overreach`.
  3. Citation, when fetched, **doesn't say** what the draft claims → `citation`.
  4. Methodology is **demonstrably wrong** → `method`.
  Provenance-graph completeness is **not** a criterion.
- **Workflow**:
  1. Read the draft (inlined up to 50K chars; longer drafts use `read` for the rest).
  2. For each assertion, search the **workspace** for supporting evidence — `find` / `grep` / `read` / `bash` is the primary loop.
  3. Provenance graph is the **secondary** index — consult `provenance_get_node` / `_upstream` / `_params` when you want to know which tool call produced a specific file or what args it was given.
  4. Citations → `web_fetch`.
  5. Submit findings only when criteria 1-4 fire. Call `submit_audit_report` exactly once.
- **Common false-positive patterns the prompt explicitly forbids**:
  - "main.tex has drifted since capture" — drafts are user-edited; not a finding.
  - "This file has no upstream node" — search the workspace before concluding evidence is missing.
  - "I couldn't trace this number to a tracked computation" — `grep` the workspace first.
  - Suggesting "capture this file" or "add to provenance" as a finding's resolution — provenance hygiene is the user's tool, not the audit's verdict.
- **Provenance scope summary** is included near the end of the prompt, framed as "*one* evidence index — partial map of the workspace", with `DRIFTED` vs `DRAFT-EVOLVING` annotations distinguished.
- **Implicated node IDs may be empty** in submitted findings — when evidence is a workspace file outside the graph, the finding cites the path in `evidence` and leaves `implicatedNodeIds: []`.

---

## 5. UI: Audit Tab

### 5.1 Placement & shortcut

Top-level tab after Compute: **Chat | Literature | Compute | Audit**. Keyboard shortcut **⌘4** (or **⌘3** when compute is disabled). Wired in `App.tsx`.

### 5.2 Layout (three-pane)

The shipped layout is a **list-based explorer**, not a React Flow canvas. The `@xyflow/react` + dagre dependencies were dropped — for the kinds of provenance graphs research projects produce (tens to a few hundred nodes), a sortable list with breadcrumb traversal beats a force-directed canvas. The canvas is reconsiderable in a future RFC if user demand justifies it.

```
┌─────────────────────┬──────────────────────────┬──────────────────────────┐
│  AuditSidebar       │  EntityDetailPanel       │  AuditRunPanel           │
│  (left rail)        │  (center, ~42%)          │  (right, fills rest)     │
├─────────────────────┼──────────────────────────┼──────────────────────────┤
│  Search…            │  trail › crumbs › crumbs │  Findings · History · Scope │
│  [memory] [file]    │                          │                          │
│  [compute] …        │  ◆ memory                │  ✓ Copied                │
│  sort: newest ↓     │  filename                │  Summary                 │
│                     │  dir/                    │                          │
│  ◆ note ⛨           │  [Audit this artifact]   │  [CRIT] data-misuse ⏩   │
│  ▦ paper.pdf ⛨      │                          │   claim                  │
│  ⚙ data_analyze     │  Versions · 3            │   evidence (expand)      │
│  ✎ main.tex ⛨       │   v3 1h ago abcd…        │  [MAJ] inconsistency …   │
│  …                  │   v2 3h ago bcde…        │                          │
│                     │  Upstream · 2            │  [Copy all]              │
│                     │   ● analysis.md          │                          │
│                     │   └─ produced from this  │                          │
│                     │  Downstream · 1          │                          │
│                     │   ● summary.md           │                          │
│                     │   └─ used by this        │                          │
│                     │  Latest capture          │                          │
│                     │   captured · hash · …    │                          │
└─────────────────────┴──────────────────────────┴──────────────────────────┘
graph · 47 nodes · 89 edges · 0 drift                          auditor running
```

### 5.3 AuditSidebar (left rail)

- `lib/audit-graph.ts` projects raw bipartite provenance (file/computation/version) into a user-readable view: one node per refKey, multiple versions collapsed, computations flattened into edge labels.
- Filter / search / kind chips / sort modes (newest, oldest, most-versions, drift-first). Filter state is local to the sidebar (preserved across tab switches because the rail is `hidden`-toggled, never unmounted).
- **Audited markers**: each row gets a shield glyph if any audit report touches it — filled shield = direct audit root, outlined shield = only implicated by another audit's findings.
- **Auto-scroll on traversal**: clicking an upstream/downstream chip in the detail pane pushes the trail; the sidebar auto-centers the new selection in its viewport and plays a 600ms accent pulse on the row.
- **Filter bypass**: if the trail leads to an entity hidden by the current search/kind filter, that row is pinned at the top under a `pinned · hidden by filter` divider — traversal is never silently lost.

### 5.4 EntityDetailPanel (center, ~42%)

- **Breadcrumb trail** at top — every entity you've traversed to in this exploration session. Click any crumb to truncate back. Trail lives in `useUIStore.auditTrail` (shared with the rail).
- **Audit button** state-aware:
  - never audited → `Audit this artifact`
  - audited directly → `✓ Re-audit this artifact` (filled checkmark)
  - implicated by another audit → `Audit this artifact · referenced before` + `implicated by another audit` hint
  - audit running → disabled, pulse dot + "running"
- **Versions / Upstream / Downstream / Latest capture** sections.
- **Edge rows are two-line**: line 1 has the entity dot + filename; line 2 has `└─` corner colored by edge category, a natural-language relationship phrase ("produced from this" / "fed into this computation"), and the raw label. `relationshipPhrase(direction, edge)` produces direction-aware copy so users don't mentally invert UPSTREAM vs DOWNSTREAM.

### 5.5 AuditRunPanel (right)

- Sub-tabs: **Findings · History · Scope**. Active sub-tab persists in `useUIStore.auditRunTab` so it survives ⌘1/⌘2/⌘4 switches.
- **Live run** (when an audit is running or errored) takes precedence over archived reports. Header shows model · scope nodes · elapsed · turn count · finding count, with a Cancel button.
- **Report follows entity**: when the entity selection changes, the panel automatically swings to the most recent report rooted on this entity (direct), or — if none — the most recent report whose findings implicated it (indirect). A "↳ referred from {root entity}" banner shows above the panel when the displayed report was rooted on a different entity (chain-audit case).
- **Findings tab**:
  - Severity-sorted, severity rail color (CRIT/MAJ/MIN/INFO).
  - **Per-finding `Copy` button** + bulk **Copy all** button. Output is stable Markdown (`### [SEVERITY] category: claim` + blockquoted evidence + `**Suggested action**` + fenced `**Implicated nodes**` + trailing `_finding-id: \`...\`_`) so it pastes straight into the coordinator chat for fix-up.
  - Cards expand on click to show evidence, suggested action, implicated nodes; clicking an implicated id navigates the rail to it.
- **History tab**:
  - Replays the persisted timeline (reasoning paragraphs, tool calls grouped by name, progress messages, finding emissions).
  - **Sticky-bottom scroll**: snaps to bottom on mount; glues to bottom on growth if the user is within 32px of the bottom; leaves position alone if they scrolled up to read. When a live run finishes and the timeline reloads from the persisted report, the user stays at the bottom rather than getting yanked to the top.
- **Scope tab**: scope summary, root node ids, draft preview, warnings.

### 5.6 Audit run controls

- **`Audit this artifact`** on the detail panel — runs auditor with `rootNodeIds: [entity.representative.id]`.
- (Future: model picker, focus filter, cancel-from-elsewhere.)
- A clean report with **zero findings** is a valid outcome under A3 — be skeptical first, but submit empty if every assertion checks out.

### 5.7 Other UI fixes shipped in this iteration

- **Body-level `user-select: text`** in `global.css` — Electron frameless windows default this to `none` at the host, blocking selection in chat. Existing `select-none` opt-outs (timestamps, drag region, activity rail) still work because they're more specific.
- **Default selection on tab enter**: if the trail is empty when the Audit tab activates, the first entity (newest-first by latest version createdAt) is auto-selected so the panes render content immediately.

### 5.8 Empty states

Before any tools have been used: "No provenance captured yet. Run a tool that produces an artifact and the causal graph will populate here."

Before any audit: "Pick an entity in the middle pane and click Audit this artifact. Past audits will appear here once you have run one."

---

## 6. IPC Surface

```ts
// Main → renderer (handlers in app/src/main/ipc.ts)

'provenance:get-graph'        () => GraphSnapshot
'provenance:get-node'         (id) => ProvenanceNode | null
'provenance:get-upstream'     (id, maxDepth?) => Subgraph
'provenance:get-downstream'   (id, maxDepth?) => Subgraph

'audit:run'                   (req: AuditRequest) => stream<AuditEvent>
'audit:list'                  () => AuditReport[]   // metadata only
'audit:get'                   (id) => AuditReport
'audit:resolve-finding'       (auditId, findingId, action) => void
```

`audit:run` streams events (progress, intermediate findings, completion) so the UI can show progress for long audits.

---

## 7. Settings

Additions to settings:

```jsonc
{
  "audit": {
    // Auditor model is derived from the coordinator's vendor by default
    // (Anthropic flagship → Sonnet; OpenAI flagship → GPT-mini).
    // Set `modelOverride` to pin a specific model regardless of coordinator.
    "modelOverride": null,
    "captureProvenance": true,             // master switch
    "deepAudit": true,                     // no token ceiling; auditor decides depth
    "auditMaxDepth": null                  // null = unbounded upstream cone
  }
}
```

---

## 8. Implementation Status

The substrate, auditor, and Audit tab UI all shipped on `feat/trust-audit`. Status as of v0.9:

### Phase 1 — Provenance substrate (✅ shipped)

- `lib/provenance/` — types, append-only store, in-memory graph, queries (`findByRef`, `getOutgoing` / `Incoming`, `getUpstreamCone`, `getDownstreamCone`, `findOrphanWorkspaceFiles`).
- Producer adapters: `web-fetch`, `literature-search`, `convert-document`, `data-analyze`, `generate-diagram`, `entity-tools` (artifact-create / -update), `write`, `edit`, `bash`.
- Consumer adapter (v0.9): `read`. Per-turn `pendingConsumed` pool in `CaptureContext`.
- IPC handlers for `provenance:*`.
- Substrate-level audit view (the AuditSidebar entity list) — usable without running an audit.

### Phase 2 — Auditor agent (✅ shipped)

- `lib/audit/auditor.ts` — `runAudit({ scope, draftText? })`.
- `lib/audit/prompt.ts` — paper-centric prosecutor prompt (rewritten v0.9).
- `lib/audit/tools.ts` — `read` / `grep` / `find` / `ls` / `bash` / `web_fetch` + `provenance_get_node` / `_upstream` / `_params` / `read_blob` / `_check_drift` (with `draft-evolving` status) + `submit_audit_report`.
- Audit-report store at `.research-pilot/audit-reports/{auditId}.json` (quarantined per §3.6).
- IPC `audit:run` (streamed) + `audit:list` / `audit:get` / `audit:resolve-finding`.
- Findings panel in Audit tab; cross-highlight via implicated node ids.
- `lib/models.ts` — `auditor` tier field with vendor-paired defaults.

### Phase 3 — Polish & integration (partial)

- ✅ Audit run header: model · scope · elapsed · turn count · finding count.
- ✅ Sub-tab persistence (Findings / History / Scope) across center-view switches.
- ✅ Live-run sticky-bottom timeline; scroll preservation when live → archived.
- ✅ Report follows entity selection (direct + indirect via implicated findings).
- ✅ Copy-as-Markdown for findings (per-card and bulk).
- ⏳ Resolve / dismiss workflow with persistence — wired in `audit:resolve-finding` IPC; UI affordance pending.
- ⏳ Settings UI for auditor model override.
- ⏳ Audit history comparison across runs.

### Known gaps (carried forward)

| Priority | Gap | Plan |
| -------- | --- | ---- |
| P1 | `literature-search` per-paper nodes | tool returns `savedPaperIds`; adapter emits per-paper memory-artifact nodes + `derived-from` edges to the run |
| P2 | `artifact-create` `cited-by` from @-mentions | renderer resolves mentions before invoking the tool; passes `_resolvedMentions` in args |
| P3 | `local_compute_*` adapters | one adapter per tool; emit computation node + declared outputs |
| P? | `wiki_get` adapter | needs node-kind decision (synthetic `workspace-file` with `wiki://` scheme, or new `external-source` kind) |

Out of scope (separate future RFCs):
- Reproducibility runner (requires content-addressed data + pinned envs).
- Pre-registration / hypothesis locking against which the auditor checks for drift.
- Cross-project graph (current scope is single project).

---

## 9. Resolved Decisions

1. **Draft provenance — snapshot at audit-run time only (not on save).** On save: compute hash; if matches latest draft node, noop; if differs, mark drift on the latest node. **Do not create new node, do not write blob.** On audit run: if drift detected, create a new draft node and snapshot the current content (subject to 10 MB cap). Rationale: per axiom A2, the system does not preserve every keystroke; only audit-referenced versions need permanent anchoring. Reduces blob volume from "one per save" to "one per audit-time drift" — typically 100×+ fewer. See §3.7.

2. **No auditor cost ceiling — deep audit by default.** The auditor decides how far to extend its review. Rationale: capping tokens defeats the prosecutor posture; a constrained auditor produces shallow findings. Cost is a deliberate user action (audit is opt-in, not background). Surface estimated cost *after* the run in the audit report header (`tokens used: X · est. cost: $Y`) so users build intuition over time.

3. **Auditor uses a dedicated `auditor` tier (not `light`/routing tier).** `light` (gpt-5.4-nano, claude-haiku-4-5) is too weak for adversarial review. Add an `auditor` field to `ModelTier` in `lib/models.ts`. Default values: Anthropic → `claude-sonnet-4-6`; OpenAI → `gpt-5.4-mini` (mini, **not** nano). Subscription mode (`anthropic-sub`) uses the same model IDs as API mode — no conditional logic. User can pin via `audit.modelOverride`. See §4.1 for the full pairing table and fallback chain.

4. **Auditing the auditor — deferred to v3.** Audit reports are graph nodes from day one (so the substrate supports it), but no UI affordance to launch a meta-audit until v3. Phase 1–3 stays focused.

5. **Storage layout — graph is an index, content lives in fit-for-purpose stores.** Memory V2 is *not* extended. Drafts stay as workspace markdown files. Audit reports live in a new quarantined store at `.research-pilot/audit-reports/`. The provenance graph references each by typed `ref` (see §3.1). No new `ArtifactType` values.

6. **Audit reports are quarantined to the Audit tab.** Not surfaced in Library/Papers/Knowledge/Focus/Tasks/Runs/chat. Not `@`-mentionable. Not searched. Only the Audit tab's IPC handlers (`audit:*`) read the audit-reports store. Rationale: an adversarial second opinion loses its framing the moment it sits next to regular artifacts. See §3.6.

7. **Adapters speak `NodeRef`, `recordToolCall` resolves to graph IDs.** Adapters never see graph-local node IDs. `ProvenanceFacts.{outputs, inputs, cited}` are typed `NodeRef[]` (or `{ ref, label, contentHash? }` for outputs). `recordToolCall` is the single boundary that calls `resolveRef(ref) → nodeId` (find-or-create) and then creates edges using the resolved IDs. Re-running an adapter with identical refs is idempotent. See §3.3.

8. **Snapshots happen at boundaries, with a 10 MB hard cap.** Two snapshot boundaries: (a) agent-creation moments (memory-artifact creation/update, workspace-file write/edit output), (b) audit-run moments (drafts and any node that drifted between capture and audit). Universal **system-level cap of 10 MB** per blob — adapters request snapshots but cannot override the cap; oversize content gets `oversizeSkipped: true` and a 📦 badge. Drafts are *not* snapshotted on save (axiom A2). Workspace-file inputs (datasets) stay hash-only by default. Audit reports are write-once and need no snapshot. See §3.7 and §3.8.

9. **`bash` / `write` / `edit` are tracked as `computation` nodes; bash side-effects are NOT inferred.** Every `bash`, `write`, `edit` call emits a `computation` node (cheap metadata: command, params blob, turn). `write`/`edit` additionally emit a `workspace-file` node + `derived-from` edge using the target path from args (default-snapshotted). `bash` does *not* try to infer what files it wrote — FS scanning is brittle and noisy. Bash now benefits from the per-turn consumption pool (decision 11 below): any `read` earlier in the same turn flushes into the bash computation's `input` edges, so "agent read script.py then ran bash python3 script.py" links automatically. Orphan workspace-files (no `derived-from` from a computation) are exposed via `graph.findOrphanWorkspaceFiles()` for diagnostics but per A3 (decision 12 below) are NOT findings on their own. See §3.5.

10. **Axiom A2 — record and warn, never fight user modifications.** The system never preserves every user keystroke, never auto-restores deleted files, never reactively re-snapshots, never overwrites user edits. Three responsibilities only: (1) record agent actions at meaningful boundaries, (2) make drift visible (⚠️/📦/❓ badges), (3) give users context to judge whether drift invalidates a finding. Applies uniformly to drafts, memory-artifacts edited externally, deleted workspace files, and audit reports tampered with on disk. See §3.8.

11. **Read-only content tools participate via a `consumed` channel; navigation tools do not.** (v0.9.) Adapters can declare `consumed: NodeRef[]` instead of (or alongside) `outputs`. The capture layer pools these refs in a per-(sessionId, turnIndex) `pendingConsumed` map; on every producer call (`outputs.length > 0`) the pool's contents are folded into `facts.inputs` (deduped by refKey). Pool clears at turn boundary, NOT on each producer flush — so within one turn, every producer sees every read. `read` is the v0.9 consumer adapter; `wiki_get` is a candidate pending a node-kind decision. `grep` / `find` / `ls` / `web_search` / `artifact-search` / most `wiki_*` stay UNcaptured because they reveal paths and snippets, not document content. See §3.3 step 1.5/3 and §3.5.

12. **Axiom A3 — the audit subject is the paper, not the agent's record-keeping.** (v0.9.) Findings are filed only when workspace evidence is missing, contradicts the assertion, or methodology is demonstrably wrong. Provenance-graph completeness is not a criterion. The `reproducibility` finding category was removed (it conflated graph gaps with paper problems). The auditor prompt directs `find` / `grep` / `read` / `bash` as the primary loop and demotes the provenance graph to a secondary evidence index; specific anti-patterns ("main.tex drifted", "no upstream node") are explicitly forbidden. `provenance_check_drift` returns `draft-evolving` (not `drifted`) for `draft`-kind nodes, and the prompt forbids filing such a finding. See §1 (Axioms) and §4.

13. **Audit tab UI is list-based, not graph-canvas.** (v0.9.) The `@xyflow/react` + dagre dependencies were dropped. AuditSidebar is a sortable filterable entity list (with audit markers, auto-scroll on traversal, filter bypass for trail entries). Center pane is breadcrumb + entity detail (versions, upstream/downstream as two-line rows with relationship phrases). Right pane has Findings / History / Scope sub-tabs with persistence (lifted to `useUIStore.auditRunTab`), report-follows-entity selection, "↳ referred from" indicator for indirect reports, copy-as-Markdown for findings, sticky-bottom history scroll. ⌘4 keyboard shortcut. See §5.

## 10. Future Open Questions (post-v3)

- Cross-project provenance (does an artifact imported from another project carry its lineage?).
- Pre-registration of hypotheses against which the auditor checks for drift.
- Reproducibility runner — requires content-addressed data + pinned envs (separate RFC).
- Auditing the auditor as a UI feature (substrate already supports it).

---

## 11. Non-Goals

- Replacing peer review.
- Producing publication-ready trust certificates.
- Catching every error (no system can; the goal is to *raise the floor*).
- Real-time auditing during coordinator turns (cost + UX noise; audit is a deliberate user action).

---

## 12. Success Criteria

A user with a completed project should be able to, in under five minutes:

1. Open the Audit tab and see the project's causal graph.
2. Click "Audit project" and receive a ranked list of findings against the latest draft.
3. Click any finding and see exactly which graph nodes it implicates.
4. Click any number/claim in the draft and trace it backward through the graph to its raw input.

If those four interactions work and feel fast, the system has earned trust by giving the user *cheap, scoped, adversarial inspection* — not by claiming correctness.
