# Audit Pipeline — process-faithfulness audit over the Audit Graph

Status: **as-built design**. This file is the canonical workflow for the current
Audit tab implementation. It supersedes the claim-entailment pipeline previously
described here. That pipeline (extract claims from a deliverable → LLM judge
entailment → `supported`/`contradicted`/`ungrounded`/`not_checkable`) is
**demoted**: its LLM judge survives only as optional *escalation* for the small
residue the deterministic path cannot settle (§9). The compatibility code still
lives in `lib/audit-graph/audit/` but is no longer the primary path.

The audit answers one question, at **system level**:

> Does what the agent **says** it did match what the trace shows it **actually
> did**? — e.g. "I read **all** the data and plotted this" while the data flow
> shows it sampled one file per group.

It does **not** judge whether the answer is correct, does **not** hunt
hallucinations, and does **not** re-run any tool. It compares the agent's
narrative against the recorded provenance.

---

## 0. Locked principles

1. **Faithfulness, not correctness — and not methodology.** We check the claim
   against the *recorded process*, never against the world. The agent's
   *decisions* are its own (sampling one file per group may be a fine choice).
   We flag **only the gap between narrative and action**: sampling-and-saying-so
   is clean; sampling-and-claiming-"all" is a finding.

2. **Audit is per-node, not a global button.** The unit is a node you select.
   Not every node type is auditable, and different types audit differently (§5.1).

3. **Verdicts are correspondence, not entailment:** `match` / `mismatch` /
   `unverifiable`. `mismatch` is the headline product. `unverifiable` is an
   honest "the trace can't settle this at our granularity" — never faked into a
   pass or a fail.

4. **The verdict is always deterministic; the LLM never produces it.** The
   `match/mismatch/unverifiable` verdict comes from a deterministic graph
   comparison. The LLM is used at **three bounded, logged touchpoints — none of
   which emit the verdict**: (1) **extract claims** from an output (§5.2 C.1),
   (2) **adjudicate** whether a flagged node is abandoned, a *scope* decision
   (§3.2), (3) **escalation** for `unverifiable` visual/semantic claims (§9).
   The model used for all three is configurable (§6.1). See the boundary table
   in §6.

5. **Three separate mechanisms over one graph — do not conflate them:**
   - **prune** (§3) — a *global* focus: grey background / scaffolding / abandoned
     branches, keep the turn's causal work.
   - **causal-lineage highlight** (§4) — a *per-node click* interaction: light up
     a node's causal sources/products.
   - **audit** (§5) — a *per-node* correspondence check.
   They share `edgeCausalClass`/`nodeRole` but are independent features. Causal
   highlighting is a click behavior, **not** something the Prune button does.

6. **Flags split by purpose** (§5.3):
   - **prune-flags** *reduce the graph* (errored-and-unconsumed, superseded
     retries → greyed as abandoned).
   - **audit-flags** *trigger a targeted check* (ungrounded_step, unused_output,
     overwritten, errored-but-consumed).
   The same detector can never be both; assign each flag to exactly one purpose.

7. **Isolation of the loop.** Audit products are written ONLY to
   `.research-pilot/audit/`. LLM calls (extraction or escalation) emit **no
   telemetry**. Audit references evidence by ID/blob one-directionally; the
   telemetry side has zero back-pointers. **The graph never audits the audit.**
   See §8.

---

## 1. The three concerns (and where the LLM sits)

```
telemetry + ledger
  └─ projectGraph ─────────────────► full provenance graph (+A1 citation fields)   [deterministic]
        │
        ├─ (A) pruneGraph ──────────► KEPT causal subgraph + prune/audit flags       [deterministic]
        │        = global focus: grey background/scaffolding/abandoned
        │
        ├─ (B) causal-lineage highlight (on node click)                              [deterministic]
        │        = light up the clicked node's causal sources/products
        │
        └─ (C) node audit
                 1. extract claims from the node's output            [LLM — perception only]
                 2. anchor each claim to graph nodes                 [deterministic]
                 3. causal backtrace to the claim's source(s)        [deterministic]
                 4. compare claim's asserted values vs the source    [deterministic]
                    → match / mismatch / unverifiable
                 5. (optional) escalate unverifiable visual/semantic [LLM — escalation]

            UI entry points:
              - Prune: grey background / abandoned work as one graph-scope action.
              - Audit this node: run C for one selected node.
              - Audit trace: run C over the focused trace's candidate nodes,
                concurrently, cache-first, then roll up coverage (§10.1).
```

