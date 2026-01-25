/**
 * Recommendation Scorer - Multi-signal scoring for recommendations
 *
 * Implements a transparent, tunable scoring system for MCP servers, tools, and packs
 * with human-readable reasons and explicit signal tracking.
 */

import type { MCPServerEntry, MCPCategory, Popularity, RiskLevel } from './schemas/mcp-catalog.schema.js'
import type { ToolCatalogEntry, PackCatalogEntry } from './schemas/tool-catalog.schema.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Signal types that contribute to scoring
 */
export type SignalType =
  | 'keyword-exact'
  | 'keyword-partial'
  | 'useCase-exact'
  | 'useCase-partial'
  | 'category'
  | 'popularity'
  | 'risk'
  | 'platform'
  | 'stale'

/**
 * A single match signal with weight and context
 */
export interface MatchSignal {
  type: SignalType
  weight: number
  matched: string
  source: string
  description?: string
}

/**
 * Scored recommendation result
 */
export interface ScoredRecommendation<T> {
  entry: T
  score: number
  signals: MatchSignal[]
  reasons: string[]
}

/**
 * Scoring weights configuration
 */
export interface ScoringWeights {
  keyword: {
    exact: number
    partial: number
  }
  useCase: {
    exact: number
    partial: number
  }
  category: number
  popularity: Record<Popularity, number>
  risk: Record<RiskLevel, number>
  platform: {
    match: number
    mismatch: number
  }
  stale: number
}

// ============================================================================
// Default Weights
// ============================================================================

export const DEFAULT_WEIGHTS: ScoringWeights = {
  keyword: {
    exact: 0.40,
    partial: 0.20
  },
  useCase: {
    exact: 0.50,
    partial: 0.30
  },
  category: 0.30,
  popularity: {
    high: 0.15,
    medium: 0.05,
    low: 0
  },
  risk: {
    safe: 0,
    elevated: -0.05,
    high: -0.10
  },
  platform: {
    match: 0,
    mismatch: -0.50
  },
  stale: -0.10
}

// ============================================================================
// Tokenization
// ============================================================================

/**
 * Tokenize text into searchable words
 * Handles both English and Chinese text
 */
