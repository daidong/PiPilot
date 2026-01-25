/**
 * Multi-Source Literature Search Tool
 *
 * Performs parallel search across multiple academic sources:
 * - Semantic Scholar
 * - arXiv
 * - OpenAlex
 *
 * Features:
 * - Parallel execution with Promise.allSettled
 * - Automatic fallback on source failure
 * - Deduplication by DOI/title
 * - Session-based search limits
 */

import { defineTool } from '../../../src/index.js'
import type { Paper, SearchResult } from '../types.js'
import { LITERATURE_DEFAULTS, LITERATURE_STATE_KEYS } from '../types.js'

export interface MultiSearchInput {
  /** Search queries (can be multiple for better coverage) */
  queries: string[]
  /** Max papers per source */
  maxPerSource?: number
  /** Sources to search (default: all) */
  sources?: ('semantic_scholar' | 'arxiv' | 'openalex')[]
}

export interface MultiSearchOutput {
  papers: Paper[]
  totalFound: number
  sourcesSearched: string[]
  sourcesSucceeded: string[]
  sourcesFailed: string[]
  queriesUsed: string[]
  truncated: boolean
}

// API response types
interface SemanticScholarPaper {
  paperId: string
  title: string
  abstract?: string
  year?: number
  venue?: string
  citationCount?: number
  url?: string
  externalIds?: { DOI?: string; ArXiv?: string }
  authors?: Array<{ name: string }>
  openAccessPdf?: { url: string }
}

interface OpenAlexWork {
  id: string
  title: string
  abstract_inverted_index?: Record<string, number[]>
  publication_year?: number
  primary_location?: { source?: { display_name: string } }
  cited_by_count?: number
  doi?: string
  authorships?: Array<{ author: { display_name: string } }>
  open_access?: { oa_url?: string }
}

/**
 * Parse Semantic Scholar response
 */
function parseSemanticScholar(data: { data?: SemanticScholarPaper[] }): Paper[] {
  return (data.data || []).map((p): Paper => ({
    id: p.paperId,
    title: p.title || 'Unknown',
    authors: (p.authors || []).map(a => a.name),
    abstract: p.abstract || '',
    year: p.year || 0,
    venue: p.venue,
    citationCount: p.citationCount,
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    source: 'semantic_scholar',
    doi: p.externalIds?.DOI,
    pdfUrl: p.openAccessPdf?.url
  }))
}

/**
 * Parse arXiv XML response
 */
function parseArxiv(xmlText: string): Paper[] {
  const papers: Paper[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match

  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entry = match[1]

    const getId = (s: string) => s.match(/<id>([^<]+)<\/id>/)?.[1] || ''
    const getTitle = (s: string) => s.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || ''
    const getSummary = (s: string) => s.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || ''
    const getPublished = (s: string) => s.match(/<published>([^<]+)<\/published>/)?.[1] || ''

    const authors: string[] = []
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g
    let authorMatch
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1])
    }

    const id = getId(entry)
    const arxivId = id.split('/abs/')[1] || id

    papers.push({
      id: arxivId,
      title: getTitle(entry),
      authors,
      abstract: getSummary(entry),
      year: parseInt(getPublished(entry).slice(0, 4)) || 0,
      url: id,
      source: 'arxiv',
      pdfUrl: id.replace('/abs/', '/pdf/') + '.pdf'
    })
  }

  return papers
}

/**
 * Parse OpenAlex response
 */
function parseOpenAlex(data: { results?: OpenAlexWork[] }): Paper[] {
  return (data.results || []).map((w): Paper => {
    // Reconstruct abstract from inverted index
    let abstract = ''
    if (w.abstract_inverted_index) {
      const words: [string, number][] = []
      for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
        for (const pos of positions) {
          words.push([word, pos])
        }
      }
      words.sort((a, b) => a[1] - b[1])
      abstract = words.map(w => w[0]).join(' ')
    }

    return {
      id: w.id,
      title: w.title || 'Unknown',
      authors: (w.authorships || []).map(a => a.author.display_name),
      abstract,
      year: w.publication_year || 0,
      venue: w.primary_location?.source?.display_name,
      citationCount: w.cited_by_count,
      url: w.id,
      source: 'openalex',
      doi: w.doi?.replace('https://doi.org/', ''),
      pdfUrl: w.open_access?.oa_url
    }
  })
}

/**
 * Deduplicate papers by DOI or normalized title
 */
function deduplicatePapers(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>()

  for (const paper of papers) {
    // Key by DOI if available, otherwise by normalized title
    const key = paper.doi || paper.title.toLowerCase().replace(/\s+/g, ' ').trim()

    if (!seen.has(key)) {
      seen.set(key, paper)
    } else {
      // Keep the one with more info (higher citation count or more complete)
      const existing = seen.get(key)!
      if ((paper.citationCount || 0) > (existing.citationCount || 0)) {
        seen.set(key, paper)
      }
    }
  }

  return Array.from(seen.values())
}