Everything is deterministic except Prune's ambiguous-node check, step C.1
(claim extraction), and the optional C.5 (escalation). The **verdict is always
produced deterministically** in C.4.

Implementation map:

| Concern | Current code |
|---|---|
| graph projection | `lib/audit-graph/project.ts` |
| prune + flags + support metrics | `lib/audit-graph/prune.ts` |
| LLM prune adjudication | `lib/audit-graph/adjudicate.ts` |
| per-node audit orchestration | `lib/audit-graph/audit/node-audit.ts` |
| claim extraction | `lib/audit-graph/audit/extract-claims.ts` |
| deterministic compare | `lib/audit-graph/audit/faithfulness.ts` |
| optional escalation | `lib/audit-graph/audit/escalate.ts` + demoted `judge.ts`/`packet.ts` |
| IPC | `app/src/main/ipc.ts` (`audit:run-node`, `audit:audit-trace`, `audit:adjudicate-prune`, `audit:escalate-finding`) |
| UI | `app/src/renderer/components/center/audit/` |

---

## 2. Foundation: the audit graph (deterministic, zero LLM)

`projectGraph` (`lib/audit-graph/project.ts`) projects telemetry + the artifact
ledger into nodes (`session/trace/step/tool/chat/artifact/file/dir/skill`) and
edges. Two classifications, both in `prune.ts`, are reused everywhere below:

- **`edgeCausalClass(rel)`** → `causal` (data + control flow:
  `invokes/returns/reads/retrieved/writes/creates/sub-llm/listed/applies`),
  `temporal` (`precedes`), `structural` (`contains/mentions`).
  **Load-bearing use:** every backtrace (B and C.3) follows **causal edges
  only**. `precedes` is temporal adjacency, *not* a data dependency — following
  it would pull "whatever happened earlier" and destroy the source attribution.
- **`nodeRole(kind)`** → `container/step/tool/artifact/file/skill`.

`project.ts` also attaches **A1 citation fields** to artifact nodes
(`citationsTotal/Resolved/Rate + unresolvedCitations`, via `citations.ts`) — a
deterministic "are the cited sources actually retrieved?" check that is one
instance of result-correspondence (§5.2) and feeds the audit-flags (§5.3).

---

## 3. Prune — global focus (single UI action)

The UI exposes exactly one **Prune** switch. Turning it on greys background /
scaffolding / abandoned work and makes that scope active for audit. Internally,
Prune combines a deterministic reproducible baseline (§3.1) with a bounded
ambiguous-node check for the cases topology cannot settle (§3.2); users do not
see a second prune control.

### 3.1 Deterministic prune (`pruneGraph`, zero LLM)

Reduces the noisy full graph to **the focused turn's causal work**:

1. Pick the **terminal step** (`chooseTerminalStep`) — the latest step in a
   *multi-step* trace (a real agent turn), not a trailing background blip.
2. Seed from that trace's whole step spine, then flood **causal edges only**,
   both directions (backward = inputs, forward = products). Trace-scoped nodes
   are admitted only if they belong to the focused trace (a shared file is kept
   without dragging in the parallel trace that also touched it).
3. **KEPT** = critical path + its causal inputs/outputs. **PRUNED** =
   background sub-agents, abandoned/parallel branches, scaffolding. The renderer
   **greys** pruned nodes (never deletes); the audit scope is the KEPT subgraph.

**prune-flags that are deterministic** belong here:

- an errored tool whose product was never consumed and is followed by a later
  success in the same focused trace → **greyed as abandoned** (the error is
  recorded; this needs no LLM).
- `repeated_intent` clusters where the same tool+args fires ≥3 times in a
  3-step window and every invocation has the **same result fingerprint** →
  grey all superseded invocations and their products, keep the latest. Divergent
  or redacted-result clusters are not safe to settle topologically and flow to
  §3.2.

> **Expected output:** `PruneResult` = `{keptNodes, keptEdges, prunedNodes,
> prunedEdges, spineNodes, flags, pruneFlags, auditFlags, supportMetrics,
> stageStats}`, **bit-reproducible**. `flags` is a compatibility union for UI
> rings; `pruneFlags` and `auditFlags` are the load-bearing split.

### 3.2 LLM adjudication of flagged nodes (optional, logged)

