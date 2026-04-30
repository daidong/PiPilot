# Trust & Audit: Provenance Graph + Adversarial Auditor

> Spec version: 0.8 (draft) | Last updated: 2026-04-29

## 1. Overview

Research Copilot produces convincing artifacts — analyses, drafts, citations. Convincing is not the same as trustworthy. This spec defines the discipline that lets a user **trust, review, and audit** the work without reading every intermediate step.

### Design Axioms

**A1. The system does not pursue exhaustive review. It pursues minimum discipline + targeted adversarial review.**

**A2. The system records and warns; it never fights user modifications.**

User edits, manual file changes, deletions — the system *never* tries to preserve, recover, or revert them. Snapshots happen only at meaningful boundaries (agent-creation moments and audit-run moments), not throughout continuous editing. Drift between graph claims and live state is *always* surfaced visibly (⚠️ badges, drift findings) rather than silently reconciled. The graph and the file system are allowed to diverge — the graph's job is to record what was true at capture time, not to enforce that truth on the user. This axiom drives §3.7 (snapshot policy) and §3.8 (drift handling).

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
│   ├── types.ts             # Node, Edge, GraphSnapshot, ProvenanceFacts, ProvenanceAdapter
│   ├── store.ts             # append-only JSONL persistence + params dir
│   ├── graph.ts             # in-memory graph, queries
│   ├── capture.ts           # recordToolCall(); markStart/markEnd for hooks
│   ├── adapters/            # one file per artifact-producing tool
│   │   ├── index.ts         # adapter registry
│   │   ├── data-analyze.ts
│   │   ├── literature-search.ts
│   │   ├── convert-document.ts
│   │   ├── web-fetch.ts
│   │   └── entity-tools.ts  # artifact-create, artifact-update
│   └── upstream.ts          # upstream-cone computation
├── audit/
│   ├── auditor.ts           # entrypoint: runAudit({scope, draft?})
│   ├── prompt.ts            # prosecutor system prompt
│   ├── tools.ts             # restricted tool set for auditor
│   ├── findings.ts          # Finding type, severity, ranking
│   └── store.ts             # audit-report artifacts
└── tools/
    └── tool-utils.ts        # extended toAgentResult → also writes provenance

app/src/main/
└── ipc.ts                   # provenance:*, audit:* handlers

app/src/preload/
└── index.ts                 # ElectronAPI bridge additions

app/src/renderer/
├── stores/
│   ├── provenanceStore.ts   # graph state, selection
│   └── auditStore.ts        # audit runs, findings, scope
└── components/
    └── audit/
        ├── AuditTab.tsx          # tab root
        ├── ProvenanceGraph.tsx   # React Flow canvas
        ├── NodeInspector.tsx     # selected node panel
        ├── FindingsList.tsx      # ranked findings
        └── AuditRunControl.tsx   # scope + run controls

.research-pilot/
├── provenance/
│   ├── graph.jsonl          # append-only event log (the index)
│   ├── params/
│   │   └── {toolCallId}.json # raw tool-call params (referenced by parametersRef)
│   └── blobs/
│       └── {sha256}         # content-addressed snapshots (drafts always; memory-artifacts always; workspace-files opt-in)
├── audit-reports/           # NEW STORE — quarantined; only the Audit tab reads this
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
// don't produce artifacts (e.g. read-only helpers) are absent and skipped.
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

1. **Persist params.** Hash canonicalized `params` → `parametersHash`; write raw params at `.research-pilot/provenance/params/{toolCallId}.json` → `parametersRef`.
2. **Resolve every `NodeRef` to a `nodeId`** via `resolveRef(ref): nodeId` — find-or-create semantics:
   - Look up an existing node whose `ref` deep-equals the given ref *and* (if `contentHash` is present) whose `contentHash` matches.
   - If found → return its `nodeId`.
   - If not found → create a new `ProvenanceNode` with a fresh `nodeId`, append to `graph.jsonl`, return the new id.
   - This is what makes inputs (which reference *prior* artifacts) cleanly attach to existing nodes rather than duplicating them.
