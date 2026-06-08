# Audit Pipeline — faithfulness audit over the Audit Graph

Status: design. Defines the ②③④⑤ stages that consume the Audit Graph
(`lib/audit-graph/`) and judge whether a deliverable is faithful to the
evidence the system actually recorded. The graph itself (stage ①) and its
backward-slice projection are specified by the code in `lib/audit-graph/` and
`app/src/renderer/components/center/audit/system-audit-projection.ts`.

This pipeline does **not** rebuild the graph and does **not** re-run any tool.
It reads the graph, extracts claims from the deliverable, builds a small
evidence packet per claim, and asks one LLM to judge entailment.

---

## 0. Locked principles

These are settled. Do not relitigate them in implementation.

1. **Audit = faithfulness, not correctness.** We only check the last mile —
   does the recorded evidence support this sentence — trusting evidence *as
   recorded*. We never re-run a tool, never recompute a number. If the summary
   says "mean is 4.2" we check the `data-analyze` tool's recorded output: if it
   said 4.2 → `supported`; if it said 4.7 → `contradicted`. Whether the tool's
   4.7 is itself correct is out of scope (that is evidence quality, a different
   problem, and re-checking it would be "redo the task").

2. **The primary product is the contradiction list.** Per-claim verdicts are a
   by-product. The value audit adds over "trust the model" is catching the two
   sides of the graph disagreeing with each other.

3. **Four verdicts:** `supported` / `contradicted` / `ungrounded` /
   `not_checkable`.
   - `contradicted` = failure (red), must carry a verbatim counter-quote.
   - `ungrounded` (asserted from the model's own knowledge, no session
     evidence) = **not a failure**; marked "low confidence" (amber), not red.
   - `not_checkable` = neutral (grey).

4. **The skip gate is anchor-presence, not a guessed type.** A claim that names
   nothing in the graph (no file/artifact/citation it can be matched to) has no
   evidence to check it against → `not_checkable`, with no LLM call. A claim
   that *does* anchor — even an interpretive one — goes to the judge, which may
   itself return `not_checkable`. Pure prose ("these results are promising")
   carries no anchor and is skipped for free; this subsumes the old
   "synthesis → not_checkable" rule without a brittle verb table.

5. **Typing is not a deterministic gate.** The deterministic step is *anchoring*
   — literal matching of a claim's groundable tokens (file paths, citation /
   figure / page refs) to graph nodes. The claim *type* (provenance /
   computation / action / citation / synthesis) is emitted by the judge as
   metadata for display only; it does not route evidence or gate the pipeline.

6. **Isolation of the loop.** Audit products are written ONLY to
   `.research-pilot/audit/`. The judge's LLM calls do NOT emit telemetry. Audit
   references evidence by ID/blob one-directionally; the telemetry side has zero
   back-pointers. **The graph never audits the audit.** See §8.

---

## 1. Pipeline overview

```
① build Audit Graph        ← program, from telemetry.        [separate spec]
② identify deliverable      ← claimsSource (final message) + products (written files)
③ split into claims         ← program, markdown structure + token anchoring. zero LLM
④ per-claim evidence packet ← program, claim-anchored backward slice
⑤ judge (claim, packet)     ← LLM, read-only. the ONLY LLM step
   → validate → AuditReport
```

Only stage ⑤ uses an LLM. Stages ②③④ are deterministic and reproducible.

---

## 2. Module layout

```
lib/audit-graph/audit/
  types.ts      — Claim / ClaimType / Verdict / EvidencePacket / AuditReport
  claims.ts     — ③ deliverable → blocks → token anchoring (deterministic)
  packet.ts     — ④ claim-anchored local evidence packet
  judge.ts      — ⑤ LLM entailment + program validation
  run.ts        — orchestrator: deliverable → claims → packets → judge → report
```

**Prerequisite refactor** (coordinate with the agent doing graph Change C):
lift the slice primitives `classifyEdge`, `edgeKey`, and adjacency construction
out of `system-audit-projection.ts` (currently under the renderer) into
`lib/audit-graph/`, so both the renderer projection and the lib packet builder
share them.

---

## 3. Data structures (`types.ts`)

