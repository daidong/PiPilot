/**
 * Local Paper Lookup Utility
 *
 * Searches through locally saved papers in .research-pilot/literature/
 * to find matches against search queries using keyword overlap.
 * This allows reuse of previously discovered papers across searches.
 */

import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { PATHS, Literature } from '../types.js'

export interface LocalPaperMatch {
  paper: Literature
  matchScore: number  // How well it matches the query (0-1)
}

/**
 * Tokenize text into lowercase words, removing punctuation
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2)  // Skip very short words
  )
}

/**
 * Calculate Jaccard similarity between two token sets
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0

  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }

  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Calculate match score between a query and a paper
 * Uses weighted combination of title, abstract, keywords, and tags
 */
function calculateMatchScore(
  queryTokens: Set<string>,
  paper: Literature
): number {
  // Title is most important
  const titleTokens = tokenize(paper.title)
  const titleScore = jaccardSimilarity(queryTokens, titleTokens)

  // Abstract provides context
  const abstractTokens = tokenize(paper.abstract || '')
  const abstractScore = jaccardSimilarity(queryTokens, abstractTokens)

  // Search keywords if available (direct relevance)
  const keywordTokens = tokenize((paper.searchKeywords || []).join(' '))
  const keywordScore = jaccardSimilarity(queryTokens, keywordTokens)

  // Tags provide categorical matching
  const tagTokens = tokenize((paper.tags || []).join(' '))
  const tagScore = jaccardSimilarity(queryTokens, tagTokens)

  // Weighted combination: title > keywords > abstract > tags
  const weightedScore = (
    titleScore * 0.4 +
    keywordScore * 0.3 +
    abstractScore * 0.2 +
    tagScore * 0.1
  )

  return weightedScore
}

/**
 * Load all papers from the local literature directory
 */
function loadLocalPapers(projectPath: string): Literature[] {
  const literaturePath = join(projectPath, PATHS.literature)

  if (!existsSync(literaturePath)) {
    return []
  }

  const papers: Literature[] = []

  try {
    const files = readdirSync(literaturePath)

    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const filePath = join(literaturePath, file)
        const content = readFileSync(filePath, 'utf-8')
        const paper = JSON.parse(content) as Literature

        // Validate it's a literature entity
        if (paper.type === 'literature' && paper.title) {
          papers.push(paper)
        }
      } catch {
        // Skip invalid files silently
      }
    }
  } catch {
    // Directory read failed, return empty
  }

  return papers
}

/**
 * Search local papers for matches against the given queries
 *
 * @param queries - Search queries to match against
 * @param projectPath - Root project path (absolute)
 * @param minScore - Minimum match score threshold (default 0.1)
 * @param maxResults - Maximum number of results to return (default 15)
 * @returns Array of matching papers with their scores, sorted by score descending
 */
export function searchLocalPapers(
  queries: string[],
  projectPath: string,
  minScore: number = 0.1,
  maxResults: number = 15
): LocalPaperMatch[] {
  const papers = loadLocalPapers(projectPath)

  if (papers.length === 0 || queries.length === 0) {
    return []
  }

  // Combine all query terms into one token set for matching
  const combinedQueryTokens = new Set<string>()
  for (const query of queries) {
    for (const token of tokenize(query)) {
      combinedQueryTokens.add(token)
    }
  }

  // Score all papers
  const matches: LocalPaperMatch[] = []

  for (const paper of papers) {
    const matchScore = calculateMatchScore(combinedQueryTokens, paper)

    if (matchScore >= minScore) {
      matches.push({ paper, matchScore })
    }
  }

  // Sort by score descending and limit results
  matches.sort((a, b) => b.matchScore - a.matchScore)

  return matches.slice(0, maxResults)
}

/**
 * Check if a paper already exists locally by DOI or title match
 */
export function findExistingPaper(
  paper: { doi?: string | null; title: string },
  projectPath: string
): Literature | null {
  const papers = loadLocalPapers(projectPath)

  // First try DOI match (exact)
  if (paper.doi) {
    const doiMatch = papers.find(p => p.doi && p.doi === paper.doi)
    if (doiMatch) return doiMatch
  }

  // Fallback to title match (normalized)
  const normalizedTitle = paper.title.toLowerCase().replace(/\s+/g, ' ').trim()
  const titleMatch = papers.find(
    p => p.title.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTitle
  )

  return titleMatch || null
}
