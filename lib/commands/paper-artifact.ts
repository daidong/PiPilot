import { type CLIContext, type Literature } from '../types.js'
import { findExistingPaperArtifact } from '../memory-v2/store.js'
import { artifactCreate, artifactUpdate } from './artifact.js'

export interface UpsertPaperResult {
  success: boolean
  paper?: Literature
  filePath?: string
  error?: string
  /**
   * True when the upsert hit an existing paper via dedup and merged into it
   * (regardless of whether any field actually changed). False when a new
   * paper artifact was created. Undefined only on failure.
   *
   * RFC-006 §0, Q4 — importers report this in their per-entry summary.
   */
  wasDeduped?: boolean
}

function generateCiteKey(authors: string[] | undefined, year?: number): string {
  const firstAuthor = authors?.[0]?.split(/\s+/).pop()?.toLowerCase() ?? 'unknown'
  return `${firstAuthor}${year ?? 'nd'}`
}

function buildFallbackBibtex(params: {
  citeKey: string
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  url?: string
}): string {
  const authorText = params.authors.length > 0 ? params.authors.join(' and ') : 'Unknown'
  return [
    `@article{${params.citeKey},`,
    `  title = {${params.title}},`,
    `  author = {${authorText}},`,
    ...(params.year ? [`  year = {${params.year}},`] : []),
    ...(params.venue ? [`  journal = {${params.venue}},`] : []),
    ...(params.doi ? [`  doi = {${params.doi}},`] : []),
    ...(params.url ? [`  url = {${params.url}},`] : []),
    '}'
  ].join('\n')
}

// ─── Fill-only merge predicates (RFC-006 §0) ─────────────────────────────
//
// These predicates classify the *existing* paper's field as "missing or
// placeholder" so the upsert path knows when it's safe to write a new
// value in. Without these checks, the dedup-update branch silently
// downgraded real DOIs to `unknown:*`, full author lists to single
// authors, and curated titles to filename-derived strings.

function isMissingString(v: string | undefined | null): boolean {
  return !v || v.trim() === ''
}

function isPlaceholderDoi(doi: string | undefined | null): boolean {
  return !doi || doi.startsWith('unknown:')
}

function isUnknownAuthors(authors: string[]): boolean {
  if (!authors || authors.length === 0) return true
  if (authors.length === 1) {
    const a = authors[0]?.trim().toLowerCase()
    return a === 'unknown' || a === '' || a === undefined
  }
  return false
}

const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 } as const
function shouldUpgradeConfidence(
  existing: 'high' | 'medium' | 'low' | undefined,
  incoming: 'high' | 'medium' | 'low' | undefined
): boolean {
  if (!incoming) return false
  if (!existing) return true
  return CONFIDENCE_ORDER[incoming] > CONFIDENCE_ORDER[existing]
}