3. **Create output nodes.** For each `outputs[i]`: call `resolveRef` (which will create-new because the output is fresh), populating `toolCall = { name, parametersHash, parametersRef }` and `agentTurn` on the new node.
4. **Create edges using resolved node IDs:**
   - `for each inputId in resolved(facts.inputs):  appendEdge({ from: inputId, to: outputNodeId, role: 'input' })`
   - `for each citedId in resolved(facts.cited):   appendEdge({ from: citedId, to: outputNodeId, role: 'cited-by' })`
   - One `computation` node may also be emitted (kind `computation`, ref `{ toolCallId }`) and edges from it `parameter`-tagged to the params blob — optional in Phase 1.

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

There are exactly **two** capture surfaces. Everything else is silently skipped.

#### Surface A — coordinator tool-call hooks (per artifact-producing tool)

Adapters are registered only for tools that produce research artifacts. Inventory for v1, derived from `lib/tools/index.ts`:

| Tool                  | Adapter records (outputs)                                  | Adapter records (inputs)                                  | Notes                                          |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `literature-search`   | one `memory-artifact` (paper) per added paper              | none (external fetch)                                     | `cited` may include the prompt's @-mentions    |
| `convert-document`    | one `memory-artifact` (note/paper) per output              | one `workspace-file` (source PDF/DOCX path)               | Snapshot source if small (adapter opt-in)      |
| `data-analyze`        | one `computation` node + one `memory-artifact` (tool-output) | dataset(s) as `memory-artifact`/`workspace-file`         | Computation node carries toolCall/params       |
| `generate-diagram`    | one `memory-artifact` (tool-output)                        | usually none; `cited` if the prompt referenced artifacts  |                                                |
| `web-fetch`           | one `memory-artifact` (web-content)                        | none                                                      | URL + fetched-at recorded in `params`          |
| `web-search`          | usually skipped (read-only)                                | n/a                                                       | If a result is later saved, that save captures it |
| `artifact-create`     | one `memory-artifact` of the declared type                 | resolved @-mentions in args                               | Explicit-create path                           |
| `artifact-update`     | one new `memory-artifact` node + `derived-from` edge to prior version | resolved @-mentions in args                    | Old node retained; a draft-like history forms  |
| `local-compute:*`     | one `computation` node + outputs declared by the run       | scripts and datasets it consumed                          | Gated by `ENABLE_LOCAL_COMPUTE=1`              |
| `bash`                | one `computation` node only (no output inference)          | none (we do not scan the FS for side effects)             | Command + stdout (truncated) in params blob    |
| `write`               | one `computation` node + one `workspace-file` node         | `derived-from` edge: computation → workspace-file         | File content snapshotted to `blobs/{hash}` by default |
| `edit`                | one `computation` node + new `workspace-file` version      | computation → new file; new file → prior file (`derived-from`) | New version snapshotted; prior version remains pinned in graph |

For each capture, `recordToolCall` also persists the canonicalized params blob at `provenance/params/{toolCallId}.json` (for bash this includes the full command and a truncated stdout, ~10KB cap) and stamps `agentTurn = { sessionId, turnIndex, model }` on every output node.

**Why bash is tracked but its file outputs are not inferred.**
Tracking `bash` as a `computation` node is cheap and high-value: it makes "the agent ran this command at turn N" visible in the graph. We do *not* try to detect what files bash created (no mtime scanning, no FS watcher) — those heuristics are brittle and noisy (logs, `__pycache__`, parallel writes). Instead, the graph surfaces the gap as a **risk signal** (see "Orphan workspace-files" below).

**Orphan workspace-files as audit signal.**
When an artifact-producing tool later consumes a `workspace-file` that has no incoming `derived-from` edge from a `computation` node, the file is an *orphan*: it appeared without a tracked origin. The auditor surfaces this as a finding (category `reproducibility`): "input X has no tracked producer — likely created by a bash command whose outputs were not declared, or imported manually." This converts the inherent limit of file-level tracking from a silent hole into a visible warning.

#### Surface B — draft save hook (in the renderer's draft store)

