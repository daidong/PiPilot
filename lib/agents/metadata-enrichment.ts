/**
 * Metadata Enrichment Module (RFC-008)
 *
 * Non-LLM metadata enrichment for papers from academic search APIs.
 * Fills missing DOI, abstract, venue, citationCount, etc. by querying
 * Crossref and Semantic Scholar after the initial search and dedup step.
 */

import { RateLimiter, CircuitBreaker } from './rate-limiter.js'

// ============================================================================
// Types
// ============================================================================

export interface EnrichedPaper {
  // Identifiers
  ids: {
    doi?: string
    arxivId?: string
    dblpKey?: string
    openalexId?: string
    s2PaperId?: string
  }

  // Bibliographic
  title: string
  authors: string[]
  year?: number
  venue?: string
  volume?: string
  pages?: string

  // Links
  doiUrl?: string
  url?: string
  pdfUrl?: string

  // Content
  abstract?: string
  citationCount?: number

  // Provenance
  enrichmentSource?: string
  enrichedAt?: string
}

export interface EnrichmentConfig {
  maxTimeMs: number
  maxPapersToEnrich: number
  cache: Map<string, Partial<EnrichedPaper>>
  rateLimiter: RateLimiter
  circuitBreaker: CircuitBreaker
  crossrefMailto?: string
  semanticScholarApiKey?: string
}

export interface EnrichmentStats {
  enriched: number
  skipped: number
  failed: number
}

/** Minimal paper interface expected as input */
export interface PaperInput {
  title: string
  authors?: string[]
  year?: number
  venue?: string | null
  abstract?: string
  doi?: string | null
  citationCount?: number | null
  url?: string
  pdfUrl?: string | null
  source?: string
  // Allow enrichment to add fields
  [key: string]: unknown
}

// Core fields we track for completeness
const CORE_FIELDS: (keyof PaperInput)[] = ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'citationCount']

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize a DOI: lowercase, strip URL prefix.
 */
export function normalizeDOI(doi: string): string {
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim()
}

/**
 * Normalize a title for matching: NFC, lowercase, strip punctuation.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract family names from author strings for matching.
 */
export function extractFamilyNames(authors: string[]): string[] {
  return authors.map(a => {
    const parts = a.includes(',') ? a.split(',')[0] : a.split(' ').pop() || a
    return parts.toLowerCase().trim()
  })
}

/**
 * Generate a cache key for a paper.
 */
export function cacheKey(paper: PaperInput): string {
  if (paper.doi) return `doi:${normalizeDOI(paper.doi)}`
  const titleHash = normalizeTitle(paper.title)
  const firstAuthor = paper.authors?.[0]
    ? extractFamilyNames([paper.authors[0]])[0]
    : ''
  return `title:${titleHash}:${firstAuthor}`
}

/**
 * Count how many core fields are present.
 *
 * `doi` is treated as MISSING when its value starts with `unknown:` —
 * that prefix is the placeholder `upsertPaperArtifact` writes when no
 * real DOI is available (lib/commands/paper-artifact.ts:75). Without
 * this rule the enrichment pipeline silently skips papers whose only
 * "DOI" is a placeholder, which means CrossRef / Semantic Scholar
 * never get a chance to discover the real DOI by title+author.
 *
 * Before this fix the function lived in two places — a renderer copy
 * that excluded `unknown:*` (for the deleted "pre-enrichment" gate)
 * and this canonical copy that included them. The disagreement caused
 * a feedback loop: renderer said "needs enrichment", user clicked,
 * IPC said "already enriched", returned in milliseconds, button never
 * updated. The renderer-side gate is now gone (RFC-007 PR-C fix); we
 * also align this function so the manual "Enrich All" QuickAction
 * actually does the right thing.
 */
export function countCoreFields(paper: PaperInput): number {
  let count = 0
  for (const field of CORE_FIELDS) {
    const val = paper[field]
    if (val === undefined || val === null || val === '') continue
    if (Array.isArray(val) && val.length === 0) continue
    // unknown:* DOIs are placeholders, not real values — don't count
    // them as evidence that enrichment can be skipped.
    if (field === 'doi' && typeof val === 'string' && val.startsWith('unknown:')) continue
    count++
  }
  return count
}

