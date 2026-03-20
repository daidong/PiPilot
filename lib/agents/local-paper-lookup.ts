/**
 * Local Paper Lookup Utility
 *
 * Searches through locally saved papers in .research-pilot/artifacts/papers/
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
  const literaturePath = join(projectPath, PATHS.papers)

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

        if (paper.type === 'paper' && paper.title) {
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
 * Normalize a DOI string for comparison: lowercase, strip URL prefix, trim.
 */
function normalizeDOI(doi: string): string {
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim()
}

/**
 * Check if a paper already exists locally by DOI or title match.
 * Uses normalized DOI comparison, exact normalized title, Levenshtein fuzzy
 * matching (< 10% of title length), and word-level Jaccard similarity as fallbacks.
 */
export function findExistingPaper(
  paper: { doi?: string | null; title: string },
  projectPath: string
): Literature | null {
  const papers = loadLocalPapers(projectPath)

  // First try DOI match (normalized — handles case and URL prefix differences)
  if (paper.doi) {
    const normalizedInputDoi = normalizeDOI(paper.doi)
    const doiMatch = papers.find(p => p.doi && normalizeDOI(p.doi) === normalizedInputDoi)
    if (doiMatch) return doiMatch
  }

  // Exact normalized title match
  const normalizedTitle = paper.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const titleMatch = papers.find(
    p => p.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim() === normalizedTitle
  )
  if (titleMatch) return titleMatch

  // Fuzzy title match: Levenshtein distance < 10% of title length
  const threshold = Math.max(3, Math.floor(normalizedTitle.length * 0.1))
  for (const p of papers) {
    const pTitle = p.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (Math.abs(pTitle.length - normalizedTitle.length) > threshold) continue
    if (levenshteinDistance(normalizedTitle, pTitle) <= threshold) {
      return p
    }
  }

  // Word-level Jaccard similarity fallback (catches reworded/reordered titles)
  const inputWords = new Set(normalizedTitle.split(' ').filter(w => w.length > 2))
  if (inputWords.size > 0) {
    let bestMatch: Literature | null = null
    let bestScore = 0
    for (const p of papers) {
      const pTitle = p.title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
      const pWords = new Set(pTitle.split(' ').filter(w => w.length > 2))
      if (pWords.size === 0) continue
      let intersection = 0
      for (const w of inputWords) {
        if (pWords.has(w)) intersection++
      }
      const score = intersection / (inputWords.size + pWords.size - intersection)
      if (score > bestScore) {
        bestScore = score
        bestMatch = p
      }
    }
    if (bestScore >= 0.85 && bestMatch) return bestMatch
  }

  return null
}

/**
 * Scan local library and group papers by keyword overlap.
 * Returns topic clusters with counts and sample titles.
 */
export function scanLocalLibrary(projectPath: string): {
  totalPapers: number
  topicClusters: { topic: string; count: number; sampleTitles: string[] }[]
} {
  const papers = loadLocalPapers(projectPath)
  if (papers.length === 0) {
    return { totalPapers: 0, topicClusters: [] }
  }

  // Group papers by their searchKeywords
  const topicMap = new Map<string, Literature[]>()

  for (const paper of papers) {
    const keywords = paper.searchKeywords || []
    if (keywords.length === 0) {
      // Use tokenized title words as fallback topics
      const titleWords = paper.title.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 3)
      for (const w of titleWords) {
        if (!topicMap.has(w)) topicMap.set(w, [])
        topicMap.get(w)!.push(paper)
      }
    } else {
      // Use search keywords as topic keys
      const topicKey = keywords.slice(0, 5).join(' ')
      if (!topicMap.has(topicKey)) topicMap.set(topicKey, [])
      topicMap.get(topicKey)!.push(paper)
    }
  }

  // Merge small clusters and build result
  const clusters = Array.from(topicMap.entries())
    .filter(([, papers]) => papers.length >= 2) // Only clusters with 2+ papers
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10) // Top 10 clusters
    .map(([topic, papers]) => ({
      topic,
      count: papers.length,
      sampleTitles: papers.slice(0, 3).map(p => p.title)
    }))

  return { totalPapers: papers.length, topicClusters: clusters }
}

/**
 * Simple Levenshtein distance implementation.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Use two-row optimization to save memory
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[b.length]
}
