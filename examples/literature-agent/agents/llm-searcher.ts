/**
 * LLM-Powered Searcher Agent
 *
 * Directly calls the literature_multi_search tool to perform
 * actual academic database searches. Uses LLM only for query refinement.
 */

import type { Paper } from '../types.js'
import { LITERATURE_DEFAULTS } from '../types.js'

export interface SearcherConfig {
  apiKey: string
  model?: string
}

export interface SearchResults {
  papers: Paper[]
  totalFound: number
  sourcesSearched: string[]
  sourcesSucceeded: string[]
  sourcesFailed: string[]
  queriesUsed: string[]
}

export interface LLMSearcherAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
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
    const key = paper.doi || paper.title.toLowerCase().replace(/\s+/g, ' ').trim()

    if (!seen.has(key)) {
      seen.set(key, paper)
    } else {
      const existing = seen.get(key)!
      if ((paper.citationCount || 0) > (existing.citationCount || 0)) {
        seen.set(key, paper)
      }
    }
  }

  return Array.from(seen.values())
}

/**
 * Search a single source
 */
async function searchSource(
  source: string,
  query: string,
  maxResults: number
): Promise<{ source: string; papers: Paper[]; error?: string }> {
  const encodedQuery = encodeURIComponent(query)

  try {
    let url: string
    let headers: Record<string, string> = {}

    switch (source) {
      case 'semantic_scholar':
        url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${maxResults}&fields=paperId,title,abstract,year,venue,citationCount,url,externalIds,authors,openAccessPdf`
        headers = { 'Accept': 'application/json' }
        break

      case 'arxiv':
        url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxResults}`
        break

      case 'openalex':
        url = `https://api.openalex.org/works?search=${encodedQuery}&per-page=${maxResults}`
        headers = { 'Accept': 'application/json' }
        break

      default:
        return { source, papers: [], error: `Unknown source: ${source}` }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      return { source, papers: [], error: `HTTP ${response.status}` }
    }

    let papers: Paper[]
    if (source === 'arxiv') {
      const text = await response.text()
      papers = parseArxiv(text)
    } else {
      const data = await response.json()
      papers = source === 'semantic_scholar'
        ? parseSemanticScholar(data)
        : parseOpenAlex(data)
    }

    return { source, papers }
  } catch (error) {
    return {
      source,
      papers: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Create an LLM-powered Searcher Agent
 *
 * This agent directly calls academic APIs without needing an LLM for the search itself.
 */
export function createLLMSearcherAgent(config: SearcherConfig): LLMSearcherAgent {
  let searchCount = 0

  return {
    id: 'searcher',

    async run(input: string): Promise<{ success: boolean; output: string }> {
      searchCount++
      console.log(`  [Searcher] Search #${searchCount}, processing request...`)

      // Parse input
      let queries: string[] = []
      let sources = ['semantic_scholar', 'arxiv', 'openalex']

      try {
        const parsed = JSON.parse(input)

        // Handle approved review result - pass through the relevant papers
        if (parsed.approved === true) {
          console.log(`  [Searcher] Review approved, passing through results`)
          // Return the relevant papers as search results
          const passThrough: SearchResults = {
            papers: parsed.relevantPapers || [],
            totalFound: parsed.relevantPapers?.length || 0,
            sourcesSearched: sources,
            sourcesSucceeded: sources,
            sourcesFailed: [],
            queriesUsed: ['(approved - no new search)']
          }
          return { success: true, output: JSON.stringify(passThrough) }
        }

        // Handle various input formats
        if (parsed.searchQueries) {
          // From QueryPlanner
          queries = parsed.searchQueries
        } else if (parsed.additionalQueries && parsed.additionalQueries.length > 0) {
          // From Reviewer feedback (only if there are additional queries)
          queries = parsed.additionalQueries
        } else if (parsed.queries) {
          queries = parsed.queries
        } else if (Array.isArray(parsed)) {
          queries = parsed
        }

        if (parsed.searchStrategy?.suggestedSources) {
          sources = parsed.searchStrategy.suggestedSources
        }
      } catch {
        // If not JSON, treat as single query
        queries = [input]
      }

      if (queries.length === 0) {
        console.log(`  [Searcher] No queries to process, returning empty result`)
        const emptyResult: SearchResults = {
          papers: [],
          totalFound: 0,
          sourcesSearched: sources,
          sourcesSucceeded: [],
          sourcesFailed: [],
          queriesUsed: []
        }
        return { success: true, output: JSON.stringify(emptyResult) }
      }

      console.log(`  [Searcher] Queries: ${queries.join(', ')}`)
      console.log(`  [Searcher] Sources: ${sources.join(', ')}`)

      const allPapers: Paper[] = []
      const sourcesSucceeded: string[] = []
      const sourcesFailed: string[] = []
      const maxPerSource = LITERATURE_DEFAULTS.maxPapersPerSource

      // Search each source for each query
      for (const query of queries) {
        const searchPromises = sources.map(source => searchSource(source, query, maxPerSource))
        const results = await Promise.allSettled(searchPromises)

        for (const result of results) {
          if (result.status === 'fulfilled') {
            const { source, papers, error } = result.value
            if (error) {
              console.log(`  [Searcher] ${source}: Failed - ${error}`)
              if (!sourcesFailed.includes(source)) sourcesFailed.push(source)
            } else {
              console.log(`  [Searcher] ${source}: Found ${papers.length} papers`)
              allPapers.push(...papers)
              if (!sourcesSucceeded.includes(source)) sourcesSucceeded.push(source)
            }
          }
        }
      }

      // Deduplicate
      const uniquePapers = deduplicatePapers(allPapers)
      console.log(`  [Searcher] Total: ${uniquePapers.length} unique papers after deduplication`)

      const searchResults: SearchResults = {
        papers: uniquePapers,
        totalFound: uniquePapers.length,
        sourcesSearched: sources,
        sourcesSucceeded,
        sourcesFailed,
        queriesUsed: queries
      }

      return { success: true, output: JSON.stringify(searchResults) }
    },

    async destroy() {
      // No cleanup needed
    }
  }
}