On every save:
1. Compute `contentHash` of current draft text.
2. If a `draft` node with that hash already exists for this draft path → only update `lastSeenAt` (dedup).
3. Otherwise: write blob to `provenance/blobs/{hash}`; emit a new `draft` node with `ref = { kind: 'draft', path, contentHash }`; if a prior draft node exists for the same path, add an edge `{ from: prior, to: new, role: 'derived-from' }`.
4. Resolved @-mentions in the draft become `cited-by` edges from the cited artifact to the new draft node.

#### Explicitly NOT captured (v1)

- **Chat messages** — narration, not artifacts.
- **Skill loads** (`load_skill`) — agent self-state.
- **Read-only tools** — `read`, `grep`, `find`, `wiki_search`, `wiki_get`, `wiki_coverage`, `wiki_facets`, `wiki_neighbors`, `wiki_source`, `wiki_lookup`, `artifact-search`.
- **Bash side effects we cannot see**: files Python (or any subprocess) writes from inside a `bash` invocation are not auto-detected. The bash call itself is captured (computation node), and any file later consumed by an artifact-producing tool will appear as an *orphan* `workspace-file` (visible audit signal).
- **Structured memory tools** (`save-memory`, `delete-memory`) — agent self-state, not research output.
- **pi-mono internal narration** — beforeToolCall / afterToolCall hooks fire for these but adapters are absent, so capture is a no-op.

**The capture rule is mechanical:** the adapter registry decides. If a tool name is in the registry, it captures; otherwise it doesn't. To add coverage, add an adapter — never modify the hook.

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
  | 'reproducibility'    // can't be traced to inputs