// ============================================================================
// Merge
// ============================================================================

/**
 * Fill missing fields on target from source. Does not overwrite existing values.
 */
export function mergeMissing(target: PaperInput, source: Partial<PaperInput>, sourceName?: string): void {
  for (const field of CORE_FIELDS) {
    const targetVal = target[field]
    const sourceVal = source[field]
    if ((targetVal === undefined || targetVal === null || targetVal === '') && sourceVal !== undefined && sourceVal !== null && sourceVal !== '') {
      (target as Record<string, unknown>)[field] = sourceVal
    }
  }
  // Also fill url and pdfUrl
  if (!target.url && source.url) target.url = source.url
  if (!target.pdfUrl && source.pdfUrl) target.pdfUrl = source.pdfUrl
  if (sourceName) (target as Record<string, unknown>).enrichmentSource = sourceName
  ;(target as Record<string, unknown>).enrichedAt = new Date().toISOString()
}

// ============================================================================
// API Helpers
// ============================================================================

/**
 * Fetch paper metadata from Crossref by DOI.
 */
async function fetchCrossrefByDOI(
  doi: string,
  config: EnrichmentConfig
): Promise<Partial<PaperInput> | null> {
  if (!config.circuitBreaker.isAllowed('crossref')) return null

  try {
    await config.rateLimiter.acquire('crossref')
    const headers: Record<string, string> = {}
    if (config.crossrefMailto) {
      headers['User-Agent'] = `ResearchPilot/1.0 (mailto:${config.crossrefMailto})`
    }

    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers,
      signal: AbortSignal.timeout(10_000)
    })
    config.rateLimiter.release('crossref')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('crossref')
      return null
    }

    config.circuitBreaker.recordSuccess('crossref')
    const data = await response.json() as { message?: Record<string, unknown> }
    const msg = data.message
    if (!msg) return null

    const authors: string[] = ((msg.author as Array<{ given?: string; family?: string }>) || [])
      .map(a => [a.given, a.family].filter(Boolean).join(' '))

    return {
      title: Array.isArray(msg.title) ? (msg.title as string[])[0] : undefined,
      authors: authors.length > 0 ? authors : undefined,
      year: (msg.published as { 'date-parts'?: number[][] })?.['date-parts']?.[0]?.[0],
      venue: (msg['container-title'] as string[])?.[0],
      doi: doi,
      abstract: typeof msg.abstract === 'string' ? msg.abstract.replace(/<[^>]+>/g, '') : undefined,
      citationCount: typeof msg['is-referenced-by-count'] === 'number' ? msg['is-referenced-by-count'] : undefined
    }
  } catch {
    config.rateLimiter.release('crossref')
    config.circuitBreaker.recordFailure('crossref')
    return null
  }
}

/**
 * Fetch paper metadata from Semantic Scholar by DOI.
 */
async function fetchSemanticScholarByDOI(
  doi: string,
  config: EnrichmentConfig
): Promise<Partial<PaperInput> | null> {
  if (!config.circuitBreaker.isAllowed('semantic_scholar')) return null

  try {
    await config.rateLimiter.acquire('semantic_scholar')
    const headers: Record<string, string> = {}
    if (config.semanticScholarApiKey) {
      headers['x-api-key'] = config.semanticScholarApiKey
    }

    const fields = 'paperId,title,abstract,year,venue,citationCount,url,authors,externalIds'
    const response = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    )
    config.rateLimiter.release('semantic_scholar')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('semantic_scholar')
      return null
    }

    config.circuitBreaker.recordSuccess('semantic_scholar')
    const p = await response.json() as Record<string, unknown>

    return {
      title: p.title as string | undefined,
      authors: ((p.authors as Array<{ name: string }>) || []).map(a => a.name),
      year: p.year as number | undefined,
      venue: p.venue as string | undefined,
      abstract: p.abstract as string | undefined,
      citationCount: p.citationCount as number | undefined,
      url: p.url as string | undefined,
      doi: (p.externalIds as Record<string, string>)?.DOI
    }
  } catch {
    config.rateLimiter.release('semantic_scholar')
    config.circuitBreaker.recordFailure('semantic_scholar')
    return null
  }
}