export function tokenize(text: string): string[] {
  // Normalize to lowercase
  const normalized = text.toLowerCase()

  // Split on whitespace and common punctuation
  const tokens: string[] = []

  // Split by spaces and punctuation for English
  const englishTokens = normalized.split(/[\s,;.!?()[\]{}'"<>\/\\|@#$%^&*+=~`]+/)

  for (const token of englishTokens) {
    if (token.length === 0) continue

    // Check if token contains Chinese characters
    if (/[\u4e00-\u9fff]/.test(token)) {
      // For mixed tokens, extract both Chinese characters and English words
      const chinese = token.match(/[\u4e00-\u9fff]+/g) || []
      const english = token.match(/[a-z0-9]+/gi) || []

      tokens.push(...chinese)
      tokens.push(...english.map(e => e.toLowerCase()))
    } else {
      // Pure English/number token
      tokens.push(token)
    }
  }

  // Deduplicate and filter empty
  return [...new Set(tokens.filter(t => t.length > 0))]
}

/**
 * Check if two strings match exactly (case-insensitive)
 */
function exactMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Check if string a contains string b or vice versa
 */
function partialMatch(a: string, b: string): boolean {
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()
  return aLower.includes(bLower) || bLower.includes(aLower)
}

// ============================================================================
// MCP Server Scoring
// ============================================================================

/**
 * Score MCP servers against a query
 *
 * @param entries - MCP server entries to score
 * @param query - User query text
 * @param options - Scoring options
 * @returns Scored results sorted by score (highest first)
 */
export function scoreMCPServers(
  entries: MCPServerEntry[],
  query: string,
  options: {
    weights?: Partial<ScoringWeights>
    minScore?: number
    limit?: number
    categoryHint?: MCPCategory
    currentPlatform?: string
  } = {}
): ScoredRecommendation<MCPServerEntry>[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const minScore = options.minScore ?? 0
  const limit = options.limit
  const currentPlatform = options.currentPlatform ?? process.platform

  const queryTokens = tokenize(query)

  const results: ScoredRecommendation<MCPServerEntry>[] = []

  for (const entry of entries) {
    const signals: MatchSignal[] = []

    // --- Keyword matching ---
    for (const keyword of entry.keywords) {
      for (const token of queryTokens) {
        if (exactMatch(keyword, token)) {
          signals.push({
            type: 'keyword-exact',
            weight: weights.keyword.exact,
            matched: keyword,
            source: token,
            description: `Exact keyword match: "${keyword}"`
          })
        } else if (partialMatch(keyword, token)) {
          signals.push({
            type: 'keyword-partial',
            weight: weights.keyword.partial,
            matched: keyword,
            source: token,
            description: `Partial keyword match: "${keyword}" ~ "${token}"`
          })
        }
      }
    }

    // --- Use case matching ---
    for (const useCase of entry.useCases) {
      const useCaseTokens = tokenize(useCase)
      for (const ucToken of useCaseTokens) {
        for (const token of queryTokens) {
          if (exactMatch(ucToken, token)) {
            signals.push({
              type: 'useCase-exact',
              weight: weights.useCase.exact,
              matched: useCase,
              source: token,
              description: `Matches use case: "${useCase}"`
            })
            break // One match per use case is enough
          } else if (partialMatch(ucToken, token)) {
            signals.push({
              type: 'useCase-partial',
              weight: weights.useCase.partial,
              matched: useCase,
              source: token,
              description: `Partially matches use case: "${useCase}"`
            })
            break
          }
        }
      }
    }

    // --- Category hint ---
    if (options.categoryHint && entry.category === options.categoryHint) {
      signals.push({
        type: 'category',
        weight: weights.category,
        matched: entry.category,
        source: 'categoryHint',
        description: `Matches requested category: ${entry.category}`
      })
    }

    // --- Popularity bonus ---
    const popularityWeight = weights.popularity[entry.popularity]
    if (popularityWeight > 0) {
      signals.push({
        type: 'popularity',
        weight: popularityWeight,
        matched: entry.popularity,
        source: 'popularity',
        description: entry.popularity === 'high' ? 'Popular choice' : 'Moderately popular'
      })
    }

    // --- Risk penalty ---
    const riskWeight = weights.risk[entry.riskLevel]
    if (riskWeight < 0) {
      signals.push({
        type: 'risk',
        weight: riskWeight,
        matched: entry.riskLevel,
        source: 'riskLevel',
        description: `${entry.riskLevel} risk level`
      })
    }

    // --- Platform check ---
    if (entry.platform && entry.platform.length > 0) {
      if (!entry.platform.includes(currentPlatform as 'darwin' | 'linux' | 'win32')) {
        signals.push({
          type: 'platform',
          weight: weights.platform.mismatch,
          matched: entry.platform.join(', '),
          source: currentPlatform,
          description: `Not available on ${currentPlatform}`
        })
      }
    }

    // --- Stale check ---
    if (entry.lastVerified) {
      const verifiedDate = new Date(entry.lastVerified)
      const daysSince = (Date.now() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince > 90) {
        signals.push({
          type: 'stale',
          weight: weights.stale,
          matched: entry.lastVerified,
          source: 'lastVerified',
          description: `Not verified recently (${Math.floor(daysSince)} days ago)`
        })
      }
    }

    // --- Calculate total score ---
    // Only count entries with at least one positive signal
    const positiveSignals = signals.filter(s => s.weight > 0)
    if (positiveSignals.length === 0) continue

    // Sum weights, but cap keyword and useCase contributions to avoid runaway scores
    let score = 0
    const keywordScore = signals
      .filter(s => s.type.startsWith('keyword'))
      .reduce((sum, s) => sum + s.weight, 0)
    const useCaseScore = signals
      .filter(s => s.type.startsWith('useCase'))
      .reduce((sum, s) => sum + s.weight, 0)
    const otherScore = signals
      .filter(s => !s.type.startsWith('keyword') && !s.type.startsWith('useCase'))
      .reduce((sum, s) => sum + s.weight, 0)

    // Cap keyword and useCase scores to prevent inflation from many matches
    score = Math.min(keywordScore, 0.8) + Math.min(useCaseScore, 1.0) + otherScore

    // Normalize to 0-1 range (roughly)
    score = Math.max(0, Math.min(1, score))

    if (score < minScore) continue

    // Generate human-readable reasons
    const reasons = generateReasons(signals)

    results.push({
      entry,
      score,
      signals,
      reasons
    })
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  // Apply limit
  if (limit && results.length > limit) {
    return results.slice(0, limit)
  }

  return results
}

// ============================================================================
// Tool Scoring
// ============================================================================

/**
 * Score tools against a query
 */
export function scoreTools(
  entries: ToolCatalogEntry[],
  query: string,
  options: {
    weights?: Partial<ScoringWeights>
    minScore?: number
    limit?: number
  } = {}
): ScoredRecommendation<ToolCatalogEntry>[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const minScore = options.minScore ?? 0
  const limit = options.limit

  const queryTokens = tokenize(query)
  const results: ScoredRecommendation<ToolCatalogEntry>[] = []

  for (const entry of entries) {
    const signals: MatchSignal[] = []

    // Keyword matching
    for (const keyword of entry.keywords) {
      for (const token of queryTokens) {
        if (exactMatch(keyword, token)) {
          signals.push({
            type: 'keyword-exact',
            weight: weights.keyword.exact,
            matched: keyword,
            source: token,
            description: `Exact keyword match: "${keyword}"`
          })
        } else if (partialMatch(keyword, token)) {
          signals.push({
            type: 'keyword-partial',
            weight: weights.keyword.partial,
            matched: keyword,
            source: token,
            description: `Partial keyword match: "${keyword}" ~ "${token}"`
          })
        }
      }
    }

    // Use case matching
    for (const useCase of entry.useCases) {
      const useCaseTokens = tokenize(useCase)
      for (const ucToken of useCaseTokens) {
        for (const token of queryTokens) {
          if (exactMatch(ucToken, token)) {
            signals.push({
              type: 'useCase-exact',
              weight: weights.useCase.exact,
              matched: useCase,
              source: token,
              description: `Matches use case: "${useCase}"`
            })
            break
          } else if (partialMatch(ucToken, token)) {
            signals.push({
              type: 'useCase-partial',
              weight: weights.useCase.partial,
              matched: useCase,
              source: token,
              description: `Partially matches use case: "${useCase}"`
            })
            break
          }
        }
      }
    }

    // Risk penalty
    const riskWeight = weights.risk[entry.riskLevel]
    if (riskWeight < 0) {
      signals.push({
        type: 'risk',
        weight: riskWeight,
        matched: entry.riskLevel,
        source: 'riskLevel',
        description: `${entry.riskLevel} risk level`
      })
    }

    // Calculate score
    const positiveSignals = signals.filter(s => s.weight > 0)
    if (positiveSignals.length === 0) continue

    let score = 0
    const keywordScore = signals
      .filter(s => s.type.startsWith('keyword'))
      .reduce((sum, s) => sum + s.weight, 0)
    const useCaseScore = signals
      .filter(s => s.type.startsWith('useCase'))
      .reduce((sum, s) => sum + s.weight, 0)
    const otherScore = signals
      .filter(s => !s.type.startsWith('keyword') && !s.type.startsWith('useCase'))
      .reduce((sum, s) => sum + s.weight, 0)

    score = Math.min(keywordScore, 0.8) + Math.min(useCaseScore, 1.0) + otherScore
    score = Math.max(0, Math.min(1, score))

    if (score < minScore) continue

    const reasons = generateReasons(signals)

    results.push({
      entry,
      score,
      signals,
      reasons
    })
  }

  results.sort((a, b) => b.score - a.score)

  if (limit && results.length > limit) {
    return results.slice(0, limit)
  }

  return results
}

// ============================================================================
// Pack Scoring
// ============================================================================

/**
 * Score packs against a query
 */
export function scorePacks(
  entries: PackCatalogEntry[],
  query: string,
  options: {
    weights?: Partial<ScoringWeights>
    minScore?: number
    limit?: number
  } = {}
): ScoredRecommendation<PackCatalogEntry>[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const minScore = options.minScore ?? 0
  const limit = options.limit

  const queryTokens = tokenize(query)
  const results: ScoredRecommendation<PackCatalogEntry>[] = []

  for (const entry of entries) {
    const signals: MatchSignal[] = []

    // Keyword matching
    for (const keyword of entry.keywords) {
      for (const token of queryTokens) {
        if (exactMatch(keyword, token)) {
          signals.push({
            type: 'keyword-exact',
            weight: weights.keyword.exact,
            matched: keyword,
            source: token,
            description: `Exact keyword match: "${keyword}"`
          })
        } else if (partialMatch(keyword, token)) {
          signals.push({
            type: 'keyword-partial',
            weight: weights.keyword.partial,
            matched: keyword,
            source: token,
            description: `Partial keyword match: "${keyword}" ~ "${token}"`
          })
        }
      }
    }

    // Risk penalty
    const riskWeight = weights.risk[entry.riskLevel]
    if (riskWeight < 0) {
      signals.push({
        type: 'risk',
        weight: riskWeight,
        matched: entry.riskLevel,
        source: 'riskLevel',
        description: `${entry.riskLevel} risk level`
      })
    }

    // Calculate score
    const positiveSignals = signals.filter(s => s.weight > 0)
    if (positiveSignals.length === 0) continue

    let score = signals.reduce((sum, s) => sum + s.weight, 0)
    score = Math.max(0, Math.min(1, score))

    if (score < minScore) continue

    const reasons = generateReasons(signals)

    results.push({
      entry,
      score,
      signals,
      reasons
    })
  }

  results.sort((a, b) => b.score - a.score)

  if (limit && results.length > limit) {
    return results.slice(0, limit)
  }

  return results
}

// ============================================================================
// Reason Generation
// ============================================================================

/**
 * Generate human-readable reasons from signals
 */
function generateReasons(signals: MatchSignal[]): string[] {
  const reasons: string[] = []
  const seenDescriptions = new Set<string>()

  // Prioritize positive signals
  const sortedSignals = [...signals].sort((a, b) => b.weight - a.weight)

  for (const signal of sortedSignals) {
    if (!signal.description) continue
    if (seenDescriptions.has(signal.description)) continue

    seenDescriptions.add(signal.description)

    // Only include up to 3 reasons for clarity
    if (reasons.length < 3) {
      reasons.push(signal.description)
    }
  }

  return reasons
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a scored result for display
 */
export function formatScoredResult<T extends { name: string }>(
  result: ScoredRecommendation<T>
): string {
  const scorePercent = Math.round(result.score * 100)
  const reasonList = result.reasons.length > 0
    ? result.reasons.map(r => `  - ${r}`).join('\n')
    : '  - General match'

  return `${result.entry.name} (${scorePercent}% match)\n${reasonList}`
}