Topology alone **cannot** tell whether a non-errored flagged node was *abandoned*
(the agent rejected/superseded it) or *used* (it fed the answer): the `returns`
edge only records that a result entered the next prompt, **not** whether the LLM
acted on it. So `repeated_intent` with divergent results, or "was this rejected?",
is undecidable deterministically. `prune.ts` already defers this — *"is this
abandoned / did it affect reasoning … deferred to the LLM stage."*

This stage resolves exactly those flagged-but-ambiguous nodes. Current candidate
selection (`selectAdjudicationCandidates`) is deliberately narrow:

- `repeated_intent` — divergent/redacted repeated tool+args clusters where the
  earlier attempt may have been rejected or may have influenced the answer.
- `reread` — repeated reads where topology cannot expose whether the agent used
  the earlier observation.
- `error` — only failed tools whose result still flowed onward via `returns`.
  Errored-and-unconsumed branches were already handled deterministically in §3.1.

- **Input**: the flagged node + the surrounding step's reasoning (`response_text`)
  + its structural context (errored / redone / divergent result).
- **LLM decides**: `abandoned` → grey it; `used` → keep it.
- The LLM reads the one thing `returns` can't expose — *did the agent adopt or
  ignore this result*, which lives in the reasoning text.

**Safety bias — when in doubt, KEEP.** Greying a node removes it from audit
scope, so a false prune *hides a real problem*. The LLM may grey **only** when it
can point to explicit rejection evidence in the reasoning; otherwise keep. The
implementation enforces this after the LLM returns: an `abandoned` decision
survives only if `quotedReasoning` is non-empty and appears verbatim in the
reasoning text. Unparseable output, empty reasoning, or a missing quote becomes
`used`.

**Reproducibility.** This layer makes the *pruned set* non-bit-reproducible.
Mitigation (consistent with §8): the deterministic §3.1 result is always the
baseline; each §3.2 decision (node greyed, reason, the reasoning span quoted) is
written to the run log, so the scope is **re-inspectable** even if not
bit-reproducible. The model is configurable (§6.1).

> **Expected output:** the deterministic KEPT/PRUNED **plus** a list of
> LLM-greyed nodes, each with `{nodeId, decision, reason, quotedReasoning}`.

---

## 4. Causal-lineage highlight — per-node click (deterministic)

Independent of the Prune button. Clicking a node lights up its **causal**
neighborhood: backward = the operations/data that fed it, forward = what it
produced. This is `buildGraphIndex` + a causal-only walk (`graph-utils.ts`);
it is the interactive lens that makes the data flow legible. Following `causal`
(not `temporal`) edges here is the same rule the audit backtrace uses.

> **Expected output:** on click, the node's causal sources/products + connecting
> causal edges highlight; everything else dims.

---

## 5. Audit — per-node correspondence (the core)

### 5.1 Which nodes are auditable

| node kind | auditable? | what "Audit this node" does |
|---|---|---|
| **step** | ✅ | extract claims from its `pipilot.chat.response_text`; anchor each to its causal upstream (invoked tools, read files); compare. The GAIA "I read all data" lives here. |
| **chat** (sub-llm) | ✅ | same as step (it is reasoning) |
| **artifact** (note / report / tool-output with text) | ✅ | extract claims from the content + run the A1 citation check; anchor each claim to the artifact's **production chain** (`writes`/`creates` ← tool ← `reads`); compare |
| **tool** | ⚠️ partial | compare the **consuming step's** claim about this tool vs the tool's actual `args`/`reads`/`result`; or operation scope (invocation vs `reads`) |
| **file / dir** | ❌ | raw data — no claim, no production. Click shows lineage (§4) but yields no verdict |
| **session / trace** | ❌ | container; may aggregate child findings |

A node type that is not auditable shows the "Audit this node" action **disabled**.

### 5.2 The mechanism (per auditable node)

1. **Extract claims** — *[LLM, one call per node]*. From the node's distilled
   output pull each factual/operational assertion as `{text,
   quantities:[{value,unit}], entities:[…], scope: ALL|EACH|SOME|null}`. Pure
   opinion/plan with no concrete assertion is dropped here. *This is the only
   LLM call on the main path.*

   Current input resolver (`resolveExtractionText`):
   - `step` / `chat` → `pipilot.chat.response_text`.
   - `tool` → the consuming step's `response_text` (the narrative about the
     tool), falling back to the tool's own `result`.
   - `artifact` → content read from its path on disk.
   - large blob refs are resolved, verbose tool payloads are distilled, and
     binary/mojibake/gibberish is dropped before the extractor sees it.