/**
 * Reconstruct plain-text abstract from OpenAlex's `abstract_inverted_index`.
 *
 * OpenAlex stores abstracts as `{ word: [position, ...] }` so that they can
 * be safely indexed without re-publishing copyright-bearing prose verbatim.
 * Re-assembly is mechanical: sort all (word, position) pairs by position and
 * join with spaces. Returns `undefined` when the index is missing or empty.
 *
 * Exported for tests; treated as internal otherwise.
 */
export function reconstructOpenAlexAbstract(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!index || typeof index !== 'object') return undefined
  const pairs: { word: string; p: number }[] = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const p of positions) {
      if (typeof p === 'number') pairs.push({ word, p })
    }
  }
  if (pairs.length === 0) return undefined
  pairs.sort((a, b) => a.p - b.p)
  return pairs.map(x => x.word).join(' ')
}

/**
 * Build an OpenAlex API URL with the optional polite-pool `mailto` parameter.
 * OpenAlex prefers `mailto` in the query string (per their docs) — that path
 * also unlocks higher per-day quotas. We reuse `config.crossrefMailto` since
 * the user's identification is the same regardless of which API we're hitting.
 */
function openAlexUrl(path: string, config: EnrichmentConfig): string {
  const base = `https://api.openalex.org${path}`
  if (!config.crossrefMailto) return base
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}mailto=${encodeURIComponent(config.crossrefMailto)}`
}

/**
 * Parse an OpenAlex `Work` record into our PaperInput shape. Shared by the
 * by-DOI fetcher and the by-title searcher so both paths reconstruct
 * abstracts the same way and surface the same fields.
 */
function parseOpenAlexWork(w: Record<string, unknown>): Partial<PaperInput> {
  const authorships = (w.authorships as Array<{ author?: { display_name?: string } }>) || []
  const authors = authorships
    .map(a => a.author?.display_name)
    .filter((n): n is string => !!n)
  const primary = w.primary_location as { source?: { display_name?: string }; landing_page_url?: string } | undefined

  // OpenAlex's `doi` field is a full URL like "https://doi.org/10.1145/...".
  // Strip the prefix so downstream comparisons (which normalize via
  // normalizeDOI) line up with what CrossRef returns.
  const rawDoi = typeof w.doi === 'string' ? w.doi : undefined
  const doi = rawDoi?.replace(/^https?:\/\/doi\.org\//i, '')

  return {
    title: (w.title ?? w.display_name) as string | undefined,
    authors: authors.length > 0 ? authors : undefined,
    year: typeof w.publication_year === 'number' ? w.publication_year : undefined,
    venue: primary?.source?.display_name,
    abstract: reconstructOpenAlexAbstract(w.abstract_inverted_index as Record<string, number[]> | null),
    citationCount: typeof w.cited_by_count === 'number' ? w.cited_by_count : undefined,
    url: primary?.landing_page_url,
    doi,
  }
}

/**
 * Fetch paper metadata from OpenAlex by DOI.
 *
 * OpenAlex covers a substantially wider abstract corpus than CrossRef for
 * paywalled ACM/IEEE/Elsevier papers — CrossRef's `message.abstract` field
 * is only populated when the publisher chooses to deposit it, which most
 * paywalled venues do not. OpenAlex synthesizes its abstract index from
 * additional sources (publisher feeds, repository scrapes), so it's the
 * highest-yield second hop after CrossRef for BibTeX imports.
 */
async function fetchOpenAlexByDOI(
  doi: string,
  config: EnrichmentConfig,
): Promise<Partial<PaperInput> | null> {
  if (!config.circuitBreaker.isAllowed('openalex')) return null

  try {
    await config.rateLimiter.acquire('openalex')
    const url = openAlexUrl(`/works/doi:${encodeURIComponent(doi)}`, config)
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    config.rateLimiter.release('openalex')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('openalex')
      return null
    }

    config.circuitBreaker.recordSuccess('openalex')
    const data = await response.json() as Record<string, unknown>
    if (!data || typeof data !== 'object') return null
    return parseOpenAlexWork(data)
  } catch {
    config.rateLimiter.release('openalex')
    config.circuitBreaker.recordFailure('openalex')
    return null
  }
}

/**
 * Search OpenAlex by title to find a matching paper. Used by the
 * no-DOI enrichment path as a third candidate-pool after DBLP and SS.
 */
async function searchOpenAlexByTitle(
  title: string,
  config: EnrichmentConfig,
): Promise<Partial<PaperInput>[]> {
  if (!config.circuitBreaker.isAllowed('openalex')) return []

  try {
    await config.rateLimiter.acquire('openalex')
    const url = openAlexUrl(`/works?search=${encodeURIComponent(title)}&per_page=3`, config)
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    config.rateLimiter.release('openalex')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('openalex')
      return []
    }

    config.circuitBreaker.recordSuccess('openalex')
    const data = await response.json() as { results?: Array<Record<string, unknown>> }
    return (data.results ?? []).map(parseOpenAlexWork)
  } catch {
    config.rateLimiter.release('openalex')
    config.circuitBreaker.recordFailure('openalex')
    return []
  }
}

/**
 * Search DBLP by title to find a matching paper.
 */
async function searchDblpByTitle(
  title: string,
  config: EnrichmentConfig
): Promise<Partial<PaperInput>[]> {
  if (!config.circuitBreaker.isAllowed('dblp')) return []

  try {
    await config.rateLimiter.acquire('dblp')
    const response = await fetch(
      `https://dblp.org/search/publ/api?q=${encodeURIComponent(title)}&format=json&h=3`,
      { signal: AbortSignal.timeout(10_000) }
    )
    config.rateLimiter.release('dblp')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('dblp')
      return []
    }

    config.circuitBreaker.recordSuccess('dblp')
    const data = await response.json() as { result?: { hits?: { hit?: Array<{ info: Record<string, unknown> }> } } }
    const hits = data?.result?.hits?.hit ?? []

    return hits.map(h => {
      const info = h.info
      const rawAuthors = info.authors as { author: { text: string } | Array<{ text: string }> } | undefined
      let authors: string[] = []
      if (rawAuthors?.author) {
        authors = Array.isArray(rawAuthors.author)
          ? rawAuthors.author.map(a => a.text)
          : [rawAuthors.author.text]
      }
      return {
        title: info.title as string | undefined,
        authors,
        year: Number(info.year) || undefined,
        venue: info.venue as string | undefined,
        doi: info.doi as string | undefined,
        url: (info.ee ?? info.url) as string | undefined
      }
    })
  } catch {
    config.rateLimiter.release('dblp')
    config.circuitBreaker.recordFailure('dblp')
    return []
  }
}

