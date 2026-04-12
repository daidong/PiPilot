/**
 * Wiki Meta Parser — synchronous, offline parser for the <!-- WIKI-META -->
 * JSON block embedded at the end of each paper memory page.
 *
 * Contract (RFC-005 §6.2):
 *   - body is always returned, even when meta block is missing or malformed
 *   - drop-don't-reject validation: bad fields are omitted, not rejected
 *   - required top-level fields missing → sidecar=null, body still usable
 *   - never calls out to LLM (the repair shot is a regex pass only)
 *
 * Philosophy (RFC-005 §4.3 / §7):
 *   Sidecar is a retrieval cache. The body is the human-facing memory.
 *   Neither is ground truth — the source-layer artifacts are.
 */

import type {
  WikiPaperMemoryMeta,
  DatasetEntry,
  FindingEntry,
  BaselineRef,
  ConceptEdge,
  DescriptiveText,
  ProjectLens,
} from './memory-schema.js'

export const WIKI_META_OPEN = '<!-- WIKI-META -->'
export const WIKI_META_CLOSE = '<!-- /WIKI-META -->'

export type ParseStatus = 'ok' | 'partial' | 'missing'

export interface MetaParseOutcome {
  /** Page content with the meta block stripped (always present). */
  body: string
  /** Parsed sidecar, or null if the meta block was absent / unparseable / schema-invalid. */
  sidecar: WikiPaperMemoryMeta | null
  status: ParseStatus
  /** Field paths that were dropped by drop-don't-reject validation. */
  droppedFields: string[]
  /** Short reason string when status !== 'ok'. */
  reason?: string
  /** True when the regex repair pass was needed to parse the JSON. */
  repairUsed?: boolean
}

// ── Enum sets (kept in sync with memory-schema.ts) ─────────────────────────

const PAPER_TYPES = new Set(['method', 'empirical', 'review', 'resource', 'theory', 'position'])
const SOURCE_TIERS = new Set(['metadata-only', 'abstract-only', 'fulltext'])
const PARSE_QUALITIES = new Set(['clean', 'noisy', 'unknown'])
const DATASET_ROLES = new Set(['used', 'introduced', 'compared_to'])
const CONCEPT_RELATIONS = new Set(['introduces', 'uses', 'advances', 'critiques'])

// ── Helpers ────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr)

/**
 * Cheap JSON repair: strip trailing commas before `]` or `}`.
 * Validated in the mock — handles the most common LLM JSON bug without an LLM call.
 * Returns the repaired string if it parses, otherwise null.
 */
export function tryRepairJson(raw: string): string | null {
  const repaired = raw.replace(/,(\s*[\]}])/g, '$1')
  try {
    JSON.parse(repaired)
    return repaired
  } catch {
    // Production: a second tier would fall through to a cheap LLM call here.
    // V1 stops at the regex pass.
    return null
  }
}

// ── Drop-don't-reject validator ────────────────────────────────────────────

interface ValidateResult {
  sidecar: WikiPaperMemoryMeta | null
  droppedFields: string[]
}

/**
 * Field-by-field validator. A single bad entry is dropped, not propagated.
 * Only the top-level provenance + reliability header is required.
 */
