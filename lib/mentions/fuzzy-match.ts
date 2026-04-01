/**
 * Fuzzy Match
 *
 * Simplified nucleo-style fuzzy scorer for mention autocomplete.
 * Supports queries like "coor" matching "coordinator.ts" or
 * "lit-search" matching "literature-search.ts".
 */

const SCORE_MATCH = 16
const BONUS_FIRST_CHAR = 8
const BONUS_BOUNDARY = 8
const BONUS_CONSECUTIVE = 4
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXT = 1

export interface ScoredResult<T> {
  item: T
  score: number
}

/**
 * Fuzzy-match items against a needle string and return the top results.
 *
 * When needle is empty, returns the first `limit` items with score 0.
 * All characters in needle must appear (in order) in the haystack for a match.
 */
export function fuzzyMatch<T>(
  items: T[],
  needle: string,
  getText: (item: T) => string,
  limit = 30
): ScoredResult<T>[] {
  if (!needle) {
    return items.slice(0, limit).map(item => ({ item, score: 0 }))
  }

  const needleLower = needle.toLowerCase()
  const results: ScoredResult<T>[] = []
  let worstInTopK = -Infinity

  for (const item of items) {
    const haystack = getText(item)
    const score = scoreMatch(needleLower, haystack.toLowerCase(), haystack)
    if (score <= 0) continue
    if (results.length >= limit && score <= worstInTopK) continue

    insertSorted(results, { item, score }, limit)
    if (results.length >= limit) {
      worstInTopK = results[results.length - 1].score
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Internal scoring
// ---------------------------------------------------------------------------

function scoreMatch(needle: string, haystackLower: string, haystack: string): number {
  let score = 0
  let ni = 0
  let consecutive = 0
  let lastMatchIdx = -1

  for (let hi = 0; hi < haystackLower.length && ni < needle.length; hi++) {
    if (haystackLower[hi] === needle[ni]) {
      score += SCORE_MATCH

      if (hi === 0) score += BONUS_FIRST_CHAR
      if (isBoundary(haystack, hi)) score += BONUS_BOUNDARY

      if (lastMatchIdx === hi - 1) {
        consecutive++
        score += BONUS_CONSECUTIVE * consecutive
      } else {
        const gap = lastMatchIdx >= 0 ? hi - lastMatchIdx - 1 : 0
        if (gap > 0) score -= PENALTY_GAP_START + PENALTY_GAP_EXT * (gap - 1)
        consecutive = 1
      }

      lastMatchIdx = hi
      ni++
    }
  }

  // All needle characters must match
  return ni === needle.length ? score : 0
}

function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true
  const prev = s.charCodeAt(i - 1)
  const cur = s.charCodeAt(i)
  // After path separator, dash, underscore, dot, or space
  if (prev === 47 /* / */ || prev === 92 /* \ */ || prev === 45 /* - */ ||
      prev === 95 /* _ */ || prev === 46 /* . */ || prev === 32 /* space */) {
    return true
  }
  // camelCase boundary: lowercase → uppercase
  if (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90) return true
  return false
}

function insertSorted<T>(arr: ScoredResult<T>[], entry: ScoredResult<T>, limit: number): void {
  // Binary search for insertion point (descending by score)
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].score >= entry.score) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  arr.splice(lo, 0, entry)
  if (arr.length > limit) arr.pop()
}