/**
 * Search Semantic Scholar by title+author to find a matching paper.
 */
async function searchSemanticScholarByTitle(
  query: string,
  config: EnrichmentConfig
): Promise<Partial<PaperInput>[]> {
  if (!config.circuitBreaker.isAllowed('semantic_scholar')) return []

  try {
    await config.rateLimiter.acquire('semantic_scholar')
    const headers: Record<string, string> = {}
    if (config.semanticScholarApiKey) {
      headers['x-api-key'] = config.semanticScholarApiKey
    }

    const fields = 'paperId,title,abstract,year,venue,citationCount,url,authors,externalIds'
    const response = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=3&fields=${fields}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    )
    config.rateLimiter.release('semantic_scholar')

    if (!response.ok) {
      config.circuitBreaker.recordFailure('semantic_scholar')
      return []
    }

    config.circuitBreaker.recordSuccess('semantic_scholar')
    const data = await response.json() as { data?: Array<Record<string, unknown>> }

    return (data.data || []).map(p => ({
      title: p.title as string | undefined,
      authors: ((p.authors as Array<{ name: string }>) || []).map(a => a.name),
      year: p.year as number | undefined,
      venue: p.venue as string | undefined,
      abstract: p.abstract as string | undefined,
      citationCount: p.citationCount as number | undefined,
      url: p.url as string | undefined,
      doi: (p.externalIds as Record<string, string>)?.DOI
    }))
  } catch {
    config.rateLimiter.release('semantic_scholar')
    config.circuitBreaker.recordFailure('semantic_scholar')
    return []
  }
}

