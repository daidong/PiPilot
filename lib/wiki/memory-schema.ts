/**
 * Wiki Memory Schema — RFC-005 V3.
 *
 * Structured retrieval sidecar embedded at the end of each paper memory page
 * as a <!-- WIKI-META --> JSON block. See lib/docs/rfc/005-wiki-sidecar-and-retrieval.md.
 *
 * Epistemic position (§4.3 / §7):
 *   The sidecar AND the Markdown page body are both WIKI MEMORY — derived
 *   summaries, not source evidence. Wrong values cost a wasted read, never a
 *   wrong cited claim. For exact numbers, direct quotes, or careful cross-paper
 *   comparisons, the coordinator escalates to the underlying paper artifact
 *   via the wiki_source tool, not by reading meta:* or page:* sections.
 */

import { Type, type Static } from '@sinclair/typebox'

export const WIKI_MEMORY_SCHEMA_VERSION = 3

// ── Closed enums (LLM selects from these) ──────────────────────────────────

export const PaperType = Type.Union([
  Type.Literal('method'),     // proposes a new approach / algorithm / procedure / tool / compound
  Type.Literal('empirical'),  // measurement / observation / experiment; no major new method
  Type.Literal('review'),     // survey / systematic review / meta-analysis
  Type.Literal('resource'),   // introduces a dataset / benchmark / library / corpus / materials set
  Type.Literal('theory'),     // proof / derivation / formal analysis
  Type.Literal('position'),   // opinion / commentary / perspective / roadmap
])

export const SourceTier = Type.Union([
  Type.Literal('metadata-only'),
  Type.Literal('abstract-only'),
  Type.Literal('fulltext'),
])

export const ParseQuality = Type.Union([
  Type.Literal('clean'),
  Type.Literal('noisy'),
  Type.Literal('unknown'),
])

export const DatasetRole = Type.Union([
  Type.Literal('used'),         // training / input / substrate / observed subject
  Type.Literal('introduced'),   // first released / constructed by this paper
  Type.Literal('compared_to'),  // used as a control or reference
])

export const ConceptRelation = Type.Union([
  Type.Literal('introduces'),
  Type.Literal('uses'),
  Type.Literal('advances'),
  Type.Literal('critiques'),
])

// ── Sub-schemas ────────────────────────────────────────────────────────────

export const DatasetEntry = Type.Object({
  name: Type.String(),
  alias: Type.Optional(Type.String()),
  role: Type.Optional(DatasetRole),
  section: Type.Optional(Type.String()),
})
export type DatasetEntry = Static<typeof DatasetEntry>

export const FindingEntry = Type.Object({
  statement: Type.String(),                // full-sentence paraphrase — BM25 primary field
  value: Type.Optional(Type.String()),     // "78.2%", "3.1×", "−4.2 eV"; string to preserve formatting
  context: Type.Optional(Type.String()),   // dataset / cohort / substrate / simulation config
  comparison: Type.Optional(Type.String()),
  section: Type.Optional(Type.String()),
})
export type FindingEntry = Static<typeof FindingEntry>

export const BaselineRef = Type.Object({
  name: Type.String(),
  canonicalKey: Type.Optional(Type.String()),
  section: Type.Optional(Type.String()),
})
export type BaselineRef = Static<typeof BaselineRef>

export const ConceptEdge = Type.Object({
  slug: Type.String(),
  relation: ConceptRelation,
  section: Type.Optional(Type.String()),
})
export type ConceptEdge = Static<typeof ConceptEdge>

export const DescriptiveText = Type.Object({
  text: Type.String(),
  section: Type.Optional(Type.String()),
})
export type DescriptiveText = Static<typeof DescriptiveText>

export const ProjectLens = Type.Object({
  project_path: Type.String(),
  question: Type.Optional(Type.String()),        // what research question this paper was used for
  why_it_mattered: Type.Optional(Type.String()), // project-local relevance justification
  subtopic: Type.Optional(Type.String()),
  added_at: Type.String(),                       // ISO timestamp
})
export type ProjectLens = Static<typeof ProjectLens>

// ── Top-level sidecar ──────────────────────────────────────────────────────

export const WikiPaperMemoryMetaV3 = Type.Object({
  // provenance (code- or LLM-echo assigned)
  schemaVersion: Type.Literal(3),
  canonicalKey: Type.String(),
  slug: Type.String(),
  generated_at: Type.String(),
  generator_version: Type.Number(),
  source_tier: SourceTier,
  parse_quality: Type.Optional(ParseQuality),
  paper_type: PaperType,

  // retrieval preview
  tldr: Type.Optional(Type.String()),

  // cross-discipline free-form classification
  task: Type.Optional(Type.Array(Type.String())),
  methods: Type.Optional(Type.Array(Type.String())),

  // retrieval-oriented content
  datasets: Type.Optional(Type.Array(DatasetEntry)),
  findings: Type.Optional(Type.Array(FindingEntry)),
  baselines: Type.Optional(Type.Array(BaselineRef)),
  code_url: Type.Optional(Type.String()),
  data_url: Type.Optional(Type.String()),
  concept_edges: Type.Optional(Type.Array(ConceptEdge)),
  aliases: Type.Optional(Type.Array(Type.String())),

  // descriptive transcription
  limitations: Type.Optional(Type.Array(DescriptiveText)),
  negative_results: Type.Optional(Type.Array(DescriptiveText)),

  // cross-project accumulation (§6.2.1)
  provenance_projects: Type.Optional(Type.Array(Type.String())),
  project_lenses: Type.Optional(Type.Array(ProjectLens)),
})

export type WikiPaperMemoryMeta = Static<typeof WikiPaperMemoryMetaV3>

// ── Concept memory sidecar ─────────────────────────────────────────────────

export const WikiConceptMemoryMetaV3 = Type.Object({
  schemaVersion: Type.Literal(3),
  slug: Type.String(),
  name: Type.String(),
  aliases: Type.Array(Type.String()),
  parent_concept: Type.Optional(Type.String()),
  related_concepts: Type.Array(Type.String()),
  papers: Type.Array(Type.Object({
    slug: Type.String(),
    relation: ConceptRelation,
    added_at: Type.String(),
  })),
  generated_at: Type.String(),
  generator_version: Type.Number(),
})
export type WikiConceptMemoryMeta = Static<typeof WikiConceptMemoryMetaV3>