export function upsertPaperArtifact(
  title: string,
  opts: {
    authors?: string[]
    year?: number
    abstract?: string
    venue?: string
    url?: string
    citeKey?: string
    tags?: string[]
    searchKeywords?: string[]
    externalSource?: string
    relevanceScore?: number
    citationCount?: number
    doi?: string
    bibtex?: string
    pdfUrl?: string
    // Literature study fields
    subTopic?: string
    keyFindings?: string[]
    relevanceJustification?: string
    addedInRound?: string
    addedByTask?: string
    fulltextPath?: string
    identityConfidence?: 'high' | 'medium' | 'low'
    arxivId?: string
    pubmedId?: string
    pmcId?: string
    semanticScholarId?: string
  },
  context: CLIContext
): UpsertPaperResult {
  if (!title) return { success: false, error: 'Paper title is required.' }

  const authors = opts.authors && opts.authors.length > 0 ? opts.authors : ['Unknown']
  const citeKey = opts.citeKey ?? generateCiteKey(authors, opts.year)
  const doi = (opts.doi ?? '').trim() || `unknown:${citeKey}`
  const callerProvidedBibtex = typeof opts.bibtex === 'string' && opts.bibtex.trim().length > 0
  const bibtex = callerProvidedBibtex
    ? opts.bibtex!
    : buildFallbackBibtex({
        citeKey,
        title,
        authors,
        year: opts.year,
        venue: opts.venue,
        doi,
        url: opts.url
      })

  const dedup = findExistingPaperArtifact(context.projectPath, {
    doi,
    citeKey,
    title,
    year: opts.year
  })

  if (dedup) {
    // Fill-only merge — only write a field when the existing value is
    // missing, empty, or a recognized placeholder. Anything the user (or
    // a prior write path) has populated is preserved, including across
    // re-imports of stale data. See RFC-006 §0 for the bug this fixes.
    const patch: Record<string, unknown> = {}

    if (isMissingString(dedup.title)) patch.title = title

    if (isUnknownAuthors(dedup.authors) && !isUnknownAuthors(authors)) {
      patch.authors = authors
    }

    if (isMissingString(dedup.abstract) && !isMissingString(opts.abstract)) {
      patch.abstract = opts.abstract
    }

    if (dedup.year == null && opts.year != null) patch.year = opts.year

    if (isMissingString(dedup.venue) && !isMissingString(opts.venue)) {
      patch.venue = opts.venue
    }

    if (isMissingString(dedup.url) && !isMissingString(opts.url)) {
      patch.url = opts.url
    }

    if (isMissingString(dedup.pdfUrl) && !isMissingString(opts.pdfUrl)) {
      patch.pdfUrl = opts.pdfUrl
    }

    // citeKey is identity — never overwrite on dedup.

    // DOI: only fill when existing is missing or `unknown:*` placeholder
    // AND incoming is a real (non-placeholder) DOI. The old code blindly
    // overwrote real DOIs with `unknown:<citeKey>` when the caller didn't
    // provide one — that was the headline bug.
    if (isPlaceholderDoi(dedup.doi) && !isPlaceholderDoi(doi)) {
      patch.doi = doi
    }

    // bibtex: overwrite only when (a) the existing entry was auto-generated
    // (treat undefined as auto-generated for legacy artifacts) AND (b) the
    // caller actually supplied a curated bibtex. Per RFC-006 Q7=(c).
    const existingBibtexIsAuto = dedup.bibtexIsAutoGenerated !== false
    if (existingBibtexIsAuto && callerProvidedBibtex) {
      patch.bibtex = bibtex
      patch.bibtexIsAutoGenerated = false
    } else if (isMissingString(dedup.bibtex)) {
      // Defensive: existing bibtex is empty for some reason.
      patch.bibtex = bibtex
      patch.bibtexIsAutoGenerated = !callerProvidedBibtex
    }

    if (!dedup.searchKeywords?.length && opts.searchKeywords?.length) {
      patch.searchKeywords = opts.searchKeywords
    }

    if (isMissingString(dedup.externalSource) && !isMissingString(opts.externalSource)) {
      patch.externalSource = opts.externalSource
    }

    if (dedup.relevanceScore == null && opts.relevanceScore != null) {
      patch.relevanceScore = opts.relevanceScore
    }

    if (dedup.citationCount == null && opts.citationCount != null) {
      patch.citationCount = opts.citationCount
    }

    if (shouldUpgradeConfidence(dedup.identityConfidence, opts.identityConfidence)) {
      patch.identityConfidence = opts.identityConfidence
    }

    if (isMissingString(dedup.arxivId) && !isMissingString(opts.arxivId)) {
      patch.arxivId = opts.arxivId
    }
    if (isMissingString(dedup.pubmedId) && !isMissingString(opts.pubmedId)) {
      patch.pubmedId = opts.pubmedId
    }
    if (isMissingString(dedup.pmcId) && !isMissingString(opts.pmcId)) {
      patch.pmcId = opts.pmcId
    }
    if (isMissingString(dedup.semanticScholarId) && !isMissingString(opts.semanticScholarId)) {
      patch.semanticScholarId = opts.semanticScholarId
    }

    if (isMissingString(dedup.subTopic) && !isMissingString(opts.subTopic)) {
      patch.subTopic = opts.subTopic
    }
    if (!dedup.keyFindings?.length && opts.keyFindings?.length) {
      patch.keyFindings = opts.keyFindings
    }
    if (isMissingString(dedup.relevanceJustification) && !isMissingString(opts.relevanceJustification)) {
      patch.relevanceJustification = opts.relevanceJustification
    }
    if (isMissingString(dedup.addedInRound) && !isMissingString(opts.addedInRound)) {
      patch.addedInRound = opts.addedInRound
    }
    if (isMissingString(dedup.addedByTask) && !isMissingString(opts.addedByTask)) {
      patch.addedByTask = opts.addedByTask
    }
    if (isMissingString(dedup.fulltextPath) && !isMissingString(opts.fulltextPath)) {
      patch.fulltextPath = opts.fulltextPath
    }

    // tags: union (no field is "more authoritative" — combining is safe)
    if (opts.tags && opts.tags.length > 0) {
      const existing = dedup.tags ?? []
      const seen = new Set(existing)
      const additions = opts.tags.filter(t => !seen.has(t))
      if (additions.length > 0) patch.tags = [...existing, ...additions]
    }

    // Empty patch → no-op write. Still report wasDeduped so callers can
    // distinguish "merged with no change" from "created new".
    if (Object.keys(patch).length === 0) {
      return {
        success: true,
        paper: dedup,
        wasDeduped: true
      }
    }

    const updated = artifactUpdate(context.projectPath, dedup.id, patch)

    if (!updated.success || !updated.artifact || updated.artifact.type !== 'paper') {
      return { success: false, error: 'Failed to update existing paper.' }
    }

    return {
      success: true,
      paper: updated.artifact,
      filePath: updated.filePath,
      wasDeduped: true
    }
  }

  const created = artifactCreate({
    type: 'paper',
    title,
    authors,
    abstract: opts.abstract ?? '',
    year: opts.year,
    venue: opts.venue,
    url: opts.url,
    citeKey,
    doi,
    bibtex,
    bibtexIsAutoGenerated: !callerProvidedBibtex,
    pdfUrl: opts.pdfUrl,
    tags: opts.tags ?? [],
    searchKeywords: opts.searchKeywords,
    externalSource: opts.externalSource,
    relevanceScore: opts.relevanceScore,
    citationCount: opts.citationCount,
    subTopic: opts.subTopic,
    keyFindings: opts.keyFindings,
    relevanceJustification: opts.relevanceJustification,
    addedInRound: opts.addedInRound,
    addedByTask: opts.addedByTask,
    fulltextPath: opts.fulltextPath,
    identityConfidence: opts.identityConfidence,
    arxivId: opts.arxivId,
    pubmedId: opts.pubmedId,
    pmcId: opts.pmcId,
    semanticScholarId: opts.semanticScholarId,
    provenance: {
      source: opts.externalSource ? 'agent' : 'user',
      sessionId: context.sessionId,
      agentId: opts.externalSource ? 'literature-team' : undefined,
      extractedFrom: opts.externalSource ? 'agent-response' : 'user-input'
    }
  }, context)

  if (!created.success || !created.artifact || created.artifact.type !== 'paper') {
    return { success: false, error: 'Failed to create paper artifact.' }
  }

  return {
    success: true,
    paper: created.artifact,
    filePath: created.filePath,
    wasDeduped: false
  }
}