export function validateAndCoerce(parsed: unknown): ValidateResult {
  const dropped: string[] = []

  if (!isObj(parsed)) {
    return { sidecar: null, droppedFields: ['<root-not-object>'] }
  }

  // ── Required header ──
  const schemaVersion = parsed.schemaVersion
  if (schemaVersion !== 3) {
    return { sidecar: null, droppedFields: [`<invalid-schemaVersion:${String(schemaVersion)}>`] }
  }
  if (!isStr(parsed.canonicalKey)) return { sidecar: null, droppedFields: ['<missing-canonicalKey>'] }
  if (!isStr(parsed.slug)) return { sidecar: null, droppedFields: ['<missing-slug>'] }
  if (!isStr(parsed.generated_at)) return { sidecar: null, droppedFields: ['<missing-generated_at>'] }
  if (!isNum(parsed.generator_version)) {
    return { sidecar: null, droppedFields: ['<missing-generator_version>'] }
  }
  if (!isStr(parsed.source_tier) || !SOURCE_TIERS.has(parsed.source_tier)) {
    return { sidecar: null, droppedFields: [`<invalid-source_tier:${String(parsed.source_tier)}>`] }
  }
  if (!isStr(parsed.paper_type) || !PAPER_TYPES.has(parsed.paper_type)) {
    return { sidecar: null, droppedFields: [`<invalid-paper_type:${String(parsed.paper_type)}>`] }
  }

  const out: WikiPaperMemoryMeta = {
    schemaVersion: 3,
    canonicalKey: parsed.canonicalKey,
    slug: parsed.slug,
    generated_at: parsed.generated_at,
    generator_version: parsed.generator_version,
    source_tier: parsed.source_tier as WikiPaperMemoryMeta['source_tier'],
    paper_type: parsed.paper_type as WikiPaperMemoryMeta['paper_type'],
  }

  // parse_quality is optional — accept only if valid enum, otherwise drop
  if ('parse_quality' in parsed) {
    const pq = parsed.parse_quality
    if (isStr(pq) && PARSE_QUALITIES.has(pq)) {
      out.parse_quality = pq as WikiPaperMemoryMeta['parse_quality']
    } else {
      dropped.push('parse_quality')
    }
  }

  // ── Optional strings ──
  for (const key of ['tldr', 'code_url', 'data_url'] as const) {
    if (key in parsed) {
      if (isStr(parsed[key])) (out as Record<string, unknown>)[key] = parsed[key]
      else dropped.push(key)
    }
  }

  // ── Optional string arrays ──
  for (const key of ['task', 'methods', 'aliases', 'provenance_projects'] as const) {
    if (key in parsed) {
      if (isStringArray(parsed[key])) (out as Record<string, unknown>)[key] = parsed[key]
      else dropped.push(key)
    }
  }

  // ── Object arrays (element-level drop) ──
  if ('datasets' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.datasets, 'datasets', validateDatasetEntry)
    out.datasets = kept as DatasetEntry[]
    dropped.push(...d)
  }
  if ('findings' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.findings, 'findings', validateFindingEntry)
    out.findings = kept as FindingEntry[]
    dropped.push(...d)
  }
  if ('baselines' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.baselines, 'baselines', validateBaselineRef)
    out.baselines = kept as BaselineRef[]
    dropped.push(...d)
  }
  if ('concept_edges' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.concept_edges, 'concept_edges', validateConceptEdge)
    out.concept_edges = kept as ConceptEdge[]
    dropped.push(...d)
  }
  if ('limitations' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.limitations, 'limitations', validateDescriptiveText)
    out.limitations = kept as DescriptiveText[]
    dropped.push(...d)
  }
  if ('negative_results' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.negative_results, 'negative_results', validateDescriptiveText)
    out.negative_results = kept as DescriptiveText[]
    dropped.push(...d)
  }
  if ('project_lenses' in parsed) {
    const { kept, dropped: d } = filterArray(parsed.project_lenses, 'project_lenses', validateProjectLens)
    out.project_lenses = kept as ProjectLens[]
    dropped.push(...d)
  }

  return { sidecar: out, droppedFields: dropped }
}

type ElementValidator<T> = (elem: unknown) => { value: T; dropped: string[] } | null

interface FilterResult {
  kept: unknown[]
  dropped: string[]
}

function filterArray<T>(
  raw: unknown,
  fieldName: string,
  validate: ElementValidator<T>,
): FilterResult {
  if (!Array.isArray(raw)) {
    return { kept: [], dropped: [fieldName] }
  }
  const kept: unknown[] = []
  const dropped: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const result = validate(raw[i])
    if (!result) {
      dropped.push(`${fieldName}[${i}]`)
      continue
    }
    kept.push(result.value)
    for (const d of result.dropped) dropped.push(`${fieldName}[${i}].${d}`)
  }
  return { kept, dropped }
}

function validateDatasetEntry(elem: unknown): { value: DatasetEntry; dropped: string[] } | null {
  if (!isObj(elem) || !isStr(elem.name)) return null
  const value: DatasetEntry = { name: elem.name }
  const dropped: string[] = []
  if ('alias' in elem) {
    if (isStr(elem.alias)) value.alias = elem.alias
    else dropped.push('alias')
  }
  if ('role' in elem) {
    if (isStr(elem.role) && DATASET_ROLES.has(elem.role)) {
      value.role = elem.role as DatasetEntry['role']
    } else {
      dropped.push('role')
    }
  }
  if ('section' in elem) {
    if (isStr(elem.section)) value.section = elem.section
    else dropped.push('section')
  }
  return { value, dropped }
}

function validateFindingEntry(elem: unknown): { value: FindingEntry; dropped: string[] } | null {
  if (!isObj(elem) || !isStr(elem.statement)) return null
  const value: FindingEntry = { statement: elem.statement }
  const dropped: string[] = []
  for (const key of ['value', 'context', 'comparison', 'section'] as const) {
    if (key in elem) {
      if (isStr(elem[key])) (value as Record<string, unknown>)[key] = elem[key]
      else dropped.push(key)
    }
  }
  return { value, dropped }
}

function validateBaselineRef(elem: unknown): { value: BaselineRef; dropped: string[] } | null {
  if (!isObj(elem) || !isStr(elem.name)) return null
  const value: BaselineRef = { name: elem.name }
  const dropped: string[] = []
  for (const key of ['canonicalKey', 'section'] as const) {
    if (key in elem) {
      if (isStr(elem[key])) (value as Record<string, unknown>)[key] = elem[key]
      else dropped.push(key)
    }
  }
  return { value, dropped }
}