2. **Anchor** — *[deterministic]*. Match `entities` to graph nodes via
   `tokenMatchesNode` (file paths, artifact titles, dir/tool names). Operation
   claims ("I analyzed…") anchor to the tools the node's step `invokes`.
3. **Causal backtrace** — *[deterministic]*. From each anchor, pull the local
   causal neighborhood (`backwardClosure`, causal-only): the anchor tool's
   `args`, its `reads`/`retrieved` edges, its `result`, and any `listed`
   directory inventory.
4. **Compare** — *[deterministic]*. For each asserted `quantity`, find the
   comparable feature in the neighborhood and compare:
   - count of files → number of paths in `args` / number of `reads` edges
     (v1 granularity, §5.4).
   - a result value → numbers parsed from the anchor tool's `result`, after
     stripping blob/hash plumbing so content hashes never become result values.
   - `scope = ALL` → needs a **denominator**: the `listed` inventory of the
     target dir; check `read-set ⊇ listed-set`.
   - ordinary operation claims with no quantity (`fetch/open/convert/read X`)
     → `match` when the causal neighborhood contains the recorded tool/read/write
     action; otherwise they remain `unverifiable`.
   - Ordinal labels such as "table 4", "row 4", "Figure 2", "page 7", or
     "step 3" are identifiers, not counts; the checker excludes them from
     quantity comparison even if the extractor returned them.
   - Result values match exactly or when the recorded value rounds to the
     claim's displayed precision (`4.2` matches `4.234`).
   - Verdict: equal → `match`; contradicts (claim 10, reads 1) → `mismatch`
     with `dimension = scope`; claim value ≠ result value → `mismatch`,
     `dimension = result`; recorded operation present → `match` with
     `dimension = action`; no comparable feature (or no denominator) →
     `unverifiable`. The `dimension` is a **post-hoc label** of where the
     discrepancy landed, never a routing decision made up front.
5. **Escalate** — *[optional LLM, §9]*. `unverifiable` claims that are visual or
   semantic ("Figure 7 shows a shorter burst") may be sent, with the relevant
   evidence (incl. the image), to the demoted judge for a best-effort verdict.

### 5.3 Audit-flags as targeted triggers

Audit does not only start from claims (narrative-down). It also starts from
**audit-flags** (graph-up): each flag points the audit at a specific thing to
verify on the focused subgraph.

| audit-flag (from `computeFlags`) | current targeted check |
|---|---|
| `ungrounded_step` — a non-first step with **no incoming `returns`** (consumed no tool output) | does this step make a factual claim? if yes → a claim with **no provenance source** (phantom). Run §5.2 on exactly these steps. |
| `unused_output` — a product nothing reads (deliverable exempt) | current implementation emits an `unverifiable` flag finding: "produced X, but nothing downstream reads it". It does **not yet** prove whether the narrative claimed it was used/result. |
| `overwritten` — file written ≥3× / artifact ≥3 versions | current implementation emits an `unverifiable` flag finding: "may reference a stale, non-final value". It does **not yet** compare against old-version values. |
| `error` **but the product was consumed** into the answer | emits a `mismatch` flag finding: the answer consumed a failed operation. |

(`error`-and-unconsumed and superseded `repeated_intent` are **prune-flags**, not
audit-flags — they get greyed in §3, not surfaced here.)

### 5.4 Granularity (v1)

Lock to the clean case: when a tool's `args` **enumerate file paths**, count
them / count `reads` edges. When a tool was handed a *directory* and globbed
internally (the graph sees one `reads` of the dir), the count lives in the
tool's `result` or needs the `listed` denominator — if neither is present, judge
`unverifiable`. Do not dig into tool results for internal file counts in v1.

Additional deterministic guardrails already implemented:
- single ordinals/labels are not counts (`table 4` does not mean 4 tables);
- result comparison ignores blob/hash tokens and supports display rounding;
- `ALL` scope can be settled only with a reachable `listed` inventory.

---

## 6. LLM boundary (explicit)

