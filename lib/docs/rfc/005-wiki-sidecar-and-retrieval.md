# RFC-005: Wiki Structured Sidecar, Reliability Semantics & Keyword-First Retrieval

**Status:** Proposed
**Author:** Captain + Claude
**Date:** 2026-04-11
**Extends:** RFC-003 (Global Paper Wiki)

## 1. Motivation

RFC-003 shipped a global paper wiki whose unit of knowledge is a Markdown page (`papers/<slug>.md`) plus a concept aggregation page. It works for humans, but agent-side utilization is weak:

- `wiki_lookup` is a single omnibus tool doing substring scan over whole files. It cannot rank, cannot filter, cannot normalize synonyms, and cannot tell the coordinator **how much the wiki already knows about a topic** before the coordinator decides to launch an external literature search.
- Every downstream question ("what dataset?", "what SOTA number?", "is there code?", "what didn't work?") re-parses the same prose at runtime. We pay the LLM tax on every read instead of once at write time.
- Concept pages are typed as prose, not as a graph. `flash-attn` and `flash-attention` fragment into two slugs because there is no alias discipline. Edges are implied by `[[slug]]` links inside paragraphs, with no relation type.
- The current wiki distinguishes **source availability** (`fulltext` vs `abstract-only`) but not **trust level**. A PDF converted to Markdown may still be noisy; the coordinator needs to know what was explicit in the source, what was lightly inferred, and what is unsafe to cite as a hard fact.

This RFC proposes two tightly coupled upgrades:

1. **Embedded structured sidecar with reliability semantics**: every paper page gains a JSON meta block appended to `papers/<slug>.md`, wrapped in `<!-- WIKI-META --> ... <!-- /WIKI-META -->` HTML comment markers. Produced by the **same single LLM call** that writes the Markdown body — no doubling of per-paper LLM spend. Optional fields, graceful degradation, never load-bearing. The sidecar records not just *what* we think the paper says, but *how grounded* each high-risk field is.
2. **Keyword-first retrieval stack**: a small set of focused tools (`wiki_search`, `wiki_get`, `wiki_coverage`, `wiki_facets`, `wiki_neighbors`) backed by write-time indices (inverted, alias, BM25). **No embeddings in v1** — purely deterministic code and pre-built files. Embeddings are a natural v2 extension but explicitly out of scope here.

### Design Axioms

> The system does not pursue complex architecture to guarantee quality. Instead, it pursues minimum discipline to guarantee survival + evidence-driven incremental improvement.

Specialized to this RFC:

1. **Sidecar is a cache, not a source of truth.** The Markdown body is always the canonical artifact. Every read path has a fallback that works when the meta block is absent, malformed, or stale. Stripping every `<!-- WIKI-META -->` block from `papers/*.md` must leave the coordinator working.
2. **Almost every sidecar field is optional.** Only a small top-level header is required (`schemaVersion`, identity/provenance, `source_tier`, `trust_tier`, `parse_quality`). Everything else is sparse by design. Abstract-only papers, non-empirical papers, survey papers, and partially-parsed fulltexts all produce valid sidecars — just sparser ones.
3. **Write-time LLM work is amortized retrieval.** Anything the coordinator would re-derive at runtime (tl;dr, citation sentences, dataset list, Q&A pairs) is paid for once during sidecar extraction and reused forever.
4. **Keyword retrieval must be smarter than substring, but not more complex than a JSON file.** No embeddings, no vector DB, no external dependencies. The win comes from write-time indexing + query-time alias expansion + facet filtering.
5. **Tools announce their own coverage.** The coordinator must never have to guess whether the wiki has useful material on a topic. Every search result includes a coverage signal; a dedicated `wiki_coverage` tool exposes the global facet distribution.
6. **Source tier is not trust tier.** `fulltext` only means “we had converted fulltext available”, not “every extracted detail is reliable”. Trust is a separate signal surfaced to the coordinator.
7. **Observed and inferred knowledge must be distinguishable.** For high-risk fields, the sidecar records whether a statement was explicit in the source, lightly inferred, or synthesized.
8. **Abstention beats brittle detail.** If the extractor cannot ground a metric, limitation, negative result, or relation edge with enough confidence, it omits the field and records the unknown instead of hallucinating a precise answer.

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  wiki sub-agent (background, single writer)                  │
│                                                              │
│  processPaper(artifact)                                      │
│    ├─ generatePaperPage()   → papers/<slug>.md               │
│    │     body + <!-- WIKI-META --> JSON block (ONE call)     │
│    ├─ identifyConcepts()    → concepts/*.md                  │
│    └─ updateIndices()       → index/*.json       (NEW)       │
│           ├─ bm25.json       (token → {slug, field, tf})     │
│           ├─ aliases.json    (alias → canonical slug)        │
│           ├─ by-dataset.json                                 │
│           ├─ by-concept.json                                 │
│           ├─ by-year.json                                    │
│           ├─ by-trust-tier.json                              │
│           ├─ graph.jsonl     (typed edges)                   │
│           └─ facets.json     (top-level counts)              │
└──────────────────────────────────────────────────────────────┘
                              │  read-only
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  coordinator tools (replace single wiki_lookup)              │
│                                                              │
│  wiki_search(query, k, filters?)     — hybrid keyword search │
│  wiki_get(slug, sections?)           — structured read       │
│  wiki_coverage(topic?)               — "what does wiki know" │
│  wiki_facets(facet)                  — enumerate values      │
│  wiki_neighbors(slug, relation?)     — graph traversal       │
└──────────────────────────────────────────────────────────────┘
```

No new processes. No new dependencies. All new state lives under `~/.research-pilot/paper-wiki/` in plain files.

## 3. Directory Layout (delta from RFC-003)

```
~/.research-pilot/paper-wiki/
├── papers/
│   └── <slug>.md                  # body + trailing <!-- WIKI-META --> JSON block
├── concepts/
│   └── <slug>.md                  # body + trailing <!-- WIKI-META --> JSON block
├── index/                         # NEW — write-time built
│   ├── bm25.json                  # inverted token index with field weights
│   ├── aliases.json               # alias → canonical slug map
│   ├── by-dataset.json            # dataset name → [slug]
│   ├── by-concept.json            # concept slug → [slug]
│   ├── by-year.json               # year → [slug]
│   ├── by-trust-tier.json         # trust_tier → [slug]
│   ├── graph.jsonl                # {from, to, type}
│   ├── facets.json                # {datasets: {...counts}, concepts: {...}, years: {...}, trustTiers: {...}}
│   └── query_log.jsonl            # NEW — empty-result queries for coverage analysis
└── .state/
    └── sidecar_status.jsonl       # NEW — per-paper sidecar extraction outcome
```

Every file under `index/` is fully derivable from the Markdown pages (body + embedded meta blocks). They can be nuked and rebuilt with a single `rebuildIndex()` call.

## 4. Sidecar Schema

### 4.1 TypeBox Schema

```typescript
// lib/wiki/sidecar-schema.ts
import { Type, type Static } from '@sinclair/typebox'

export const SIDECAR_SCHEMA_VERSION = 2

// ── enums ────────────────────────────────────────────────────────────
// Six generic values that span ML, chemistry, biology, physics,
// economics, and humanities. See §4.3 for rationale.
export const PaperType = Type.Union([
  Type.Literal('method'),     // proposes a new approach / algorithm / synthesis / tool
  Type.Literal('empirical'),  // measurement / observation / experiment; no major new method
  Type.Literal('review'),     // survey / systematic review / meta-analysis
  Type.Literal('resource'),   // introduces a dataset / benchmark / library / corpus / compound set
  Type.Literal('theory'),     // proof / derivation / formal analysis
  Type.Literal('position'),   // opinion / commentary / perspective / roadmap
])

export const DatasetEntry = Type.Object({
  name: Type.String(),                  // "MNIST", "compound 3b", "HeLa cells", "LHC Run 2"
  alias: Type.Optional(Type.String()),
  role: Type.Optional(Type.Union([
    Type.Literal('used'),               // training/input/substrate/observed subject
    Type.Literal('introduced'),         // this paper first releases/constructs it
    Type.Literal('compared_to'),        // used as a control or reference set
  ])),
  section: Type.Optional(Type.String()), // navigation hint: where in body to find it
})

export const FindingEntry = Type.Object({
  statement: Type.String(),              // full-sentence paraphrase; BM25 primary field
  value: Type.Optional(Type.String()),   // "78.2%", "3.1×", "−4.2 eV", "HR 0.82"
  context: Type.Optional(Type.String()), // dataset / cohort / substrate / simulation config
  comparison: Type.Optional(Type.String()), // "vs 0.66 human baseline"
  section: Type.Optional(Type.String()),
})

export const BaselineRef = Type.Object({
  name: Type.String(),
  canonicalKey: Type.Optional(Type.String()),
  section: Type.Optional(Type.String()),
})

export const ConceptEdge = Type.Object({
  slug: Type.String(),
  relation: Type.Union([
    Type.Literal('introduces'),
    Type.Literal('uses'),
    Type.Literal('advances'),
    Type.Literal('critiques'),
  ]),
  section: Type.Optional(Type.String()),
})

export const DescriptiveText = Type.Object({
  text: Type.String(),
  section: Type.Optional(Type.String()),
})

export const WikiPaperSidecarV2 = Type.Object({
  // ── provenance (code-assigned + header) ──────────────────────
  schemaVersion: Type.Literal(2),
  canonicalKey: Type.String(),
  slug: Type.String(),
  generated_at: Type.String(),          // ISO
  generator_version: Type.Number(),
  source_tier: Type.Union([             // what source material existed
    Type.Literal('metadata-only'),
    Type.Literal('abstract-only'),
    Type.Literal('fulltext'),
  ]),
  parse_quality: Type.Union([           // holistic LLM judgment on converted text
    Type.Literal('clean'),
    Type.Literal('noisy'),
    Type.Literal('unknown'),
  ]),

  // ── required classification ──────────────────────────────────
  paper_type: PaperType,                // REQUIRED — forces facet categorization

  // ── retrieval preview fields ─────────────────────────────────
  tldr: Type.Optional(Type.String()),   // ≤200 chars, one-sentence contribution summary

  // ── free-form classification (cross-discipline) ──────────────
  task: Type.Optional(Type.Array(Type.String())),
  methods: Type.Optional(Type.Array(Type.String())),  // merged method_family + architecture

  // ── retrieval-oriented content fields ────────────────────────
  datasets: Type.Optional(Type.Array(DatasetEntry)),
  findings: Type.Optional(Type.Array(FindingEntry)),   // renamed from metrics
  baselines: Type.Optional(Type.Array(BaselineRef)),
  code_url: Type.Optional(Type.String()),
  data_url: Type.Optional(Type.String()),

  // ── graph edges (ablates removed — ML-specific) ──────────────
  concept_edges: Type.Optional(Type.Array(ConceptEdge)),

  // ── normalization aid ────────────────────────────────────────
  aliases: Type.Optional(Type.Array(Type.String())),

  // ── descriptive fields (transcription, not self-assessment) ──
  limitations: Type.Optional(Type.Array(DescriptiveText)),
  negative_results: Type.Optional(Type.Array(DescriptiveText)),

  // Fields deliberately absent from V2 — see §4.3 for rationale:
  //   trust_tier, FieldEvidence.{confidence, inference_level, source_span},
  //   caveats / known_unknowns / unsafe_to_assume,
  //   qa_pairs, hardware_scale, contribution_oneliner, draft_hint,
  //   citation_snippet, citation_roles, prior_work, extraction_status.
})

export type WikiPaperSidecar = Static<typeof WikiPaperSidecarV2>
```

### 4.2 Field Applicability by Paper Type

Cross-discipline: rows cover the six `paper_type` values, not just ML subcategories.

| Field | `method` | `empirical` | `review` | `resource` | `theory` | `position` |
|---|---|---|---|---|---|---|
| `tldr`, `paper_type` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `task`, `methods` | ✅ | ✅ | ✅ (as scope) | ✅ | ✅ | ⚠️ |
| `datasets` | ⚠️ if reported | ✅ | ⚠️ listed | ✅ (introduced) | ❌ | ❌ |
| `findings` | ✅ | ✅ | ⚠️ (meta-findings) | ❌ | ⚠️ (derived results) | ❌ |
| `baselines` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| `code_url`, `data_url` | ✅ | ⚠️ | ❌ | ✅ | ⚠️ | ❌ |
| `concept_edges` | ✅ | ✅ | ✅ (broad) | ✅ | ✅ | ✅ |
| `aliases` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `limitations`, `negative_results` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| `parse_quality` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Every non-provenance field is optional except `paper_type`. A minimal valid sidecar for, say, a historical position paper would be just the provenance header + `paper_type: "position"` + `tldr`. Sparse is normal, not broken. See §4.3 for why we removed the reliability-signal fields that used to live here.

### 4.3 Retrieval/Citation Separation (core design principle)

This is the single most important decision in RFC-005. An earlier draft tried to give the sidecar a first-class **reliability layer**: `trust_tier`, `FieldEvidence.confidence`, `FieldEvidence.inference_level`, `caveats`, `known_unknowns`, `unsafe_to_assume`. The intent was to let the coordinator know *how much to trust each extracted fact*. We removed all of that. Here is the reasoning in full, because the rest of the RFC depends on it.

#### The problem with reliability signals

Any "how trustworthy is this?" signal has to be produced by someone. Only two candidates exist:

1. **The LLM self-assesses.** But self-assessment is the thing LLMs are worst at. They are systematically overconfident, they cannot reliably distinguish "I read this" from "I synthesized this", and they will happily mark a fabricated metric as `confidence: high`. A signal whose generator is the least reliable part of the pipeline is not a signal — it is noise wearing a lab coat.
2. **The parser computes it deterministically** from verifiable evidence (e.g., "is the quoted span a literal substring of the source text?"). This is better, but it multiplies complexity: the LLM has to emit verbatim quotes, the parser has to do fuzzy-substring matching, the span verification has to cover Unicode normalization, stripped formatting, and paraphrased edges. And even then, the resulting `confidence` answer is only as good as the narrow thing it measures — "did the span match" — which is not the same as "is the claim true".

Either way, we would be spending real engineering effort to produce a signal whose **best-case accuracy is still too weak to support high-stakes decisions** like "is this metric safe to cite from". And if the signal is wrong, any downstream system that consults it is acting on a lie.

#### The architectural response

Instead of trying to generate a reliable confidence signal, **we design the architecture so that the signal is unnecessary**. The core axiom:

> **Sidecars are retrieval indices, not fact caches.**
> **Retrieval from sidecar, citation from body.**
> **A wrong number in the sidecar costs a wasted read, never a wrong quote.**

This is a role separation, not a defensive add-on:

- **The Markdown body** is the authoritative text. It preserves the original LLM's hedging language, section structure, and context. Any factual claim that will be written into a draft, quoted, cited, or compared against another paper comes from the body, never from the sidecar.
- **The sidecar** exists to help the coordinator *find the right paper* and *decide whether it is worth reading*. Its fields feed BM25 ranking, facet filters, the concept graph, and the coverage signal — all of which are robust to individual wrong values.

The failure modes of a wrong sidecar entry under this principle:

| Wrong field | Worst-case effect |
|---|---|
| `tldr` paraphrases badly | Agent sees a misleading preview, reads body, moves on |
| `paper_type` misclassifies | Paper is excluded from a facet filter it should match (loss of recall, not wrong quote) |
| `datasets[0].name` wrong | Paper mislinked in `by-dataset` index; one wasted click when agent follows the link |
| `findings[0].value` wrong | Search for the wrong number lands on this paper; agent reads body, sees the real number, moves on |
| `concept_edges[0]` wrong | One extra or missing edge in the graph; one wasted traversal step |
| `limitations[0].text` wrong | Paraphrase is slightly off; agent reads the real Limitations section in the body to verify |

Every failure is bounded to **one wasted read**. None of them propagate into a draft, an answer, or a comparison table, because those never read from the sidecar in the first place.

#### What the LLM is asked to do (and not asked to do)

Reframed through this lens, the LLM's job on the meta block is **generous, not cautious**. The prompt-level guidance becomes:

- **Coverage beats precision.** Fill a field whenever you have any plausible grounding for it. Readers will verify from the body if they need the precise form.
- **Do not guess types or structure.** Output valid JSON, not prose approximations of JSON.
- **Do not fabricate numbers, URLs, or named entities that do not appear in the source text.** These are the only hard "do not invent" rules — the body is the verification path for everything else.

What we do *not* ask:

- No self-assessment of confidence.
- No distinction between "explicit" and "lightly inferred".
- No self-assessment of overall trust tier.
- No listing of "what the reader might misread".

LLMs are good at summarizing, paraphrasing, extracting named entities from provided text, classifying into small closed enums, and selecting from provided option lists. The V2 schema asks them to do exactly those things, and nothing else.

#### Signals we kept

Two signals survive because they are either assigned deterministically or their failure mode is mild:

- **`source_tier`** is **code-assigned**. We know what we fed into the LLM: metadata only, abstract only, or converted fulltext. No LLM judgment involved.
- **`parse_quality`** is LLM-provided holistic text-quality judgment (`clean` / `noisy` / `unknown`). LLMs are actually reasonable at this — they can look at converted text and tell you whether tables broke, whether section boundaries are intact, whether the text reads as continuous prose. When this signal is wrong, the worst case is that the agent over- or under-weights a body read by a small amount. No fact propagation.

These two signals together give the coordinator enough to decide "how much to explore this paper" without ever claiming "how much to trust a specific number". Trust never enters the vocabulary.

#### Tool-level enforcement

The separation is enforced by tool design, not by agent discipline. §8.2 introduces two section namespaces for `wiki_get`:

- `body:*` sections are parsed out of the Markdown body (the authoritative text)
- `index:*` sections are served from the parsed sidecar (the retrieval summary)

Tool descriptions tell the coordinator explicitly: **never cite from `index:*`; use `index:*` only to decide which `body:*` to read**. `wiki_search` does not return raw sidecar values in its hits — only `slug`, `title`, `tldr`, `score`, and which fields matched. To get a number, the coordinator has to make a deliberate `wiki_get` call with a `body:*` section. There is no path where a wrong sidecar value slips into a draft by accident.

This is the answer to the question "how do we stay correct when the sidecar is wrong?": we stay correct because the sidecar is never the source of correctness. It is a map, not a territory.

### 4.4 Concept Sidecar (embedded meta block in concepts/&lt;slug&gt;.md)

```typescript
export const WikiConceptSidecarV2 = Type.Object({
  schemaVersion: Type.Literal(2),
  slug: Type.String(),
  name: Type.String(),
  aliases: Type.Array(Type.String()),            // source of truth for alias map
  parent_concept: Type.Optional(Type.String()),
  related_concepts: Type.Array(Type.String()),
  papers: Type.Array(Type.Object({
    slug: Type.String(),
    relation: Type.Union([                        // matches ConceptEdge.relation (4 values, no `ablates`)
      Type.Literal('introduces'),
      Type.Literal('uses'),
      Type.Literal('advances'),
      Type.Literal('critiques'),
    ]),
    added_at: Type.String(),
  })),
  generated_at: Type.String(),
  generator_version: Type.Number(),
})
```

The concept `.md` body remains the human-readable page. The trailing `<!-- WIKI-META -->` JSON block is the graph node. Unlike paper meta blocks, concept meta blocks are **deterministically** regenerated from aggregated paper edges — no LLM call — and rewritten in place whenever the underlying edges change.

## 5. Prompt Changes

### 5.1 Single-Call Output Shape

Rather than adding a second LLM call per paper, the existing Markdown-generation prompts (`wiki-paper-fulltext` and `wiki-paper-abstract`) are extended to emit **both** the Markdown body **and** the structured meta block in one response. Per-paper cost delta is only the extra tokens for the meta JSON — no second round-trip, no separate orchestration path.

Every generated paper page now looks like:

```
# Paper Title

**Authors:** ...  |  **Year:** ...  |  **Venue:** ...

## Summary / Key Contributions / ... (existing sections unchanged)

<!-- WIKI-META -->
(fenced JSON block with the meta object below)
<!-- /WIKI-META -->
```

HTML comment markers render invisibly in Markdown viewers. Parsing is a 5-line operation: locate the two markers, extract the fenced JSON between them, `JSON.parse`. **If the LLM omits the meta block entirely or the JSON inside fails to parse, the body before the opening marker is still a valid wiki page** (equivalent to today's RFC-003 output). That is the structural failure-isolation boundary — no separate LLM call needed to guarantee it.

### 5.2 Prompt Addendum

The addendum below is concatenated onto the end of **both** `wiki-paper-fulltext` and `wiki-paper-abstract` in `lib/agents/prompts/index.ts`. No new prompt key is registered.

```
// PROMPT ADDENDUM — appended to wiki-paper-fulltext and wiki-paper-abstract.
// The LLM is given: (1) paper metadata, (2) optionally the converted fulltext,
// (3) existing concept slugs for [[...]] linking. It produces the Markdown
// body as before, then the meta block.

After emitting the final Markdown section of the paper page, output the structured meta block in this exact form, and then STOP generating (nothing after the closing marker):

  <!-- WIKI-META -->
  (opening json fence) { ...meta object matching the schema below... } (closing fence)
  <!-- /WIKI-META -->

The meta block is a RETRIEVAL INDEX, not a fact cache. Readers will quote specific details from the Markdown body you just wrote — never from this meta block. Your goal is COVERAGE, not precision. Fill any field you have reasonable grounding for. If you are unsure of an exact number or phrasing, it is better to include an approximate paraphrase (so the paper can be found) than to omit the field.

HARD RULES (the only "do not invent" constraints):
- Do not fabricate dataset/compound/cohort names, URLs, or named entities that do not appear in the source text.
- Do not guess JSON structure. Output valid JSON with the exact shape below.
- Do not invent numeric values with no grounding in the source; if you want to note a quantitative claim but are unsure of the number, include `statement` without `value`.

SCHEMA (TypeScript-like; only schemaVersion, canonicalKey, slug, source_tier, parse_quality, and paper_type are required; everything else is optional):

{
  schemaVersion: 2,                       // REQUIRED, literal 2
  canonicalKey: string,                   // REQUIRED, provided in the user message
  slug: string,                           // REQUIRED, provided in the user message
  source_tier: "metadata-only" | "abstract-only" | "fulltext",  // REQUIRED, provided

  parse_quality: "clean" | "noisy" | "unknown",  // REQUIRED — holistic judgment on converted text
                                                  // "clean": continuous prose, section boundaries intact
                                                  // "noisy": garbled tables, broken section headers, OCR artifacts
                                                  // "unknown": abstract-only or metadata-only — no fulltext to judge

  paper_type: "method" | "empirical" | "review" | "resource" | "theory" | "position",  // REQUIRED
    // method    — proposes a new approach, algorithm, synthesis route, tool, or procedure
    // empirical — measurement, observation, or experiment without a major new method
    // review    — survey, systematic review, meta-analysis
    // resource  — introduces a dataset, benchmark, library, corpus, or named set of materials
    // theory    — proof, derivation, formal analysis
    // position  — opinion, commentary, perspective, roadmap

  tldr?: string,                          // ≤200 chars, one-sentence contribution summary

  task?: string[],                        // free-form, discipline-native language
                                          // ML:   ["long-context language modeling"]
                                          // chem: ["asymmetric hydrogenation of α,β-unsaturated ketones"]
                                          // bio:  ["protein-protein interaction prediction"]
  methods?: string[],                     // free-form; include specific AND general names
                                          // e.g., ["flash attention", "transformer decoder", "IO-aware kernel"]

  datasets?: [{
    name: string,                         // dataset / compound / cell line / cohort / simulation config
    alias?: string,
    role?: "used" | "introduced" | "compared_to",
    section?: string                      // navigation hint: "Experiments", "Section 4.3", "Table 2"
  }],
  findings?: [{
    statement: string,                    // full sentence paraphrase — BM25 primary field
                                          // e.g., "balanced accuracy 0.65 on ICLR 2022 review prediction"
                                          //       "78% yield of compound 3b under mild conditions"
                                          //       "binding energy −4.2 eV for the (110) surface"
    value?: string,                       // isolable numeric form when easily extracted
    context?: string,                     // dataset / substrate / cohort / system this applies to
    comparison?: string,                  // "vs 0.66 human", "vs 56% control"
    section?: string
  }],
  baselines?: [{
    name: string,
    canonicalKey?: string,
    section?: string
  }],
  code_url?: string,
  data_url?: string,

  concept_edges?: [{
    slug: string,                         // kebab-case; prefer existing slugs from the provided list
    relation: "introduces" | "uses" | "advances" | "critiques",
    section?: string
  }],

  aliases?: string[],                     // alternate names for this paper's method/system
                                          // e.g., ["FlashAttention", "flash-attn", "IO-aware attention"]

  limitations?: [{
    text: string,                         // paraphrase of explicit limitations from the paper
    section?: string
  }],
  negative_results?: [{
    text: string,                         // paraphrase of explicit "X did not work" statements
    section?: string
  }]
}

OUTPUT RULES:
- Output the complete Markdown body FIRST (as the existing prompt specifies), THEN the meta block between <!-- WIKI-META --> and <!-- /WIKI-META --> markers with the JSON wrapped in a json-fenced code block.
- Nothing after the closing <!-- /WIKI-META --> marker. Stop generation there.
- Exactly one meta block per page. No trailing commas, no comments inside the JSON, use double quotes.
- If you cannot produce a valid meta block, OMIT it entirely. An absent meta block is treated as "sidecar missing" and retried later; a malformed one risks corrupting the page.
- Favor coverage over precision. A field with an approximate value is more useful than a missing field, because readers verify from the body anyway.
- Section hints are navigation aids, not citations. A plausible section name is fine ("Results", "Methods §3"). Do not fabricate section numbers.
- For abstract-only inputs: you will usually be able to fill schemaVersion/canonicalKey/slug/source_tier/parse_quality/paper_type/tldr/task/methods/aliases/concept_edges (shallow), and possibly limitations if the abstract mentions them. Omit the rest.
```

### 5.3 Concept Sidecar Generation

Concept meta blocks are built **deterministically** from paper meta blocks — no LLM call. When a paper's `concept_edges` mentions `{slug: "flash-attention", relation: "introduces"}`, the indexer:

1. Loads `concepts/flash-attention.md` (or creates it if absent).
2. Parses any existing `<!-- WIKI-META -->` block; if missing, starts with an empty concept sidecar object.
3. Appends `{slug: <paperSlug>, relation: "introduces", added_at: now}` to `papers[]` (idempotent by `paperSlug`) **only when the edge has `evidence.confidence !== "low"` and `evidence.inference_level !== "synthesized"`**.
4. Merges the paper's relevant `aliases` into the concept's alias list.
5. Serializes the updated concept sidecar and rewrites the `<!-- WIKI-META -->` block at the end of the concept page, leaving the human-readable body above it untouched.

The concept **Markdown body** is still LLM-generated (existing `wiki-concept-generate` prompt, untouched). Only the trailing meta block is deterministic. Body and meta block are independent writers into the same file; both use `safeWriteFile` under the wiki lock, so there is no race.

## 6. Resilience Strategy — Answer to Captain Question #1

> "所有的论文都能生成你想要的东西么？如果产生的 JSON 格式出了问题，怎么保证一切继续 work？"

The system has **four layers of resilience**, each designed so the layer below can fail without breaking anything above it.

### 6.1 Layer 1 — Schema accepts everything and rewards abstention

Only the top-level provenance + reliability header is required. Everything else may be omitted. Abstract-only papers, theory papers, and surveys produce valid sparse sidecars. There is no "this paper failed to produce metrics" — metrics are simply omitted. The schema *encodes* the fact that papers are heterogeneous.

High-risk fields are intentionally shaped so the extractor can abstain:

- `metrics`, `limitations`, `negative_results`, `concept_edges`, and `qa_pairs` can be dropped individually without invalidating the sidecar.
- `known_unknowns` and `unsafe_to_assume` give the coordinator useful output even when the extractor withholds a specific detail.
- `trust_tier` can stay conservative (`abstract-grounded` or `fulltext-unverified`) even when other top-level fields are present.

### 6.2 Layer 2 — Meta block parsing is a synchronous, offline operation

Because the meta block is produced by the **same** LLM call that writes the Markdown body, there is no separate orchestration to fail. The wiki agent writes the raw LLM response to `papers/<slug>.md` as before. Parsing is a pure read-side function invoked during `rebuildIndex()`:

```typescript
// lib/wiki/meta-parser.ts
const OPEN = '<!-- WIKI-META -->'
const CLOSE = '<!-- /WIKI-META -->'

export interface MetaParseOutcome {
  body: string                           // page content with the meta block stripped
  sidecar: WikiPaperSidecar | null
  status: 'ok' | 'partial' | 'missing'
  droppedFields: string[]
  reason?: string
}

export function parsePaperPage(content: string, slug: string): MetaParseOutcome {
  const start = content.lastIndexOf(OPEN)
  const end = content.lastIndexOf(CLOSE)
  if (start < 0 || end < 0 || end < start) {
    return { body: content, sidecar: null, status: 'missing', droppedFields: [], reason: 'no-markers' }
  }

  const body = content.slice(0, start).trimEnd()

  // Extract the ```json ... ``` fence between markers
  const between = content.slice(start + OPEN.length, end)
  const fenceMatch = between.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (!fenceMatch) {
    return { body, sidecar: null, status: 'missing', droppedFields: [], reason: 'no-fence' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fenceMatch[1])
  } catch (e) {
    // One cheap repair shot before declaring missing: ask a fast model to
    // emit a valid version of the JSON. Handles trailing commas, unbalanced
    // quotes, accidental prose. One attempt only — no recursion, no loops.
    const repaired = await tryRepairJson(fenceMatch[1])
    if (repaired === null) {
      return { body, sidecar: null, status: 'missing', droppedFields: [], reason: 'unparseable' }
    }
    parsed = repaired
  }

  // Drop-don't-reject validation against WikiPaperSidecarV1
  const { sidecar, droppedFields } = validateAndCoerce(parsed, WikiPaperSidecarV1)
  if (!sidecar) {
    return { body, sidecar: null, status: 'missing', droppedFields, reason: 'schema-invalid' }
  }

  sidecar.slug = slug                           // anchor to the filename, overriding any LLM drift
  sidecar.generated_at ??= new Date().toISOString()

  return {
    body,
    sidecar,
    status: droppedFields.length > 0 ? 'partial' : 'ok',
    droppedFields,
  }
}
```

Key points:
- **Synchronous and offline.** Parsing has no LLM call, no network, no I/O beyond reading the `.md` file. It is safe to run as often as needed — e.g., on every index rebuild.
- **Markers survive mid-content breakage.** Finding `<!-- WIKI-META -->` by `lastIndexOf` is robust against the LLM accidentally mentioning the marker string earlier in the body.
- **Drop-don't-reject.** `validateAndCoerce` walks the parsed object field-by-field and omits ones that fail. A single bad `metrics[3].value` never kills the whole sidecar.
- **Two-tier repair, then the big hammer.** On `JSON.parse` failure, `tryRepairJson()` first runs a **free regex pass** that strips trailing commas before `]` / `}` — the single most common LLM JSON bug, validated in the RFC-005 mock. If the regex pass produces valid JSON, no LLM call is needed. Only when regex cannot fix the string do we fall through to **one** cheap-model LLM call ("here is broken JSON, return a valid version, nothing else") for less common failures (unbalanced quotes, stray prose, missing brackets). If the LLM repair also fails, the paper is marked `status: 'missing'` in `.state/sidecar_status.jsonl` and the repair pass (§6.4) re-runs the **full** generation prompt later. Three escalation levels, no recursion, hard bound on cost.
- **Evidence can fail locally.** If a high-risk entry parses but lacks valid `FieldEvidence`, the validator keeps the parent sidecar and drops the weak entry. One shaky metric does not contaminate the whole paper.
- **Body is always safe.** The function returns the `body` (everything before the opening marker) even when sidecar parsing fails, so every downstream tool can still render / score / search the prose.

### 6.3 Layer 3 — `wiki_*` tools never hard-depend on sidecar presence

Every tool has a graceful fallback path:

| Tool | If sidecar present | If sidecar missing |
|---|---|---|
| `wiki_search` | score over sidecar fields (tldr, concepts, aliases) + prose | score over prose only (current behavior) |
| `wiki_get` | return structured sections from sidecar, including evidence/trust metadata for high-risk fields | return parsed headings from Markdown |
| `wiki_coverage` | aggregate from `index/facets.json` (including trust-tier histograms) | count files under `papers/` + heading scan |
| `wiki_facets` | read `index/*.json` | return `{unavailable: true, reason: "no index"}` |
| `wiki_neighbors` | walk `graph.jsonl` | return `{unavailable: true}` |

The coordinator **never crashes** because a sidecar is missing. The worst case is that a query returns fewer / less-ranked results, which is exactly today's behavior. This means we can ship sidecar extraction disabled-by-default and incrementally enable it.

### 6.4 Layer 4 — Repair job + version bump

Two mechanisms keep the sidecar cache healthy over time:

1. **Repair pass.** On every wiki agent tick, before scanning for new papers, sweep `.state/sidecar_status.jsonl` for entries with `status: 'missing'` or `generator_version < current`. Attempt re-extraction, budget-limited (e.g., 5 per cycle). This lets a failed paper auto-retry without a user action.
2. **Sidecar generator version.** `SIDECAR_GENERATOR_VERSION` is bumped whenever the sidecar prompt or schema changes. Old sidecars are *not* deleted; they're marked stale and regenerated on the repair pass. The stale sidecar keeps serving reads until its replacement lands — zero downtime.

### 6.5 What "continues to work" means operationally

- **If the entire sidecar extraction feature is disabled**: same as today. `wiki_*` tools fall back to Markdown-only paths.
- **If one paper's sidecar extraction fails**: that paper's `.md` is still written. Other papers are unaffected. The failed one goes into the repair queue.
- **If the sidecar schema has a bug that rejects valid data**: extraction-status becomes `'partial'` across the board. Coordinator still reads what landed. Fix the schema, bump the version, repair sweep rebuilds clean sidecars.
- **If the `index/` directory is corrupted or deleted**: next `rebuildIndex()` rebuilds from scratch by re-parsing every `papers/*.md` (body + embedded meta block). No user data is lost; indices are pure derivations.
- **If a coordinator tool is called with filters the index doesn't support**: tool returns `{filters_applied: [...], filters_ignored: [...]}` — partial filtering is advertised, not silent.

**Survival discipline:** the Markdown page is load-bearing. Everything else is reconstructible. Delete freely, rebuild freely.

## 7. Keyword-First Retrieval — Answer to Captain Question #2

> "查询工具还是用关键字匹配，怎么提高 coverage 和查询的准确性？"

Substring search over whole files is the floor. We raise it with four purely-deterministic techniques, all built at write time. No embeddings, no external dependencies.

### 7.1 Technique A — Write-time BM25 index with field weights

Instead of scanning files at query time, the wiki agent maintains a BM25 index under `index/bm25.json`:

```typescript
// Schema: inverted index keyed by normalized token
interface BM25Index {
  version: 1
  num_docs: number
  avg_doc_len: number
  idf: Record<string, number>          // token → idf score
  postings: Record<string, Array<{
    slug: string
    field: 'title' | 'tldr' | 'contribution' | 'concept' | 'dataset' | 'method' | 'alias' | 'heading' | 'body'
    tf: number
  }>>
}
```

At write time, for each paper, tokenize every field and emit postings. Field weights applied at query time:

| Field | Weight |
|---|---|
| `title` | 10 |
| `tldr` | 8 |
| `contribution_oneliner` | 7 |
| `aliases` (paper or concept) | 7 |
| `dataset name` | 6 |
| `method_family` / `task` | 5 |
| concept page title | 5 |
| markdown heading | 3 |
| body prose | 1 |

Query-time scoring:
1. Tokenize query, normalize (lowercase, strip punct, simple stemming — English only for v1).
2. Expand via alias map (§7.2).
3. For each token, look up posting list, compute BM25 contribution weighted by field.
4. Sum per-doc scores. Return top-k with per-field hit breakdown.

This is ~150 lines of pure TS. No dependency beyond what we already have. It gives us:
- **Ranking** (not "any match / no match")
- **Field-aware matching** ("flash attention" in title vs. buried in a citation counts very differently)
- **Multi-term handling** ("flash attention LRA benchmark" no longer requires the exact substring to appear)

### 7.2 Technique B — Alias map (the single biggest coverage win)

Fragmentation is the #1 reason keyword search misses. "flash-attn" and "FlashAttention" live in different concept pages; "IO-aware attention" matches neither.

Three sources feed `index/aliases.json`:

1. **Paper sidecar `aliases[]`** — the LLM explicitly lists alternate names for the method this paper introduces. Example output for the FlashAttention paper:
   ```json
   "aliases": ["FlashAttention", "flash-attn", "IO-aware attention", "memory-efficient attention"]
   ```
2. **Concept sidecar `aliases[]`** — accumulated across papers; canonical slug is whichever existed first.
3. **Hand-curated additions** — optional `~/.research-pilot/paper-wiki/aliases.manual.json` users can edit.

Build process:
```typescript
// For every alias string found, emit: alias -> canonical_slug
// Conflict resolution: first-writer-wins (logged for user review)
{
  "flashattention": "flash-attention",
  "flash-attn": "flash-attention",
  "flash attn": "flash-attention",
  "io-aware attention": "flash-attention",
  ...
}
```

At query time: every token goes through the alias map. If `"flash-attn"` resolves to canonical `"flash-attention"`, both forms are added to the expanded query. The posting list lookups then find everything under the canonical slug automatically.

**Coverage delta example.** Query: `"flash attn"`
- Today (substring): zero hits unless a paper literally uses `"flash attn"`.
- After: alias expansion to `flash-attention`, BM25 match on paper titles, method_family, concept links. Returns all 8 relevant papers in the wiki.

### 7.3 Technique C — Facet filters on structured fields and trust

BM25 tells us "how well does this paper match this query". Facets tell us "which papers are even eligible". Combining them cuts false positives hard.

```typescript
wiki_search({
  query: "long-context attention efficiency",
  k: 10,
  filters: {
    year_gte: 2023,
    datasets: ["LRA", "PG19"],     // any-of
    concepts: ["flash-attention"], // all-of
    has_code: true,
    source_tier: "fulltext",       // only papers we fully ingested
    trust_tier: "fulltext-grounded"
  }
})
```

Implementation: each filter maps to a pre-built index under `index/`:
- `by-year.json` → set intersection
- `by-concept.json` → set intersection (all-of) or union (any-of)
- `by-dataset.json` → same
- `by-trust-tier.json` → set intersection
- `has_code` → bitmap built at index time from parsed meta blocks (cheap, cached)

Filters apply **before** BM25, shrinking the candidate set. This is how we get "high precision on a specific question" without sacrificing recall on broad queries — the agent chooses how much to constrain.

### 7.4 Technique D — Query-time coverage signal + empty-query logging

Every `wiki_search` result includes:

```typescript
{
  hits: [...],
  coverage: {
    total_candidates_before_filters: 412,
    candidates_after_filters: 18,
    matched: 6,
    top_facet_context: {
      years: { "2023": 4, "2024": 2 },
      concepts: { "flash-attention": 5, "retrieval": 1 },
      trust_tiers: { "fulltext-grounded": 3, "fulltext-unverified": 2, "abstract-grounded": 1 },
    },
    alias_expansions_used: ["flash-attn → flash-attention"],
    suggested_refinements: [
      "Try concept filter 'memory-efficient-attention' (12 papers)",
      "Drop year_gte to include 2022 foundational work (3 more papers)"
    ]
  }
}
```

This turns each search into a *conversation* about what the wiki knows. The coordinator can act on `coverage`:

- **`matched === 0`**: log query to `index/query_log.jsonl`. The wiki agent periodically inspects this log and reports "these 14 query terms are consistently missing" to the user — a data-driven signal for which concepts need alias additions or which topics need external literature search to fill.
- **`matched < 3 and total_candidates_before_filters < 20`**: wiki is *thin* on this topic. Coordinator should run external literature search.
- **`matched >= 5`**: wiki is rich. Coordinator should read-before-search.
- **Rich but low-trust**: if results cluster in `abstract-grounded` or `fulltext-unverified`, the wiki is good enough to map the area but not necessarily good enough to support strong result comparisons or citation-heavy prose.

A separate `wiki_coverage(topic?)` tool exposes the global view (no query, just facet distribution) so the coordinator can decide upfront, before even issuing a query, whether the wiki is worth consulting.

### 7.5 Summary of accuracy and coverage gains

| Failure mode today | Fix |
|---|---|
| `"FlashAttention"` and `"flash-attn"` miss each other | Alias map (§7.2) |
| Query buried in a citation ranks equal to title hit | BM25 field weights (§7.1) |
| Multi-term queries fail if substring not contiguous | Token-based BM25 (§7.1) |
| No way to restrict to recent / with-code / on-specific-dataset | Facet filters (§7.3) |
| Agent doesn't know whether to trust the wiki | Coverage signal + `wiki_coverage` (§7.4) |
| `fulltext` papers with noisy conversion look too authoritative | Separate `trust_tier` + field evidence (§4.3, §7.3) |
| Wiki never learns what queries it's failing | `query_log.jsonl` (§7.4) |

Everything above is code, not ML. Every piece is inspectable as a flat JSON file. Embeddings stay out of scope for v1.

## 8. Tool Surface (replaces `wiki_lookup`)

### 8.1 `wiki_search`

```typescript
{
  name: 'wiki_search',
  description: 'Hybrid keyword search over the global paper wiki with BM25 ranking, alias expansion, and facet filters. Always call this before external literature search when the topic might already be in the wiki. Returns hits plus a coverage signal describing how thin or rich the wiki is on this topic.',
  parameters: Type.Object({
    query: Type.String(),
    k: Type.Optional(Type.Number({ default: 10, maximum: 30 })),
    filters: Type.Optional(Type.Object({
      year_gte: Type.Optional(Type.Number()),
      year_lte: Type.Optional(Type.Number()),
      datasets: Type.Optional(Type.Array(Type.String())),
      concepts: Type.Optional(Type.Array(Type.String())),
      method_family: Type.Optional(Type.Array(Type.String())),
      has_code: Type.Optional(Type.Boolean()),
      source_tier: Type.Optional(Type.Union([
        Type.Literal('fulltext'),
        Type.Literal('abstract-only'),
        Type.Literal('abstract-fallback'),
      ])),
      trust_tier: Type.Optional(Type.Union([
        Type.Literal('metadata-only'),
        Type.Literal('abstract-grounded'),
        Type.Literal('fulltext-unverified'),
        Type.Literal('fulltext-grounded'),
      ])),
    }))
  })
}
```

Returns `{ hits: [{slug, title, tldr, score, matched_fields}], coverage: {...} }`.

### 8.2 `wiki_get`

```typescript
{
  name: 'wiki_get',
  description: 'Read a paper or concept page from the wiki. Prefer requesting specific sections to avoid dumping the full page into context.',
  parameters: Type.Object({
    slug: Type.String(),
    sections: Type.Optional(Type.Array(Type.Union([
      Type.Literal('tldr'),
      Type.Literal('contributions'),
      Type.Literal('methodology'),
      Type.Literal('results'),
      Type.Literal('limitations'),
      Type.Literal('citation_snippet'),
      Type.Literal('known_unknowns'),
      Type.Literal('unsafe_to_assume'),
      Type.Literal('evidence'),
      Type.Literal('qa_pairs'),
      Type.Literal('full'),
    ])))
  })
}
```

When sidecar is present, sections are served from it (fast, structured) and high-risk fields carry `trust_tier` / `FieldEvidence` metadata. When missing, sections are parsed from the Markdown headings.

### 8.3 `wiki_coverage`

```typescript
{
  name: 'wiki_coverage',
  description: "Check what the wiki knows about a topic before deciding whether to run an external literature search. Returns paper counts by facet, top concepts, and a thin/rich verdict. Call this at the start of a research task.",
  parameters: Type.Object({
    topic: Type.Optional(Type.String()),
  })
}
```

With no `topic`: returns global facet summary. With `topic`: runs an internal `wiki_search` and summarizes the distribution (e.g., "412 papers total; 18 match 'long context', clustered in 2023–2024, top concepts: flash-attention, ring-attention, trust split: 6 grounded / 8 unverified / 4 abstract").

### 8.4 `wiki_facets`

```typescript
{
  name: 'wiki_facets',
  description: 'Enumerate the top values of a given facet across the wiki. Useful for discovering what concepts/datasets/methods exist before forming a search query.',
  parameters: Type.Object({
    facet: Type.Union([
      Type.Literal('datasets'),
      Type.Literal('concepts'),
      Type.Literal('method_family'),
      Type.Literal('year'),
      Type.Literal('task'),
      Type.Literal('trust_tier'),
    ]),
    limit: Type.Optional(Type.Number({ default: 30 })),
  })
}
```

### 8.5 `wiki_neighbors`

```typescript
{
  name: 'wiki_neighbors',
  description: 'Graph traversal: find papers or concepts related to a given slug via typed edges (shared concepts, baseline comparisons, cited prior work).',
  parameters: Type.Object({
    slug: Type.String(),
    relation: Type.Optional(Type.Union([
      Type.Literal('shares_concept'),
      Type.Literal('baseline_of'),
      Type.Literal('prior_work'),
      Type.Literal('ablated_by'),
      Type.Literal('all'),
    ])),
    depth: Type.Optional(Type.Number({ default: 1, maximum: 2 })),
  })
}
```

### 8.6 Deprecation of `wiki_lookup`

`wiki_lookup` stays registered for one release as a thin shim that dispatches to `wiki_search` (when `page` param omitted) or `wiki_get` (when `page` provided). Prompt updates to the coordinator point at the new tools. Remove `wiki_lookup` after one release cycle.

## 9. Coordinator Integration

Add a brief coverage preamble to the coordinator system prompt, injected dynamically at session start:

```
WIKI COVERAGE SNAPSHOT (as of <timestamp>):
- 412 papers total (289 fulltext, 123 abstract-only)
- trust tiers: 173 fulltext-grounded, 116 fulltext-unverified, 123 abstract-grounded
- 89 concepts, strongest coverage: attention (42), retrieval (31), quantization (19), long-context (15)
- Known thin areas: molecular dynamics, formal verification

Before running external literature search, call wiki_coverage(topic) to check whether
the wiki already has useful material. Prefer wiki_search with facet filters when you
know the dataset/method/year you care about.
```

This is built from `index/facets.json` in one call — cheap, always fresh. It's what makes the wiki proactively used instead of passively queryable.

### 9.1 Coordinator Decision Rules

The coordinator should use the upgraded wiki in three passes:

1. **Map** — call `wiki_coverage(topic)` and `wiki_search(...)` to learn whether the wiki is rich or thin on the topic, and which concepts / datasets / years dominate.
2. **Ground** — call `wiki_get(slug, sections)` for targeted reads. Use `trust_tier` and `FieldEvidence` to decide whether a fact is strong enough to repeat directly.
3. **Gap-check** — if the answer depends on quantitative comparisons, limitations, or graph relations and the available evidence is mostly `abstract-grounded` or `fulltext-unverified`, escalate to external literature search or original-paper reading instead of over-claiming.

Operationally:

- `abstract-grounded` is good for topic maps, query expansion, representative-paper selection, and broad related-work framing.
- `fulltext-unverified` is good for navigation and tentative summaries, but not for high-confidence result tables unless the specific field evidence is explicit and medium+ confidence.
- `fulltext-grounded` is the default threshold for strong comparison claims, citation-heavy drafting, or “paper A beats paper B on metric X” style answers.
- `known_unknowns` and `unsafe_to_assume` should be surfaced to the coordinator, not hidden. They are the mechanism that keeps the agent from treating the wiki as a truth oracle.

## 10. Implementation Plan

Phased rollout, each phase independently shippable and independently valuable.

### Phase 1 — Sidecar pipeline (no retrieval changes)
1. Add `lib/wiki/sidecar-schema.ts` with TypeBox schema, including `trust_tier`, `parse_quality`, `FieldEvidence`, and abstention fields.
2. Append the meta-block addendum (§5.2) to both `wiki-paper-fulltext` and `wiki-paper-abstract` in `lib/agents/prompts/index.ts`. No new prompt key. Bump `GENERATOR_VERSION` so older pages are flagged stale.
3. Add `lib/wiki/meta-parser.ts` with `parsePaperPage()` (drop-don't-reject validator, no LLM call).
4. **No change** to `processPaper()` control flow or to `generatePaperPage()`: the LLM response already contains the meta block, and `safeWriteFile` continues to write the full response verbatim.
5. On every scan cycle, after writing a paper, run `parsePaperPage()` on its content to classify the outcome and append a line to `.state/sidecar_status.jsonl` (`ok` / `partial` / `missing` + reason).
6. Repair pass at start of each tick: sweep `.state/sidecar_status.jsonl` for `missing` entries and entries whose `generator_version` is stale; enqueue up to 5 per cycle for full regeneration (re-runs the Markdown prompt, which naturally refreshes both body and meta block).
7. **Observable outcome:** newly processed `papers/<slug>.md` files gain trailing `<!-- WIKI-META -->` blocks. Existing pages remain usable as body-only until the repair pass catches them. Coordinator still uses `wiki_lookup`; nothing downstream changes.

### Phase 2 — Indices
1. Add `lib/wiki/indexer.ts` — for every `papers/*.md`, call `parsePaperPage()` to split body + sidecar, then build `bm25.json`, `aliases.json`, `by-*.json`, `graph.jsonl`, `facets.json`. Papers with no sidecar fall through to body-only indexing.
2. Call `rebuildIndex()` at the end of each `processSinglePass()` (scoped, only touches indices if any paper was written that cycle).
3. Concept meta blocks generated deterministically during indexing (no LLM call), but only from medium+ confidence non-synthesized concept edges. Indexer rewrites the `<!-- WIKI-META -->` block at the end of each `concepts/<slug>.md` without touching the body.
4. **Observable outcome:** `index/` populated. Coordinator still unchanged. User can inspect files for sanity.

### Phase 3 — New tools
1. Implement `wiki_search`, `wiki_get`, `wiki_coverage`, `wiki_facets`, `wiki_neighbors` in `lib/wiki/tools/`.
2. Each tool has a "sidecar absent" fallback path so it works against a Phase-0 wiki too.
3. Register new tools in `lib/tools/index.ts`.
4. Keep `wiki_lookup` as a shim for one release.
5. Update coordinator system prompt with coverage snapshot injection + trust-aware decision rules.
6. **Observable outcome:** coordinator uses new tools, quality improves.

### Phase 4 — Feedback loop (optional)
1. `query_log.jsonl` write path inside `wiki_search`.
2. Periodic "missing topic" report surfaced in the Settings → Wiki tab.
3. Access counts per paper; stale-cold-page repair priority adjustment.

Each phase can be reverted independently. Phase 1 alone is already useful (sidecar extraction builds the dataset; existing tools ignore it).

## 11. Open Questions

Resolved during the §5 rewrite — **not** tracked here: (a) per-paper LLM cost doubling (eliminated by single-call design), (b) alias conflict resolution strategy (first-writer-wins; the actual winner doesn't affect resolution because both forms still map into the same canonical group).

1. **Survey papers and sidecars.** Surveys often list 100+ datasets and dozens of methods. Should we cap sidecar list lengths? Proposed: soft cap of 20 items per list, prompt asks for "the most representative" when over.
2. **Embeddings as Phase 5.** Once BM25 + aliases + facets are in place, adding a `tldr` embedding column for semantic reranking is ~200 lines with `@xenova/transformers` or similar. Explicitly deferred — prove the keyword stack first.
3. **Backfill.** Existing papers in the wiki have no meta blocks. Do we bulk-backfill on upgrade, or let the repair pass slowly catch up? Proposed: repair pass only (cheap, unobtrusive, caps LLM spend). A manual "backfill now" button in Settings is a later addition.
4. **Concept page Markdown regeneration.** Currently concept page bodies append per-paper sections via HTML comment markers. When sidecars change concept edges (e.g., relation type flips from `uses` to `advances`), do we rewrite the body? Proposed: rewrite only when the paper set changes, not on every tick. The trailing meta block is rewritten more aggressively since it is cheap and deterministic.
5. **Concurrency with the existing single-writer lock.** Indices and concept meta blocks are written inside the same `withWikiLock()` as paper pages, so there is no lock contention — but `rebuildIndex()` is O(N) in paper count. Above ~5k papers we may need incremental index updates. Not a v1 concern.
6. **Numeric result verification.** Table extraction from converted Markdown is fragile. Proposed: in v1, keep metrics only when a plausible local `FieldEvidence` span exists; otherwise omit or mark low confidence and avoid `fulltext-grounded`. A dedicated table/figure verifier is explicitly deferred.
7. **Body/meta drift during repair.** The repair pass regenerates the full page, which means the body can change between revisions even when nothing factual has. Proposed: accept this — the body is a derived summary, not the paper itself, and repair is rare. If user-visible churn becomes annoying, add a "body hash" check and only rewrite the file when the body actually changes.

## 12. What This Is Not

- **Not a vector database.** No embeddings. No ANN. Pure inverted indices and JSON files.
- **Not a new storage backend.** Everything is still files under `~/.research-pilot/paper-wiki/`.
- **Not a schema validator for artifacts.** The sidecar describes wiki pages, not the original `PaperArtifact` — those remain per-project and untouched.
- **Not a required dependency.** Every phase degrades gracefully. Deleting `index/` or stripping every `<!-- WIKI-META -->` block leaves the coordinator in its current working state.
- **Not a replacement for external literature search.** The wiki's job is to tell the coordinator *when the external search is unnecessary*, not to replace it.
- **Not a fact oracle.** Even with sidecars, the coordinator is expected to respect `trust_tier`, `FieldEvidence`, and `unsafe_to_assume` rather than treating every extracted field as equally reliable.