function validateConceptEdge(elem: unknown): { value: ConceptEdge; dropped: string[] } | null {
  if (!isObj(elem)) return null
  if (!isStr(elem.slug)) return null
  if (!isStr(elem.relation) || !CONCEPT_RELATIONS.has(elem.relation)) return null
  const value: ConceptEdge = {
    slug: elem.slug,
    relation: elem.relation as ConceptEdge['relation'],
  }
  const dropped: string[] = []
  if ('section' in elem) {
    if (isStr(elem.section)) value.section = elem.section
    else dropped.push('section')
  }
  return { value, dropped }
}

function validateDescriptiveText(elem: unknown): { value: DescriptiveText; dropped: string[] } | null {
  if (!isObj(elem) || !isStr(elem.text)) return null
  const value: DescriptiveText = { text: elem.text }
  const dropped: string[] = []
  if ('section' in elem) {
    if (isStr(elem.section)) value.section = elem.section
    else dropped.push('section')
  }
  return { value, dropped }
}

function validateProjectLens(elem: unknown): { value: ProjectLens; dropped: string[] } | null {
  if (!isObj(elem)) return null
  if (!isStr(elem.project_path)) return null
  if (!isStr(elem.added_at)) return null
  const value: ProjectLens = {
    project_path: elem.project_path,
    added_at: elem.added_at,
  }
  const dropped: string[] = []
  for (const key of ['question', 'why_it_mattered', 'subtopic'] as const) {
    if (key in elem) {
      if (isStr(elem[key])) (value as Record<string, unknown>)[key] = elem[key]
      else dropped.push(key)
    }
  }
  return { value, dropped }
}

// ── Top-level parser ───────────────────────────────────────────────────────

/**
 * Parse a paper memory page into body + sidecar.
 *
 * Invariant: `body` is always returned. If anything goes wrong with the meta
 * block, `body` is the content before the opening marker (or the entire file
 * if no marker is found). Downstream tools can always render / score / search
 * body prose regardless of sidecar state.
 */
export function parsePaperPage(content: string, slug: string): MetaParseOutcome {
  const start = content.lastIndexOf(WIKI_META_OPEN)
  const end = content.lastIndexOf(WIKI_META_CLOSE)

  if (start < 0 || end < 0 || end < start) {
    return { body: content, sidecar: null, status: 'missing', droppedFields: [], reason: 'no-markers' }
  }

  const body = content.slice(0, start).trimEnd()
  const between = content.slice(start + WIKI_META_OPEN.length, end)
  const fenceMatch = between.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (!fenceMatch) {
    return { body, sidecar: null, status: 'missing', droppedFields: [], reason: 'no-fence' }
  }

  let parsed: unknown
  let repairUsed = false
  const jsonStr = fenceMatch[1]
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    const repaired = tryRepairJson(jsonStr)
    if (repaired === null) {
      return { body, sidecar: null, status: 'missing', droppedFields: [], reason: 'unparseable' }
    }
    parsed = JSON.parse(repaired)
    repairUsed = true
  }

  const { sidecar, droppedFields } = validateAndCoerce(parsed)
  if (!sidecar) {
    return { body, sidecar: null, status: 'missing', droppedFields, reason: 'schema-invalid' }
  }

  // Anchor the slug to the filename — overrides any LLM drift.
  sidecar.slug = slug

  return {
    body,
    sidecar,
    status: droppedFields.length > 0 ? 'partial' : 'ok',
    droppedFields,
    repairUsed,
  }
}

// ── Meta block writer ──────────────────────────────────────────────────────

/**
 * Serialize a sidecar into the canonical <!-- WIKI-META --> block form.
 * Used when the indexer needs to rewrite the meta block of an existing page
 * (e.g., to merge a new project lens) without regenerating the body.
 */
export function serializeMetaBlock(sidecar: WikiPaperMemoryMeta): string {
  const json = JSON.stringify(sidecar, null, 2)
  return `${WIKI_META_OPEN}\n\`\`\`json\n${json}\n\`\`\`\n${WIKI_META_CLOSE}\n`
}

/**
 * Given a page's current content and a new sidecar, return the full page
 * content with the meta block replaced (or appended if none exists). The
 * body before the opening marker is preserved verbatim.
 */
export function writeMetaBlockInto(content: string, sidecar: WikiPaperMemoryMeta): string {
  const start = content.lastIndexOf(WIKI_META_OPEN)
  const end = content.lastIndexOf(WIKI_META_CLOSE)

  const metaBlock = serializeMetaBlock(sidecar)

  if (start >= 0 && end > start) {
    const body = content.slice(0, start).trimEnd()
    return `${body}\n\n${metaBlock}`
  }
  // No existing meta block — append to the end of the body
  return `${content.trimEnd()}\n\n${metaBlock}`
}