| step | LLM? | why |
|---|---|---|
| build graph, A1 citations | **no** | pure projection / id-set resolution |
| prune §3.1 (deterministic focus + prune-flags) | **no** | deterministic causal flood |
| prune §3.2 — **adjudicate flagged nodes** (abandoned vs used) | **YES (scope, logged)** | `returns` can't expose adopt-vs-ignore; the LLM reads the reasoning. Never emits a verdict |
| causal-lineage highlight | **no** | deterministic causal walk |
| audit C.1 — **extract claims** | **YES (perception)** | reading natural-language assertions is the one thing only an LLM does well; output is then verified deterministically |
| audit C.2–C.4 — anchor / backtrace / compare / verdict | **no** | reproducible graph operations; the verdict is deterministic |
| audit C.5 — **escalation** (unverifiable visual/semantic) | **YES (optional)** | the demoted multimodal judge, only on the residue |

Three LLM touchpoints (prune adjudication, claim extraction, escalation); **none
produces the match/mismatch/unverifiable verdict** — that stays deterministic and
re-checkable from the recorded claim + graph.

### 6.1 Audit model configuration

The audit's LLM calls do **not** have to use the main agent model. Today they
inherit `state.currentModel` via `runMainCallLlm`; this section adds a setting.

- **Setting** (`shared-ui/settings-types.ts`, research settings): `auditModel:
  string`, default `'main'` (= follow the main agent model). Resolution follows
  the house config-priority rule (Settings UI > shell env > default).
- **Model menu** — a curated dropdown, deliberately surfacing the **cheap small
  tiers** for audit (claim extraction + prune adjudication are short, structured
  calls that small models handle well):
  - **`Same as main model`** (default)
  - **GPT small**: `gpt-…-mini`, `gpt-…-nano`
  - **Claude small**: `claude-haiku-…`
  - any other registry model the user picks.
  Exact ids resolve through the existing pi-ai model registry (`getModel`); the
  dropdown lists what the configured providers expose.