```ts
type ClaimType = 'provenance' | 'computation' | 'action' | 'citation' | 'synthesis'
type Verdict   = 'supported' | 'contradicted' | 'ungrounded' | 'not_checkable'

interface Claim {
  id: string                 // 'claim_1' …
  text: string
  blockKind: 'heading' | 'paragraph' | 'bullet' | 'table-row' | 'caption'
  anchors: { token: string; nodeId: string; side: 'input' | 'product' }[]
  // No `type`: typing is judge metadata (ClaimVerdict.claimType), not a
  // program-computed routing key. `side` is informational only.
}

interface EvidencePacket {
  claimId: string
  nodes: {
    id: string; kind: NodeKind; label: string
    excerpt: string           // the node's ≤4KB body
    truncated: boolean
    blobHash?: string         // 'sha256:…' into .research-pilot/blobs/ when truncated
  }[]
  edges: GraphEdge[]
  expandable: string[]        // truncated node ids whose full blob can be loaded
}

interface ClaimVerdict {
  claimId: string
  claimText?: string
  claimType?: ClaimType             // emitted by the judge; display metadata only
  verdict: Verdict
  usedEvidenceIds: string[]
  groundedInSession: boolean        // false → low-confidence annotation
  quotedContradiction?: string      // required (verbatim) when contradicted
  explanation: string
  valid: boolean                    // program validation result
  invalidReason?: string            // 'invalid_judge_output' detail
}

interface AuditReport {
  deliverableId: string
  claims: ClaimVerdict[]
  coverage: {
    total: number; checkable: number
    supported: number; contradicted: number
    ungrounded: number; notCheckable: number
  }
  contradictions: ClaimVerdict[]    // pinned, actionable list
}
```

---

## 4. ② Deliverable

The deliverable is two things, not one:

- **claimsSource** — the final assistant message (the `response_text` event of
  the `claimsSource` step the projection exposes), OR a user-designated
  `answer.md` artifact. This is where claims are extracted from.
- **products** — the files/artifacts written this turn (`productNodes` from the
  projection, reached via `writes`/`creates` edges). The actual work the message
  is *making claims about*.

The final message is a *claim about* the work, not the work. Action claims must
be checked against `products`, not against the message text — this is why the
two are separated.

---

## 5. ③ Claim extraction + anchoring (`claims.ts`, zero LLM)

There is no deterministic typing step. The only program decision is anchoring.

1. **Deliverable text** = claimsSource's `response_text`.
2. **Markdown blocks**: heading / paragraph / bullet / table-row / caption.
3. **Extract groundable tokens** from every block, regardless of kind:
   - **file paths** (`*.md/.csv/.py/.pdf/…`)
   - **citation / figure / page refs** (`(Author Year)`, DOI, arXiv id,
     `Figure N`, `Table N`, `page N`).
   - Bare numbers are **not** tokens — a number is the value being verified, not
     a locator (node search text carries no numbers anyway).
4. **Anchor**: match each token against `file` / `artifact` / `dir` nodes (try
   the product set first, then the input set, then any node). Matched node ids
   populate `claim.anchors`, each tagged with the `side` it matched on
   (informational). Deterministic — no LLM picks nodes.
5. **No type is computed.** Whether a claim is "action" vs "citation" is decided
   by the judge later and stored as metadata.

A claim with no anchor proceeds to the judge stage, where it short-circuits to
`not_checkable` without an LLM call (§7). Known v1 limitation: a computation
claim that names no file/source (e.g. "the mean is 4.2", no data file
mentioned) has nothing to anchor to and is therefore `not_checkable`.

---

## 6. ④ Claim-anchored evidence packet (`packet.ts`)

Per claim, do NOT do uniform BFS from the deliverable root. Anchor the packet to
what the claim actually names:

1. **Start nodes** = all of the claim's anchor node ids (no type filter). The
   traversal is bidirectional, so it pulls **both** the input side
   (reads/retrieved) and the product side (writes/creates) around each anchor;
   the judge sees both and decides which matters.
2. **Small-radius slice** (≤2 hops along data + control edges): anchor file →
   the tool that produced/read it → its step → that step's other inputs/outputs.
   Cap with `maxNodes`.
3. Each evidence node carries its ≤4KB `excerpt`, a `truncated` flag, and
   `blobHash`; truncated nodes go into `expandable`.
4. No anchors → empty packet → the judge stage short-circuits to
   `not_checkable` (§7) without an LLM call.

Anchoring keeps each packet small and relevant, and kills the "mechanical round
1/2/3" expansion problem — the packet is exactly the subgraph reachable from
this claim's referents.

---

## 7. ⑤ Judge + validation (`judge.ts`)

**Anchor-presence gate (no LLM)**: if `claim.anchors.length === 0`, return
`not_checkable` immediately — there is nothing in the graph to check the claim
against. Only anchored claims reach the LLM.

**Call path**: reuse the existing sub-LLM channel (same as memory extractor /
intent router) at `temperature: 0`, but **detached from telemetry** (see §8).

**System prompt constraints:**
- You perform a *faithfulness* audit: judge only whether this evidence supports
  this sentence; do NOT judge whether the evidence itself is correct.
- You may cite ONLY evidence ids present in the packet.
- `contradicted` MUST quote the contradicting text verbatim.
- `supported` MUST cite ≥1 evidence id.
- If the packet's excerpts are insufficient to decide, output `insufficient`
  (a signal, not a final verdict).
- Set `groundedInSession`: is this backed by session evidence, or asserted from
  your own knowledge?
- Emit `claimType` (provenance / computation / action / citation / synthesis) as
  a label only — it does not affect the verdict and is used for display.