export function updatePaperMetadata(
  existing: Literature,
  enriched: {
    authors?: string[]
    year?: number
    abstract?: string
    venue?: string
    url?: string
    citationCount?: number
    doi?: string
    bibtex?: string
    pdfUrl?: string
    enrichmentSource?: string
    enrichedAt?: string
  },
  context: CLIContext
): UpsertPaperResult {
  const update: Record<string, unknown> = {}

  if ((!existing.abstract || existing.abstract === '') && enriched.abstract) update.abstract = enriched.abstract
  if ((!existing.venue) && enriched.venue) update.venue = enriched.venue
  if ((!existing.year) && enriched.year) update.year = enriched.year
  if ((!existing.url) && enriched.url) update.url = enriched.url
  if ((!existing.doi || existing.doi.startsWith('unknown:')) && enriched.doi) update.doi = enriched.doi
  if ((!existing.citationCount) && enriched.citationCount) update.citationCount = enriched.citationCount
  if ((!existing.bibtex || existing.bibtex.trim().length === 0) && enriched.bibtex) update.bibtex = enriched.bibtex
  if ((!existing.pdfUrl) && enriched.pdfUrl) update.pdfUrl = enriched.pdfUrl
  if (enriched.authors && enriched.authors.length > 0 && (existing.authors.length === 0 || (existing.authors.length === 1 && existing.authors[0] === 'Unknown'))) {
    update.authors = enriched.authors
  }
  if (enriched.enrichmentSource) update.enrichmentSource = enriched.enrichmentSource
  if (enriched.enrichedAt) update.enrichedAt = enriched.enrichedAt

  if (Object.keys(update).length === 0) {
    return { success: true, paper: existing }
  }

  const updated = artifactUpdate(context.projectPath, existing.id, update)
  if (!updated.success || !updated.artifact || updated.artifact.type !== 'paper') {
    return { success: false, error: `Failed to update paper: ${existing.id}` }
  }

  return {
    success: true,
    paper: updated.artifact,
    filePath: updated.filePath
  }
}
