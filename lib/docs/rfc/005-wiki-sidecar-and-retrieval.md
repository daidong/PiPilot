# RFC-005: Wiki as Cumulative Research Memory & Keyword-First Retrieval

**Status:** Proposed
**Author:** Captain + Claude
**Date:** 2026-04-12
**Extends:** RFC-003 (Global Paper Wiki)

## 1. Motivation

RFC-003 introduced a global paper wiki: one Markdown page per paper plus concept pages, shared across projects. That solved one important problem: knowledge no longer had to stay trapped inside a single project directory.

But the original framing still pushed the wiki toward the wrong role. It implicitly treated the wiki as if it might become:

- a quasi-complete literature catalog
- a stable fact cache
- a citation-safe source of exact claims

That is not realistic.

The wiki will always be:

- **incomplete**: it only contains papers that entered our workflow
- **derived**: pages and summaries are LLM-written, not the paper itself
- **noisy at the source boundary**: abstract-only papers exist; PDF -> Markdown conversion can be imperfect
- **perspectival**: the same paper matters differently in different projects

Those are not bugs. They are the natural properties of a research memory system.

The real problem the wiki should solve is different:

- prevent the agent from forgetting what prior projects already learned
- accumulate understanding of the same paper across multiple projects and questions
- preserve useful concept structure and query vocabulary over time
- help the agent decide what to read next, what to revisit, and when fresh literature study is still necessary

This RFC repositions the wiki accordingly.

## 2. Design Philosophy

> The wiki is a cumulative research memory and navigation layer.
> It is not the literature itself, and it is not ground truth.

That single sentence should govern every design decision.

### 2.1 What The Wiki Is

The wiki is a place to accumulate:

- what papers we have already seen
- what we thought they were about
- which concepts and datasets seemed central
- why they mattered in a given project
- what remains uncertain or worth revisiting

This is closer to a lab notebook or shared research memory than to an encyclopedia.

### 2.2 What The Wiki Is Not

The wiki is not:

- a complete field survey
- a fact oracle
- a citation-safe database
- a replacement for reading papers
- a replacement for external literature search

The coordinator must never confuse "the wiki knows something about this topic" with "the field is covered" or "the fact is settled."

### 2.3 Memory Before Truth

A research memory system does **not** fail because it is incomplete.
It fails if it hides its incompleteness.

Likewise, it does **not** fail because a summary is imperfect.
It fails if summaries are allowed to masquerade as source evidence.

The governing rule is:

> **Summaries may guide. Source materials justify.**

The wiki helps the coordinator orient itself. When precision matters, the coordinator escalates to the underlying paper artifacts and, when needed, to fresh literature search.

### 2.4 Preserve Multiple Lenses

One paper can matter for multiple reasons:

- as a method precedent in project A
- as a benchmark reference in project B
- as a critique target in project C

The wiki should accumulate those perspectives rather than overwrite them with one supposedly canonical interpretation.

### 2.5 Local Memory Coverage, Not Field Coverage

`wiki_coverage` and related tools should be understood as answering:

- "How much does **our local memory** know about this topic?"

not:

- "How well is this topic covered in the literature?"

This distinction is essential. Otherwise the coordinator will suppress literature search for the wrong reasons.

### 2.6 Deterministic Retrieval, Honest Epistemics

The retrieval layer should be deterministic, inspectable, and cheap:

- keyword/BM25 search
- alias normalization
- facet filters
- typed graph edges where helpful

The epistemic layer should be honest and minimal:

- source availability should be explicit
- incompleteness should be explicit
- exactness should not be claimed where it cannot be guaranteed

We should avoid fake certainty theater. But we should still preserve enough provenance to know what kind of memory object we are looking at.

## 3. Goals

This RFC aims to make the wiki better at four things.

### 3.1 Accumulation

Knowledge from one project should remain available to later projects.

### 3.2 Orientation

The coordinator should quickly learn:

- have we seen this topic before?
- which papers are nearby?
- which concepts, datasets, and methods recur?

### 3.3 Attention Routing

The wiki should help decide:

- which papers to read first
- which known papers to revisit
- when the local memory is thin enough that new literature search is necessary

### 3.4 Perspective Preservation

The same paper should be able to accumulate multiple project-specific interpretations over time.

## 4. Architecture Overview

The architecture is easiest to reason about as three layers.

### 4.1 Source Layer

This layer contains the closest thing to evidence:

- metadata
- abstract
- original project paper artifact
- converted fulltext, when available
- cached PDF, when available

This layer may still be imperfect, especially converted text, but it is the nearest available representation of the paper itself.

### 4.2 Memory Layer

This is the wiki:

- paper memory pages
- structured sidecar/meta blocks for retrieval
- concept pages
- project lenses attached to papers
- derived indices for keyword search and navigation

Everything in this layer is derived. Its purpose is reuse and navigation.

### 4.3 Decision Layer

This is the coordinator's runtime behavior:

- use the wiki to orient and shortlist
- use project lenses to recover prior perspectives
- use source artifacts when exact claims matter
- use fresh literature search when local memory is thin or the task requires broader coverage

The success criterion is not "the wiki answers everything." It is "the coordinator no longer starts from zero every time."

## 5. Storage Model

The storage form is not the key philosophical decision. The important thing is the separation of roles:

- a **human-readable memory page**
- a **machine-oriented retrieval sidecar**
- **derived indices**

Terminology in this RFC:

- **memory sidecar** = the logical structured retrieval object
- **meta block** = the storage form when that memory sidecar is embedded at the end of a Markdown page

For concreteness, this RFC assumes an embedded meta block at the end of each Markdown page:

```
papers/<slug>.md
  - human-readable page body
  - trailing <!-- WIKI-META --> ... <!-- /WIKI-META --> JSON block
```

But a sibling JSON file would be equally acceptable. The design does not depend on one representation versus the other.

Directory layout:

```
~/.research-pilot/paper-wiki/
├── papers/
│   └── <slug>.md
├── concepts/
│   └── <slug>.md
├── index/
│   ├── bm25.json
│   ├── aliases.json
│   ├── by-dataset.json
│   ├── by-concept.json
│   ├── by-year.json
│   ├── by-paper-type.json
│   ├── graph.jsonl
│   ├── facets.json
│   └── query_log.jsonl
└── .state/
    └── sidecar_status.jsonl
```

Everything under `index/` is fully derivable and may be rebuilt freely.

## 6. Memory Objects

The wiki should store three kinds of memory objects.

### 6.1 Paper Memory Page

The page body is for humans:

- short summary
- key contributions
- method/approach sketch
- results/limitations if known
- links to concept pages

This page is still a derived memory artifact. It is not the paper itself.

Body depth scales with `source_tier`:

- `fulltext`: can support a fuller summary page
- `abstract-only`: should stay high-level and concise
- `metadata-only`: may be no more than title, basic metadata, and a brief note that richer source text was unavailable

### 6.2 Structured Paper Sidecar

The sidecar is for retrieval, filtering, and navigation.

A sketch of the schema:

```typescript
import { Type, type Static } from '@sinclair/typebox'

export const WIKI_MEMORY_SCHEMA_VERSION = 3

export const PaperType = Type.Union([
  Type.Literal('method'),
  Type.Literal('empirical'),
  Type.Literal('review'),
  Type.Literal('resource'),
  Type.Literal('theory'),
  Type.Literal('position'),
])

export const ProjectLens = Type.Object({
  project_path: Type.String(),
  question: Type.Optional(Type.String()),        // what question/project this paper was used for
  why_it_mattered: Type.Optional(Type.String()), // project-local relevance
  subtopic: Type.Optional(Type.String()),
  added_at: Type.String(),
})

export const DatasetEntry = Type.Object({
  name: Type.String(),
  alias: Type.Optional(Type.String()),
  role: Type.Optional(Type.Union([
    Type.Literal('used'),
    Type.Literal('introduced'),
    Type.Literal('compared_to'),
  ])),
  section: Type.Optional(Type.String()),
})

export const FindingEntry = Type.Object({
  statement: Type.String(),               // paraphrased retrieval-friendly finding
  value: Type.Optional(Type.String()),    // optional; do not force exactness
  context: Type.Optional(Type.String()),
  comparison: Type.Optional(Type.String()),
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

export const WikiPaperMemoryMetaV3 = Type.Object({
  schemaVersion: Type.Literal(3),
  canonicalKey: Type.String(),
  slug: Type.String(),
  generated_at: Type.String(),
  generator_version: Type.Number(),
  source_tier: Type.Union([
    Type.Literal('metadata-only'),
    Type.Literal('abstract-only'),
    Type.Literal('fulltext'),
  ]),
  parse_quality: Type.Optional(Type.Union([
    Type.Literal('clean'),
    Type.Literal('noisy'),
    Type.Literal('unknown'),
  ])),
  paper_type: PaperType,

  tldr: Type.Optional(Type.String()),
  task: Type.Optional(Type.Array(Type.String())),
  methods: Type.Optional(Type.Array(Type.String())),
  datasets: Type.Optional(Type.Array(DatasetEntry)),
  findings: Type.Optional(Type.Array(FindingEntry)),
  baselines: Type.Optional(Type.Array(Type.Object({
    name: Type.String(),
    canonicalKey: Type.Optional(Type.String()),
    section: Type.Optional(Type.String()),
  }))),
  code_url: Type.Optional(Type.String()),
  data_url: Type.Optional(Type.String()),
  concept_edges: Type.Optional(Type.Array(ConceptEdge)),
  aliases: Type.Optional(Type.Array(Type.String())),
  limitations: Type.Optional(Type.Array(DescriptiveText)),
  negative_results: Type.Optional(Type.Array(DescriptiveText)),

  provenance_projects: Type.Optional(Type.Array(Type.String())),
  project_lenses: Type.Optional(Type.Array(ProjectLens)),
})

export type WikiPaperMemoryMeta = Static<typeof WikiPaperMemoryMetaV3>
```

Important design choices:

- the sidecar stores **memory-oriented summaries**, not authoritative facts
- `source_tier` survives because it is useful and code-assignable
- `parse_quality` is a navigation hint, not a truth score
- there is no fake "trust tier" or per-field confidence theater
- `project_lenses` are first-class, because preserving perspective is part of the point

### 6.2.1 Lens Write Path

`project_lenses` are auto-derived in v1. The coordinator does not manually append them.

On each scan, for every `(canonical paper, project_path)` pair not yet represented in `project_lenses`, the wiki agent derives one lens from the triggering project's `PaperArtifact`:

- `project_path` <- scan source project
- `why_it_mattered` <- `PaperArtifact.relevanceJustification` when present
- `subtopic` <- `PaperArtifact.subTopic` when present
- `question` <- optional project/question context when a stable question string is available; otherwise omitted
- `added_at` <- scan time

V1 idempotency rule:

- key: `project_path`
- if the same paper is seen again from the same project, update the existing lens rather than append a duplicate
- if the same paper is seen from a new project, append a new lens

This keeps lens accumulation automatic, cheap, and stable while preserving the central idea: one global paper memory object can carry multiple project-local reasons for mattering.

### 6.3 Concept Pages

Concept pages remain useful, but their role is also memory-first:

- aggregate nearby papers
- collect aliases
- preserve a rough map of the topic
- link representative work

They do not need to pretend to be canonical ontologies.

## 7. Core Epistemic Position

This RFC adopts the following separation:

### 7.1 The Wiki Is Memory, Not Evidence

Both the page body and the sidecar are wiki memory artifacts.

They are optimized differently:

- page body: readable for humans
- sidecar: structured for retrieval

But they share the same epistemic status:

- both are derived
- both may be imperfect
- neither should be treated as direct ground truth

### 7.2 Source Materials Justify Exact Claims

If the coordinator needs:

- an exact number
- a direct quote
- a careful cross-paper comparison
- an exhaustive claim about the field

the wiki alone is not enough.

The coordinator must go back to:

- the underlying paper artifact
- converted fulltext if available
- the PDF or original source when needed
- fresh literature search when coverage matters

### 7.2.1 Source Escalation Path

"Go back to source" must be an explicit system path, not a vague instruction.

This RFC therefore requires a dedicated source-location tool:

### `wiki_source`

Purpose:

- bridge from a wiki slug to the closest available source-layer artifacts

Suggested return shape:

```json
{
  "project_artifacts": [
    {
      "project_path": "projects/foo",
      "artifact_id": "paper_123",
      "path": ".research-pilot/artifacts/papers/paper_123.md"
    }
  ],
  "cached_fulltext": "~/.research-pilot/paper-wiki/converted/<slug>.md",
  "cached_pdf": "~/.research-pilot/paper-wiki/raw/arxiv/<id>.pdf",
  "canonical_external": {
    "doi": "10....",
    "arxiv_url": "https://arxiv.org/abs/..."
  }
}
```

Design rules:

- return **all** known project artifact locations for the paper, newest-first when a useful ordering exists
- do not silently choose one project as "the" source when multiple project artifacts exist
- if a path is stale or missing on disk, omit it and report that it was unavailable
- converted fulltext and cached PDF count as **source-layer caches**: they are still derived/acquired assets, but they are materially closer to the paper than wiki memory objects and are therefore the right escalation target

Without this bridge, "escalate to source" will degrade in practice to "quote the wiki because it is nearby." This tool exists to prevent that failure mode.

### 7.3 Coverage Means Local Memory Density

When the wiki says a topic is "rich" or "thin", it means:

- rich/thin in **our local accumulated memory**

It does **not** mean:

- rich/thin in the actual literature

This is why external literature search remains first-class. The wiki is a complement, not a replacement.

### 7.4 Preserve Project Lenses Instead Of Erasing Them

If the same paper appears in multiple projects, the system should:

- keep one canonical paper page
- merge deterministic metadata
- append new `project_lenses`

This preserves accumulated intelligence without pretending there is one final, context-free interpretation.

V1 merge default:

- the shared paper page body is a cross-project summary
- new lenses do **not** trigger a body rewrite on their own
- lenses accumulate independently in the memory sidecar
- the body is regenerated only when the canonical paper memory itself is stale enough to justify regeneration, such as a generator/schema version bump or a true semantic refresh of the canonical paper record

## 8. Prompt Guidance

The prompt should be shaped around the wiki's real role.

### 8.1 What The LLM Should Do

- summarize
- normalize aliases
- extract named entities from provided text
- classify into a small closed `paper_type` enum
- produce retrieval-friendly paraphrases
- preserve project-local relevance when known

### 8.2 What The LLM Should Not Be Asked To Do

- claim that a field is citation-safe
- self-assess exact confidence
- certify completeness
- decide whether a topic is fully covered by the field

### 8.3 Prompt-Level Rules

The generation prompts should enforce:

- do not invent named entities, URLs, or exact numeric values with no grounding
- approximate paraphrase is acceptable for retrieval
- exact quotation is not the wiki's job
- abstract-only inputs should stay high-level and sparse
- when a paper is re-seen in another project, preserve the shared page body and update/append project lenses rather than overwrite the paper's entire memory identity

## 9. Retrieval Model

The retrieval layer remains deterministic and keyword-first.

### 9.1 BM25 With Field Weights

Use write-time indexing over:

- title
- tldr
- findings statements
- aliases
- dataset names
- methods
- headings
- body prose