- **Split (recommended)**: two slots, because the two non-escalation calls are
  text-only but **escalation needs vision**:
  - `auditModel` — claim extraction + prune adjudication (small text model OK).
  - `auditVisionModel` — C.5 escalation (must be vision-capable; a small model
    that can't see images silently fails the figure case).
- **Wiring**: add `opts.model?` to `runMainCallLlm` (`const modelStr = opts.model
  ?? state.currentModel`); the audit handlers resolve the slot from settings and
  pass it. Auth/keys already resolve per-model via `resolveCoordinatorAuth`, so
  switching provider Just Works once that provider's key is configured.

---

## 7. Data structures

```ts
// C.1 output — what the LLM pulled from one node's output
interface ExtractedClaim {
  id: string
  sourceNodeId: string                 // the step/chat/artifact it came from
  text: string                         // verbatim
  quantities: { value: number; unit?: string }[]   // "10 files"→{10,"files"}; "4.2"
  entities: string[]                   // file/dir/dataset names, tool names, citation keys
  scope: 'ALL' | 'EACH' | 'SOME' | null
}

// C.4 output — the deterministic verdict
interface FaithfulnessFinding {
  claimId: string
  claimText: string
  anchorNodeIds: string[]              // the tool(s)/file(s) the claim is about
  verdict: 'match' | 'mismatch' | 'unverifiable'
  dimension?: 'scope' | 'result' | 'action' // post-hoc label of where it landed
  claimed: string                      // "10 files" / "mean 4.2"
  actual: string                       // "1 read edge" / "result=4.7"
  evidence: { nodeId: string; detail: string }[]
  flag?: string                        // set for graph-up flag findings / A1 citation
}

interface NodeAuditResult {
  cacheVersion?: number                 // persisted cache invalidation version
  nodeId: string
  nodeKind: NodeKind
  findings: FaithfulnessFinding[]
  triggeredFlags: string[]             // audit-flags that fired on this node
}

interface TraceAuditSummary {
  nodesAudited: number
  claims: number
  mismatch: number
  unverifiable: number
  match: number
  flags: number
  findings: { nodeId: string; finding: FaithfulnessFinding }[]
  coverage: {
    focusedTools: number
    coveredByClaim: number
    flaggedOnly: number
    silent: number
  }
}
```

Compatibility types (`Claim`, `EvidencePacket`, `ClaimVerdict`, `AuditReport`,
`AuditRunResult`) remain in `types.ts` for the demoted claim-entailment judge and
the C.5 escalation path. They are not the primary audit result shape.

---

## 8. Isolation & persistence

The hard rule: **audit products must never be readable by `projectGraph`**, or
the next audit would treat the previous audit's LLM steps as graph nodes —
"auditing the audit", a recursive pollution.

`projectGraph` globs `.research-pilot/traces/spans.*.jsonl` and reads the
artifact ledger and artifact JSON. Therefore:

- **All audit LLM calls (prune adjudication §3.2, claim extraction, escalation)
  emit no telemetry** — untraced, or detached to an audit-private sink, never
  into `traces/`. (Cf. the wiki-bg / memory-extractor `ROOT_CONTEXT` detachment
  in `trace-and-ledger-joins.md` §4.4, but more complete: a separate sink, not
  just a separate trace root.)
- **No audit bytes in any store outside `.research-pilot/audit/`** — not
  artifacts, not `*-ledger.jsonl`, not `traces/`.

**Run log (current implementation)**: `.research-pilot/audit/<nodeId>/<ts>.json`,
holding the `NodeAuditResult`. Evidence is referenced, never copied: small →
inline `detail`; large → `sha256:` blob ref reusing the existing
`.research-pilot/blobs/` store. The reference is one-directional: audit points at
telemetry's IDs/blobs; telemetry never points back. The run log is a *run log*,
not a source of truth.

Important as-built caveat: `runNodeAudit` returns `{result, claims,
diagnostics, logPath}` over IPC, but the persisted cache currently stores only
`NodeAuditResult`. `Audit trace` reuses that cached result. If future debugging
needs to inspect "what exactly did the extractor return?", extend the persisted
run log to include `claims`, `diagnostics`, model id, and prompt version.

---

## 9. Shelved / demoted

- **Support metrics** (`computeSupportMetrics`: `nGroundingTools`,
  `toolKindDiversity`, `redundancy`, `suspiciousRatio`) — retained as a UI
  diagnostic/readout in `PruneResult.supportMetrics`, but **shelved as any
  verdict/scoring signal**. They do not influence match/mismatch/unverifiable.
- **Claim-entailment judge** (`audit/judge.ts`: `supported`/`contradicted`/
  `ungrounded`/`not_checkable`, temperature-0, multimodal `collectAuditImages`,
  output validation) — **DEMOTED** from primary path to the optional **§5.2 C.5
  escalation** for `unverifiable` visual/semantic claims. Its anchoring
  (`claims.ts:tokenMatchesNode`), neighborhood/blob plumbing (`packet.ts`),
  multimodal image collection, sub-LLM wiring, and isolated persistence are
  **reused** by the new path.

---

## 10. UI

No global "Audit deliverable" button. Audit is invoked **per node**:

- **Select a node** → the right rail shows **"Audit this node"** (disabled for
  non-auditable kinds, §5.1). Running it produces this node's `NodeAuditResult`.
- **Audit trace** → runs per-node audits over the focused trace's candidate
  narrative nodes (`step`, `chat`, produced `artifact`), newest first,
  excluding deterministic-pruned and LLM-greyed nodes. The batch is concurrent
  (`audit.concurrency`), cache-first per node, streams progress via
  `audit:trace-progress`, isolates per-node failures, and returns
  `TraceAuditSummary`.
- **Findings panel** (per node, non-resident, closable), sections top-to-bottom:
  - 🔴 **Mismatches** (pinned): each = claim verbatim + `claimed: 10 files ·
    actual: 1 read` + `scope`/`result` tag. Click → highlight the anchor + its
    `reads` edges + the `listed` denominator on the **pruned** canvas.
  - 🟠 **Graph flags**: the audit-flag targeted-check results (§5.3).
  - ⚪ **Unverifiable** (muted): `needs vision/LLM`, each with a "Verify with
    LLM" button → C.5 escalation.
  - 🟢 **Match** (collapsed): corroborated claims (the positive support).
- **Coverage line**: `N claims · M mismatch · K unverifiable · J match · F flags`.
  Never claim 100% coverage.
- **Trace coverage line**: for `Audit trace`, show `coveredByClaim /
  focusedTools`, `flaggedOnly`, and `silent`. `silent` is the honest blind spot:
  tool operations with no narrative claim and no flag.
- The **canvas keeps prune's KEPT/PRUNED greying** and the A1 artifact badges;
  audit findings only point at KEPT nodes.

### 10.1 Audit trace batch semantics

`Audit trace` is not a different verdict system. It is a convenience wrapper
around the same per-node audit:

1. Compute `pruneGraph(graph)` and identify the focused trace.
2. Order candidate narrative nodes newest-first: focused-trace `step`/`chat`
   nodes plus artifacts produced by focused-trace tools.
3. Drop deterministic-pruned and caller-excluded/Prune-greyed nodes.
4. For each candidate, reuse the latest cached `NodeAuditResult` when present;
   otherwise run `runNodeAudit`.
5. Roll up findings into `TraceAuditSummary`, including the silent-tool coverage
   gap. The batch may return fewer findings when cached results are stale; cache
   invalidation is a future hardening item, not part of the verdict semantics.

**Finding drill-down highlight.** Clicking a finding focuses the source node.
The right inspector highlights the claim text/value in **blue** and the actual
recorded result value in **fuchsia**; regular provenance search remains
**amber**. Text matching is whole-token bounded (left/right non-alphanumeric)
and skips pure single-digit fallback terms, so digits in base64/hash/blob
plumbing do not scatter false highlights.

**Prune decisions on the canvas.** Prune-greyed nodes from the ambiguous-node
check render with a **distinct greying** from deterministic-pruned nodes (e.g. a
dashed outline), so the user can inspect which nodes were removed from scope by
model evidence rather than topology alone. The details panel shows the `reason` +
`quotedReasoning`; a per-node **"Keep anyway"** override re-includes it in audit
scope (the conservative-bias escape hatch from §3.2).

**Audit model picker (§6.1).** In Settings → Research, two dropdowns:
- **Audit model** — claim extraction + prune adjudication. Default *Same as main
  model*; the list highlights cheap small tiers (GPT `…-mini` / `…-nano`, Claude
  `haiku-…`).
- **Audit vision model** — escalation only; must be vision-capable.
Both follow Settings UI > env > default (the house config-priority rule).

---

## 11. Phasing

**Phase 1 (no LLM) — DONE.** deterministic correspondence main path (§5.2
C.2–C.4) on **step** nodes at the args-enumerate granularity (§5.4) —
scope/count mismatch + phantom (`ungrounded_step`) — built and tested with
hand-fed claims (`faithfulness.ts:auditNodeWithClaims`). Plus the deterministic
prune §3.1 greying error-abandoned nodes, and the prune-flag vs audit-flag split
(§3, §5.3).

**Phase 2 (first LLM + config) — DONE.** the **audit model setting** (§6.1,
`research.auditModel`/`auditVisionModel`) + `runMainCallLlm` `opts.model`
override; C.1 claim extraction (`extract-claims.ts`); `artifact` audit (with the
A1 citation check folded in) + `tool` audit (sourced from the consuming step,
`node-audit.ts`); result-value comparison (`dimension: 'result'`); the remaining
audit-flag targeted checks (`unused_output`/`overwritten` currently
`unverifiable`, `error`-consumed as `mismatch`); the per-node UI (§10 — "Audit
this node", findings panel, coverage line, click-to-focus) via the
`audit:run-node` IPC.

**Phase 3 (LLM-backed audit layers) — DONE (backend + UI).** Prune's internal
flagged-node check (`adjudicate.ts`, safety-bias KEEP enforced
deterministically) is folded into the single Prune control, with the distinct
dashed canvas greying + "Keep anyway" escape hatch; `listed`-denominator scope
checks for `ALL`; C.5 escalation (`escalate.ts` + `auditVisionModel`) for
unverifiable visual/semantic claims via `audit:escalate-finding`.

**Phase 4 (trace batch + audit UX hardening) — DONE.** `audit:audit-trace`
batch audit with cache-first node reuse, concurrency, progress events, per-node
error isolation, and `TraceAuditSummary` coverage (`coveredByClaim`,
`flaggedOnly`, `silent`); inspector highlighting split into search amber, claim
blue, actual-result fuchsia, with whole-token matching and single-digit fallback
suppression.

**Known follow-ups.**
- Persist `{claims, diagnostics, model, promptVersion}` alongside
  `NodeAuditResult` so cached audit runs remain fully inspectable.
- Upgrade `unused_output` and `overwritten` from current `unverifiable` flag
  findings into deeper deterministic/narrative checks when the needed evidence
  is available.
- Revive support metrics only if Goal 2 adds a trust-readout; they stay
  non-load-bearing for verdicts (§9).