export const multiSearch = defineTool({
  name: 'literature_multi_search',
  description: `Search for academic papers across multiple sources (Semantic Scholar, arXiv, OpenAlex).
Performs parallel searches and deduplicates results.
Enforces session limits: max ${LITERATURE_DEFAULTS.maxQueriesPerSession} unique queries, max ${LITERATURE_DEFAULTS.maxPapersPerSession} papers per session.

Use this for comprehensive literature search.`,

  parameters: {
    queries: {
      type: 'array',
      items: { type: 'string' },
      description: 'Search queries (1-3 queries for better coverage)',
      required: true
    },
    maxPerSource: {
      type: 'number',
      description: `Max papers per source (default: ${LITERATURE_DEFAULTS.maxPapersPerSource})`,
      required: false,
      default: LITERATURE_DEFAULTS.maxPapersPerSource
    },
    sources: {
      type: 'array',
      items: { type: 'string' },
      description: 'Sources to search: semantic_scholar, arxiv, openalex (default: all)',
      required: false
    }
  },

  execute: async (input, { runtime }) => {
    const {
      queries,
      maxPerSource = LITERATURE_DEFAULTS.maxPapersPerSource,
      sources = ['semantic_scholar', 'arxiv', 'openalex']
    } = input

    // Check session limits
    const queryCount = runtime.sessionState.get<number>(LITERATURE_STATE_KEYS.QUERY_COUNT) || 0
    const searchedQueries = runtime.sessionState.get<Set<string>>(LITERATURE_STATE_KEYS.SEARCHED_QUERIES) || new Set()

    // Filter out already-searched queries
    const newQueries = queries.filter(q => !searchedQueries.has(q.toLowerCase()))

    if (newQueries.length === 0) {
      return {
        success: false,
        error: 'All queries have already been searched in this session'
      }
    }

    // Check query limit
    const remainingQueries = LITERATURE_DEFAULTS.maxQueriesPerSession - queryCount
    if (remainingQueries <= 0) {
      return {
        success: false,
        error: `Session query limit reached (${LITERATURE_DEFAULTS.maxQueriesPerSession} queries max)`
      }
    }

    const queriesToUse = newQueries.slice(0, remainingQueries)
    const allPapers: Paper[] = []
    const sourcesSucceeded: string[] = []
    const sourcesFailed: string[] = []

    // Search each source for each query
    for (const query of queriesToUse) {
      const encodedQuery = encodeURIComponent(query)

      const searchPromises = sources.map(async (source): Promise<{ source: string; papers: Paper[]; error?: string }> => {
        try {
          let url: string
          let headers: Record<string, string> = {}

          switch (source) {
            case 'semantic_scholar':
              url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${maxPerSource}&fields=paperId,title,abstract,year,venue,citationCount,url,externalIds,authors,openAccessPdf`
              headers = { 'Accept': 'application/json' }
              break

            case 'arxiv':
              url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxPerSource}`
              break

            case 'openalex':
              url = `https://api.openalex.org/works?search=${encodedQuery}&per-page=${maxPerSource}`
              break

            default:
              return { source, papers: [], error: `Unknown source: ${source}` }
          }

          // Use fetch tool
          const result = await runtime.toolRegistry.call('fetch', {
            url,
            method: 'GET',
            headers,
            timeout: 15000
          }, {
            runtime,
            sessionId: runtime.sessionId,
            step: runtime.step,
            agentId: runtime.agentId
          })

          if (!result.success) {
            return { source, papers: [], error: result.error }
          }

          const response = result.data as { body: unknown; ok: boolean; status: number }

          if (!response.ok) {
            return { source, papers: [], error: `HTTP ${response.status}` }
          }

          let papers: Paper[]
          switch (source) {
            case 'semantic_scholar':
              papers = parseSemanticScholar(response.body as any)
              break
            case 'arxiv':
              papers = parseArxiv(response.body as string)
              break
            case 'openalex':
              papers = parseOpenAlex(response.body as any)
              break
            default:
              papers = []
          }

          return { source, papers }
        } catch (error) {
          return { source, papers: [], error: error instanceof Error ? error.message : 'Unknown error' }
        }
      })

      // Execute in parallel
      const results = await Promise.allSettled(searchPromises)

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { source, papers, error } = result.value
          if (error) {
            if (!sourcesFailed.includes(source)) sourcesFailed.push(source)
          } else {
            allPapers.push(...papers)
            if (!sourcesSucceeded.includes(source)) sourcesSucceeded.push(source)
          }
        }
      }

      // Mark query as searched
      searchedQueries.add(query.toLowerCase())
    }

    // Deduplicate
    const uniquePapers = deduplicatePapers(allPapers)

    // Apply session paper limit
    const paperCache = runtime.sessionState.get<Paper[]>(LITERATURE_STATE_KEYS.PAPER_CACHE) || []
    const remainingPaperSlots = LITERATURE_DEFAULTS.maxPapersPerSession - paperCache.length
    const truncated = uniquePapers.length > remainingPaperSlots
    const finalPapers = uniquePapers.slice(0, Math.max(0, remainingPaperSlots))

    // Update session state
    runtime.sessionState.set(LITERATURE_STATE_KEYS.QUERY_COUNT, queryCount + queriesToUse.length)
    runtime.sessionState.set(LITERATURE_STATE_KEYS.SEARCHED_QUERIES, searchedQueries)
    runtime.sessionState.set(LITERATURE_STATE_KEYS.PAPER_CACHE, [...paperCache, ...finalPapers])

    return {
      success: true,
      data: {
        papers: finalPapers,
        totalFound: uniquePapers.length,
        sourcesSearched: sources,
        sourcesSucceeded,
        sourcesFailed,
        queriesUsed: queriesToUse,
        truncated
      }
    }
  }
})