This gives ranking and field-aware matching without embeddings.

### 9.2 Alias Map

Alias normalization is still one of the highest-leverage improvements:

- sidecar aliases
- concept aliases
- optional manual alias file

This improves coverage far more cheaply than semantic search.

### 9.3 Facet Filters

Facet filters help narrow the search:

- year
- concept
- dataset
- method
- paper_type
- source_tier
- has_code

These should be understood as navigation aids, not trust judgments.

### 9.4 Coverage Signal

Every search should return a coverage block that answers:

- how many matching memory objects exist locally
- what concepts/datasets/paper types dominate
- whether the local memory is thin enough to justify fresh literature search

The language should be explicit:

- "local memory is dense"
- "local memory is thin"

not:

- "the field is covered"

### 9.5 Query Logging

Log empty or low-yield queries. This lets the wiki improve over time by showing:

- missing aliases
- topics not yet accumulated
- parts of the user's work that still depend heavily on external search

## 10. Tool Surface

The old `wiki_lookup` should be replaced by narrower tools.

### 10.1 `wiki_search`

Purpose:

- retrieve candidate papers/concepts from local memory
- provide preview text
- expose local-memory coverage

It should return:

- `slug`
- `title`
- `tldr`
- `paper_type`
- matched fields
- coverage summary
- project-lens count or a short lens preview when useful

It should **not** be framed as returning citable facts.

### 10.2 `wiki_get`

Purpose:

- read a paper or concept memory object in a targeted way

Suggested section namespaces:

- `page:*` for human-readable page sections
- `meta:*` for structured memory fields
- `lenses` for accumulated project-specific interpretations

Both `page:*` and `meta:*` are memory views. Neither is source evidence.

The split still matters:

- `page:*` is prose, useful when the coordinator needs context, narrative flow, or the original hedging language of the memory page
- `meta:*` is structured, useful when the coordinator needs one field for ranking, filtering, or quick inspection

This is a **data-shape distinction**, not a trust distinction.

### 10.3 `wiki_coverage`

Purpose:

- answer what the local memory knows about a topic

It should be used before external literature search, but only to decide:

- whether we are starting from zero
- whether we already have a useful shortlist

not to declare the field sufficiently covered.

### 10.4 `wiki_facets`

Purpose:

- help discover the vocabulary already present in memory

Useful facets:

- datasets
- concepts
- methods
- year
- task
- paper_type
- source_tier

### 10.5 `wiki_neighbors`

Purpose:

- traverse nearby papers through concept edges and shared structure

Its role is exploratory. Spurious edges are tolerable if they merely create one wasted exploration step.

### 10.6 `wiki_source`

Purpose:

- map a wiki paper slug to the closest available source-layer artifacts

It should return:

- all known project artifact locations for that paper
- cached converted fulltext when available
- cached PDF when available
- canonical external references such as DOI or arXiv URL when available

This is the coordinator's bridge from memory-layer orientation to source-layer verification.

## 11. Coordinator Integration

The coordinator should be explicitly taught the wiki's epistemic role.

### 11.1 Prompt Preamble

Inject a lightweight summary such as:

```
WIKI MEMORY SNAPSHOT (as of <timestamp>):
- 412 papers in local memory
- paper types: 247 method / 98 empirical / 42 review / ...
- strongest concept clusters: attention, retrieval, quantization, long-context
- known thin areas in local memory: molecular dynamics, formal verification

Use the wiki as a cumulative research memory and navigation layer.
It is not a complete literature catalog and not a fact oracle.
Use it to orient, shortlist, and recover prior project context.
When exact claims or broader coverage matter, go back to source artifacts and fresh literature search.
```

### 11.2 Coordinator Decision Rules

The decision rules should be simple.

1. **Start with memory**
   - Check `wiki_coverage(topic)`
   - Run `wiki_search(...)`
   - Recover prior project lenses if the topic or paper has been seen before

