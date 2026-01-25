/**
 * Literature Agent Types
 */

export interface Paper {
  id: string
  title: string
  authors: string[]
  abstract: string
  year: number
  venue?: string
  citationCount?: number
  url: string
  source: 'semantic_scholar' | 'arxiv' | 'openalex'
  doi?: string
  pdfUrl?: string
  keywords?: string[]
  relevanceScore?: number
}

export interface SearchResult {
  papers: Paper[]
  totalResults: number
  query: string
  source: string
  relevanceFiltered: boolean
}

export interface MultiSearchResult {
  papers: Paper[]
  totalResults: number
  originalQuery: string
  rewrittenQueries: string[]
  sources: string[]
  relevanceFiltered: boolean
}

export interface LiteratureConfig {
  /** Semantic Scholar API key (optional) */
  semanticScholarApiKey?: string
  /** Max papers per source (default: 8) */
  maxPapersPerSource?: number
  /** Enable relevance filtering (default: true) */
  enableRelevanceFilter?: boolean
  /** Max queries per session (default: 3) */
  maxQueriesPerSession?: number
}

/** Session state keys */
export const LITERATURE_STATE_KEYS = {
  QUERY_COUNT: 'literature:queryCount',
  SEARCHED_QUERIES: 'literature:searchedQueries',
  SEARCH_HISTORY: 'literature:searchHistory',
  PAPER_CACHE: 'literature:paperCache'
} as const

/** Default configuration */
export const LITERATURE_DEFAULTS = {
  maxPapersPerSource: 8,
  maxQueriesPerSession: 3,
  maxPapersPerSession: 24,
  enableRelevanceFilter: true
} as const