/**
 * Compute word-level Jaccard similarity between two normalized title strings.
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2))
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  return intersection / (wordsA.size + wordsB.size - intersection)
}

/**
 * Find a candidate with matching normalized title.
 * Uses exact match first, then falls back to Jaccard similarity >= 0.8.
 */
function findByNormalizedTitle(
  normalizedTarget: string,
  candidates: Partial<PaperInput>[]
): Partial<PaperInput> | null {
  let bestMatch: Partial<PaperInput> | null = null
  let bestScore = 0

  for (const c of candidates) {
    if (!c.title) continue
    const candTitle = normalizeTitle(c.title)
    // Exact match
    if (candTitle === normalizedTarget) return c
    // Fuzzy match
    const score = titleSimilarity(candTitle, normalizedTarget)
    if (score > bestScore) {
      bestScore = score
      bestMatch = c
    }
  }

  // Accept fuzzy match if similarity is high enough
  return bestScore >= 0.8 ? bestMatch : null
}

// ============================================================================
// Enrichment Paths
// ============================================================================

/**
 * Path A: DOI present — direct lookup via Crossref, OpenAlex, then Semantic Scholar.
 *
 * Source ordering rationale:
 *  1. CrossRef — authoritative for bibliographic metadata (DOI, venue,
 *     authors, citation count). Abstract coverage is uneven; the publisher
 *     has to actively deposit one for it to appear here.
 *  2. OpenAlex — second hop specifically chosen for its abstract coverage,
 *     which is substantially better than CrossRef for paywalled ACM/IEEE/
 *     Elsevier papers (synthesized index from publisher feeds + repository
 *     scrapes). Free, no API key, polite-pool via mailto.
 *  3. Semantic Scholar — third hop for citationCount accuracy and a final
 *     abstract fallback. Rate-limited harder than OpenAlex when no key is
 *     configured, so we hit it last to avoid burning the quota on papers
 *     OpenAlex already filled.
 *
 * The `countCoreFields(paper) < 7` gates between hops short-circuit once
 * we have full metadata, so well-indexed papers don't fan out to all three.
 */
async function enrichByDOI(paper: PaperInput, config: EnrichmentConfig): Promise<void> {
  const doi = normalizeDOI(paper.doi!)

  const cr = await fetchCrossrefByDOI(doi, config)
  if (cr) mergeMissing(paper, cr, 'crossref')

  if (countCoreFields(paper) < 7) {
    const oa = await fetchOpenAlexByDOI(doi, config)
    if (oa) mergeMissing(paper, oa, 'openalex')
  }

  if (countCoreFields(paper) < 7) {
    const ss = await fetchSemanticScholarByDOI(doi, config)
    if (ss) mergeMissing(paper, ss, 'semantic_scholar')
  }

  config.cache.set(`doi:${doi}`, { ...paper } as Partial<EnrichedPaper>)
}

/**
 * Path B: DOI missing — search DBLP, OpenAlex, then Semantic Scholar by title.
 *
 * Each source is consulted in turn; the first to yield a high-confidence
 * title match wins. If that match carries a DOI, we hop into `enrichByDOI`
 * to pick up the remaining canonical fields via the DOI path. OpenAlex is
 * the second hop because its broader corpus surfaces papers that DBLP
 * (CS-only) doesn't index — important for non-CS BibTeX libraries.
 */