2. **Use memory to orient**
   - shortlist papers
   - expand query vocabulary
   - identify obvious concept neighborhoods
   - avoid redoing the same initial triage from scratch

3. **Escalate when precision matters**
   - exact results
   - direct quotes
   - delicate cross-paper comparisons
   - exhaustive claims
   - use `wiki_source(slug)` to get the actual source-layer paths rather than treating wiki memory as the nearest available authority

4. **Escalate when completeness matters**
   - if local memory is thin
   - if the task is a real literature review
   - if the topic is likely broader than the accumulated wiki

### 11.3 The Intended Win

The intended win is not:

- "the agent answers from the wiki alone"

It is:

- "the agent no longer forgets prior work and no longer starts every research task from zero"

## 12. Resilience Strategy

The resilience strategy remains important, but its purpose is simpler under this philosophy.

### 12.1 Load-Bearing Invariant

The paper page body is load-bearing for human readability.
The sidecar and indices are caches for navigation and retrieval.

If they fail:

- the page still exists
- the memory is still readable
- the coordinator degrades to slower, weaker retrieval

### 12.2 Sparse Is Normal

Abstract-only papers, theory papers, position pieces, and poorly converted PDFs should all produce valid sparse memory objects.

Omission is normal.

### 12.3 Wrong Memory Is Bounded

A wrong sidecar field should at worst cause:

- a wasted read
- an imperfect ranking
- a noisy graph traversal

The design must avoid letting sidecar values silently stand in for exact evidence.

### 12.4 Rebuildability

Indices remain fully derivable and disposable.

This keeps the system inspectable and easy to recover when schemas evolve.

## 13. Rollout Plan

The rollout can remain phased.

### Phase 1 — Memory Sidecar

- add the memory sidecar/meta block
- keep the schema intentionally sparse
- include `project_lenses`
- record parse status in `.state/sidecar_status.jsonl`
- derive/update `project_lenses` automatically during scan, idempotent by `project_path`
- treat existing RFC-003 pages as valid **body-only memory** during bootstrap; there is no retroactive lens backfill requirement for v1

### Phase 2 — Indices

- build BM25
- build alias map
- build facet indices
- build concept graph

### Phase 3 — New Tools

- add `wiki_search`
- add `wiki_get`
- add `wiki_coverage`
- add `wiki_facets`
- add `wiki_neighbors`
- add `wiki_source`
- keep `wiki_lookup` as a compatibility shim temporarily

### Phase 4 — Feedback Loop

- log empty queries
- surface thin local-memory areas
- prioritize backfill and repair for high-value cold spots

## 14. Open Questions

1. **How much structure should `project_lenses` have?**
   A very free-form lens is flexible but harder to facet. A very rigid lens is easier to query but may not capture real project-specific perspective.

2. **Should concept pages also accumulate project lenses, or should lenses remain paper-attached only?**
   Paper-attached is simpler. Concept-level lenses may be useful later if repeated project patterns emerge.

3. **Should v2 allow manual lens append in addition to auto-derived lenses?**
   V1 is auto-only. A later manual path may be useful when the coordinator learns something more specific than the original `relevanceJustification`.

4. **How much converted fulltext should be surfaced into the wiki workflow?**
   Enough to improve navigation, but not in a way that encourages the coordinator to treat converted text as guaranteed-clean evidence.

5. **How should repair/backfill be prioritized?**
   By recency, by access frequency, by topic thinness, or by user demand.

## 15. What This Is Not

- **Not a vector database.** No embeddings are required in v1.
- **Not a complete literature graph.** It only knows what entered our workflows.
- **Not a new storage backend.** Everything remains file-based and rebuildable.
- **Not a citation-safe knowledge base.** Wiki memory guides reading; source materials justify exact claims.
- **Not a replacement for literature search.** It reduces repeated work and preserves context; it does not remove the need to search the field.
- **Not a single canonical interpretation engine.** Different project lenses are expected and valuable.