**`insufficient` → fetch full blob → re-judge (once):**
- If the judge returns `insufficient` and `expandable` nodes exist → load their
  full blobs, rebuild packet content, judge once more.
- Still insufficient → final verdict `ungrounded`.
- This guarantees we have seen the FULL evidence before declaring `ungrounded`,
  preventing false hallucination alarms caused by a capped excerpt.

**Figure images (multimodal).** A PNG/JPG evidence node's text excerpt is binary
and useless — a text-only judge can only ever return `ungrounded`/`not_checkable`
on a visual claim ("Figure 7's x-axis spans 0.35–0.65 s"). So `collectAuditImages`
pulls image bytes from each image file-node in the packet (its recorded `path`,
falling back to the blob store), capped in count and per-image size, and attaches
them to the judge call as `ImageContent`. This is still faithfulness, not redo:
the image is the recorded observation the agent saw, replayed to the auditor — we
do not re-run the figure-cropping tools. Only then can a visual claim reach
`supported`/`contradicted`.

**Determinism.** The judge call runs at `temperature: 0` (threaded through
`runSubLlmText` → `SimpleStreamOptions.temperature`), so a fixed (claim, packet,
images) input yields a stable verdict — no run-to-run flapping between
`ungrounded` and `not_checkable` on boundary cases.

**Program validation (after the LLM):**
- Every `usedEvidenceId` must exist in the packet → else `valid=false`,
  `invalidReason='invalid_judge_output'`.
- `contradicted` must have a `quotedContradiction` that actually appears in some
  packet node's content → else invalid.
- `supported` with no evidence id → downgrade to `ungrounded`.
- Invalid verdicts are not trusted.

`groundedInSession === false` does not fail the claim — it renders as a neutral
low-confidence annotation (principle 3).

---

## 8. Isolation & persistence

The hard rule: **audit products must never be readable by `projectGraph`**, or
the next audit would treat the previous audit's judge steps as graph nodes —
"auditing the audit", a recursive pollution.

`projectGraph` globs `.research-pilot/traces/spans.*.jsonl` and reads the
artifact ledger, trace digest, and artifact JSON. Therefore:

- **Judge LLM calls emit no telemetry.** Either untraced, or detached to an
  audit-private sink — never into `traces/`. (Cf. the wiki-bg / memory-extractor
  `ROOT_CONTEXT` detachment in `trace-and-ledger-joins.md` §4.4, but more
  complete: a separate sink, not just a separate trace root.)
- **No audit bytes in any store outside `.research-pilot/audit/`** — not
  artifacts, not `*-ledger.jsonl`, not `traces/`.

**Run log**: `.research-pilot/audit/<deliverableId>/<ts>.json`, holding the
`AuditReport`. Evidence is referenced, never copied:
- small → inline `excerpt` (the node's ≤4KB body, enough to record the judgment).
- large → `sha256:` **blob ref reusing the existing `.research-pilot/blobs/`
  store** — no second copy.

This keeps audit products tiny yet fully **traceable**: a verdict →
`usedEvidenceIds` → node → `blobHash` → existing blob store → full bytes. The
reference is one-directional: audit points at telemetry's IDs/blobs; telemetry
never points back. The graph never knows audit exists.

The run log is a *run log*, not a source of truth. The graph remains the only
authoritative derivation, consistent with the projection-not-store axiom.

---

## 9. UI

Extends the Audit tab (reuses the three-column layout and the ProvenanceGraph
focus/highlight machinery):

- **Coverage bar** (top): `12 claims · 8 checkable · 5 supported · 1
  contradicted · 2 low-confidence · 4 not-checkable`. Never claim 100% coverage.
- **Contradiction list, pinned**: each shows the claim + verbatim counter-quote
  + jump. The actionable findings.
- **Deliverable colored by verdict per block**: supported green / contradicted
  red / ungrounded amber (low confidence) / not_checkable grey.
- **Click a claim** → highlight its packet's evidence nodes in ProvenanceGraph
  (reuse `focusRef`) + show the packet JSON fed to the LLM + an excerpt/full-blob
  toggle.
- **Click an evidence node** → open the existing blob viewer.

---

## 10. Trigger

A "Audit deliverable" button in the Audit tab runs the pipeline against the
selected trace's final message (default: latest turn). Claims are independent →
the run maps over them; their union never enters a single context window.

---

## 11. Phasing

**Phase 1 (this spec):** deterministic anchoring (incl. author-surname tokens),
anchor-presence skip gate, claim-anchored bidirectional packets, single-pass
judge at `temperature: 0` with one full-blob re-judge and figure-image
(multimodal) evidence, program validation, coverage bar + contradiction list,
isolated run-log persistence. Claim type is judge metadata. Unanchored claims
(incl. pure prose) → `not_checkable` with no LLM call.

**Later:** embedding fallback for anchoring (paraphrase that misses literal
token match); judge batching for claims sharing a packet; richer handling of
interpretive claims; cross-trace contradiction (staleness / overwrite
detection).