export interface Finding {
  id: string
  severity: Severity
  category: FindingCategory
  claim: string                  // one-line: what the auditor alleges
  evidence: string               // multi-paragraph: quotes from data/code/draft
  implicatedNodeIds: string[]    // graph nodes to highlight on click
  suggestedAction?: string       // optional: what would resolve this
}
```

Severity is the auditor's call, not a heuristic — but the prompt enforces calibration ("reserve `critical` for findings that would invalidate the headline claim").

### 4.5 Restricted tool set

Auditor gets:
- `read` (any project file)
- `bash` / `python` (sandboxed; for re-running spot checks)
- `grep`, `glob`
- `provenance:get-node`, `provenance:get-upstream`
- `web-fetch` (citation grounding)

Auditor does NOT get:
- `artifact-create`, `artifact-update` (no writes to project state)
- Skill loading (no behavioral steering by domain skills — auditor is domain-skeptic)
- Coordinator's chat history or session summaries

### 4.6 System prompt skeleton

Stored in `lib/audit/prompt.ts`. Key clauses:

- "You are a prosecutor reviewing research output. Assume flaws exist until proven otherwise."
- "You have not seen the agent's reasoning. You see only inputs, outputs, code, and the draft. This is intentional — your job is independent verification."
- "Every finding must cite specific node IDs and quote specific evidence. No hand-waving."
- "Calibrate severity. `critical` = invalidates a headline claim. `major` = requires substantive revision. `minor` = should be fixed. `info` = noted."
- "If a claim in the draft cannot be traced to a node in scope, that itself is a finding (`reproducibility`)."

---

## 5. UI: Audit Tab

### 5.1 Placement

New top-level tab after Compute: **Chat | Literature | Compute | Audit**.

### 5.2 Layout

```
+--------------------------------------------------------------+
| [Audit project] [Audit selected ▾]   Model: sonnet-4-6 ▾     |
+----------------------------------+---------------------------+
|                                  |                           |
|        Provenance Graph          |     Findings              |
|        (React Flow canvas)       |                           |
|                                  |  🔴 critical (2)          |
|     [data]──→[compute]──→[art]   |    Cohort exclusion ...   |
|         │         │      │       |    Citation [12] does ... |
|         └───→[draft]─────┘       |  🟡 major (5) ▸           |
|                                  |  🟡 minor (3) ▸           |
|  legend  · click: inspect        |  🟢 info (1) ▸            |
|          · right-click: audit    |                           |
+----------------------------------+---------------------------+
| Selected node: art_01HX... — "blood-glucose-summary.md"      |
| created 2026-04-28 by data-analyze · inputs: 2 · outputs: 3  |
| [Open artifact] [Audit upstream] [Show downstream]           |
+--------------------------------------------------------------+
```

### 5.3 Graph rendering

- **Library: `@xyflow/react`** (React Flow). Already React/Zustand-friendly, virtualizes well, custom nodes supported. Cytoscape considered and rejected (heavier, more imperative).
- Auto-layout: dagre (top-down). User can drag.
- Node coloring by `kind`. Edge styling by `role`.
- Selection state lives in `provenanceStore`.
- Findings cross-link: clicking a finding highlights `implicatedNodeIds` in the graph and pans to fit.

### 5.4 Audit run controls

- **Audit project** — runs auditor with scope = upstream cone of latest draft. Default action.
- **Audit selected** — enabled when one or more nodes are selected.
- **Model picker** — defaults from settings (Sonnet 4.6 or GPT-mini); per-run override.
- **Focus filter** (optional) — limit auditor to specific categories.
- Running an audit shows a streaming progress panel; on completion, findings populate the right pane and the report is saved as an `audit-report` node in the graph (yes, recursively auditable).

### 5.5 Findings interaction

- Ranked: severity desc, then category.
- Each finding: expand to see full evidence + implicated nodes.
- Actions per finding: **Resolve** (mark addressed), **Dismiss** (with reason), **Open implicated artifact**.
- Resolution state is persisted on the audit-report artifact.

### 5.6 Empty state

Before any tools have been used: "No provenance captured yet. Run an analysis or import data to start building the graph."

Before any audit: "Run your first audit. The auditor reviews the draft's upstream cone with a fresh prosecutor agent — no contamination from the work above."

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

## 8. Implementation Plan

Three phases. Each is independently shippable; no phase blocks the next on UX value.

### Phase 1: Provenance substrate (foundation)

- `lib/provenance/` — types, append-only store, in-memory graph, queries.
- Refactor `lib/tools/tool-utils.ts` and tool implementations to emit nodes/edges.
- IPC handlers for `provenance:*`.
- **Read-only graph view** in Audit tab (React Flow). No auditor yet.
- Outcome: users can see how their project was built. Already valuable.

### Phase 2: Auditor agent

- `lib/audit/` — auditor entrypoint, prompt, restricted tools, findings model.
- Audit-report store at `.research-pilot/audit-reports/{auditId}.json` (quarantined per §3.6).
- IPC for `audit:run` (streamed) + `audit:list`/`audit:get`.
- Findings panel in Audit tab; cross-highlight with graph.
- **Extend `lib/models.ts`:** add `auditor` field to `ModelTier` with values from §4.1's pairing table; expose a `getAuditorModel(coordinatorProvider): string` helper.
- Audit run header surfaces: model used, token counts, estimated cost.
- Outcome: full prosecutor loop on demand.

### Phase 3: Polish & integration

- Resolve/dismiss workflow with persistence.
- Audit history (compare runs across the same scope over time).
- Right-click "Audit upstream" on graph nodes.
- Settings UI for auditor model.
- Empty states, loading states, error recovery.

Out of scope (separate future RFCs):
- Reproducibility runner (requires content-addressed data + pinned envs).
- Pre-registration / hypothesis locking.
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

9. **`bash` / `write` / `edit` are tracked as `computation` nodes; bash side-effects are surfaced as orphan-file warnings.** Every `bash`, `write`, `edit` call emits a `computation` node (cheap metadata: command, params blob, turn). `write`/`edit` additionally emit a `workspace-file` node + `derived-from` edge using the target path from args (default-snapshotted). `bash` does *not* try to infer what files it wrote — that requires brittle FS scanning. Instead, when an artifact-producing tool later consumes a `workspace-file` with no incoming `derived-from` edge, the auditor surfaces an "orphan file" finding (`reproducibility` category). Cost is bounded: each call adds 1–2 JSONL lines. See §3.5.

10. **Axiom A2 — record and warn, never fight user modifications.** The system never preserves every user keystroke, never auto-restores deleted files, never reactively re-snapshots, never overwrites user edits. Three responsibilities only: (1) record agent actions at meaningful boundaries, (2) make drift visible (⚠️/📦/❓ badges), (3) give users context to judge whether drift invalidates a finding. Applies uniformly to drafts, memory-artifacts edited externally, deleted workspace files, and audit reports tampered with on disk. See §3.8.

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