async function enrichByTitleAuthor(paper: PaperInput, config: EnrichmentConfig): Promise<void> {
  const normTitle = normalizeTitle(paper.title)
  const familyNames = paper.authors ? extractFamilyNames(paper.authors) : []

  // Try DBLP first
  const dblpCandidates = await searchDblpByTitle(paper.title, config)
  const dblpMatch = findByNormalizedTitle(normTitle, dblpCandidates)

  if (dblpMatch) {
    mergeMissing(paper, dblpMatch, 'dblp')
    if (dblpMatch.doi && countCoreFields(paper) < 7) {
      paper.doi = dblpMatch.doi
      await enrichByDOI(paper, config)
    }
    return
  }

  // Try OpenAlex search — broader than DBLP, covers non-CS venues
  const oaCandidates = await searchOpenAlexByTitle(paper.title, config)
  const oaMatch = findByNormalizedTitle(normTitle, oaCandidates)

  if (oaMatch) {
    mergeMissing(paper, oaMatch, 'openalex')
    if (oaMatch.doi && countCoreFields(paper) < 7) {
      paper.doi = oaMatch.doi
      await enrichByDOI(paper, config)
    }
    return
  }

  // Try Semantic Scholar search
  const ssQuery = familyNames[0]
    ? `${paper.title} ${familyNames[0]}`
    : paper.title
  const ssCandidates = await searchSemanticScholarByTitle(ssQuery, config)
  const ssMatch = findByNormalizedTitle(normTitle, ssCandidates)

  if (ssMatch) {
    mergeMissing(paper, ssMatch, 'semantic_scholar')
    if (ssMatch.doi && countCoreFields(paper) < 7) {
      paper.doi = ssMatch.doi
      await enrichByDOI(paper, config)
    }
    return
  }

  // No match found — skip to avoid merging wrong data
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Enrich a list of papers by filling missing metadata from external APIs.
 * Runs within a time budget and respects rate limits.
 */
export async function enrichPapers(
  papers: PaperInput[],
  config: EnrichmentConfig
): Promise<EnrichmentStats> {
  const stats: EnrichmentStats = { enriched: 0, skipped: 0, failed: 0 }
  const startTime = Date.now()

  // Skip papers that already have 5+ of 7 core fields — UNLESS their
  // abstract is empty. Abstract is the highest-value field for downstream
  // wiki generation and Paper Pack Reports; a BibTeX import with title +
  // authors + year + venue + doi (= 5 fields, often the default for ACM/
  // IEEE bib entries) would otherwise be considered "enriched enough" and
  // never get its abstract filled in from OpenAlex/Semantic Scholar even
  // though the data is available. Treat missing abstract as an automatic
  // trigger to attempt enrichment regardless of the rest of the count.
  const hasAbstract = (p: PaperInput): boolean =>
    typeof p.abstract === 'string' && p.abstract.trim().length > 0
  const needsEnrichment = papers.filter(p => countCoreFields(p) < 5 || !hasAbstract(p))
  stats.skipped = papers.length - needsEnrichment.length

  // Limit how many we enrich
  const toEnrich = needsEnrichment.slice(0, config.maxPapersToEnrich)
  stats.skipped += needsEnrichment.length - toEnrich.length

  // Prioritize: papers missing DOI first (DOI unlocks the fast path)
  toEnrich.sort((a, b) => (a.doi ? 1 : 0) - (b.doi ? 1 : 0))

  for (const paper of toEnrich) {
    // Time budget check
    if (Date.now() - startTime > config.maxTimeMs) break

    // Check cache
    const key = cacheKey(paper)
    const cached = config.cache.get(key)
    if (cached) {
      mergeMissing(paper, cached as Partial<PaperInput>)
      stats.enriched++
      continue
    }

    try {
      if (paper.doi) {
        await enrichByDOI(paper, config)
      } else {
        await enrichByTitleAuthor(paper, config)
      }
      stats.enriched++
    } catch {
      stats.failed++
    }
  }

  return stats
}

/**
 * Create default enrichment config with shared rate limiter and circuit breaker.
 */
export function createEnrichmentConfig(
  rateLimiter: RateLimiter,
  circuitBreaker: CircuitBreaker,
  options?: {
    crossrefMailto?: string
    semanticScholarApiKey?: string
  }
): EnrichmentConfig {
  return {
    maxTimeMs: 30_000,
    maxPapersToEnrich: 30,
    cache: new Map(),
    rateLimiter,
    circuitBreaker,
    crossrefMailto: options?.crossrefMailto,
    semanticScholarApiKey: options?.semanticScholarApiKey
  }
}
