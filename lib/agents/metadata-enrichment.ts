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
 */
export function countCoreFields(paper: PaperInput): number {
  let count = 0
  for (const field of CORE_FIELDS) {
    const val = paper[field]
    if (val !== undefined && val !== null && val !== '') {
      if (Array.isArray(val) && val.length === 0) continue
      count++
    }
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
 * Path A: DOI present — direct lookup via Crossref then Semantic Scholar.
 */
async function enrichByDOI(paper: PaperInput, config: EnrichmentConfig): Promise<void> {
  const doi = normalizeDOI(paper.doi!)

  const cr = await fetchCrossrefByDOI(doi, config)
  if (cr) mergeMissing(paper, cr, 'crossref')

  if (countCoreFields(paper) < 7) {
    const ss = await fetchSemanticScholarByDOI(doi, config)
    if (ss) mergeMissing(paper, ss, 'semantic_scholar')
  }

  config.cache.set(`doi:${doi}`, { ...paper } as Partial<EnrichedPaper>)
}

/**
 * Path B: DOI missing — search DBLP then Semantic Scholar by title.
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

  // Skip papers that already have 5+ of 7 core fields
  const needsEnrichment = papers.filter(p => countCoreFields(p) < 5)
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
