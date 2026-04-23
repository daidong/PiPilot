/**
 * Issue-tracking helpers for the iteration loop.
 *
 * Two relationships across iterations matter:
 *   - "Fixed" — an issue present in iter N that the reviewer no longer
 *     reports in iter N+1. Those are the fixes we want to **preserve**
 *     against regression in subsequent edits.
 *   - "Regressed" — an issue present in iter N+1 that had previously
 *     been marked "fixed" (i.e. appeared in some iter < N and
 *     disappeared by iter N). Regressions are evidence that further
 *     editing is making the diagram worse, not better.
 *
 * Matching across iterations is inexact because the reviewer may
 * - rephrase descriptions ("run together" → "collide"),
 * - re-bucket the issue kind (style_mismatch → layout_collision),
 * - shorten or expand surrounding text.
 *
 * Strategy (layered, cheap → expensive, conservative on false positives):
 *
 *   1. Kind bucket. Some kinds are substantively the same problem
 *      seen from different angles — group them into visual/content
 *      buckets so reviewer drift between e.g. `style_mismatch` and
 *      `layout_collision` does not break matching.
 *
 *   2. Panel disambiguation. If both descriptions mention "Panel N"
 *      references, at least one panel number must overlap; otherwise
 *      they are talking about different parts of the figure.
 *
 *   3. Description similarity. Exact prefix first (fast), then a token
 *      overlap fallback (≥5 shared distinctive tokens AND Jaccard
 *      ≥ 0.2) to catch reviewer rephrasing without inviting generic-
 *      phrase false matches.
 *
 * False positive consequences are bounded: an incorrectly-matched pair
 * means (a) we surface a harmless extra "preserve this" hint in the
 * next edit prompt, or (b) we early-stop one iteration sooner than
 * strictly necessary. False negatives just miss a regression — the
 * iteration cap still halts eventually.
 */

import type { BlockingIssue, BlockingIssueKind } from './types.js'

const KIND_BUCKET: Record<BlockingIssueKind, 'visual' | 'content'> = {
  layout_collision: 'visual',
  style_mismatch: 'visual',
  illegible_text: 'visual',
  missing_element: 'content',
  wrong_content: 'content',
}

const PREFIX_LEN = 20
const MIN_SHARED_TOKENS = 5
const MIN_JACCARD = 0.2

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Extract "Panel N" references so unrelated issues on different panels don't merge. */
function panelNumbers(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of normalise(s).matchAll(/panel\s+(\d+)/g)) out.add(m[1])
  return out
}

/** Tokens ≥ 4 chars, punctuation stripped. Short words (the/and/for/etc.) are dropped. */
function distinctiveTokens(s: string): Set<string> {
  return new Set(
    normalise(s)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  )
}

export function issuesMatch(a: BlockingIssue, b: BlockingIssue): boolean {
  // (1) Same substantive category (with drift tolerance across kinds).
  if (KIND_BUCKET[a.kind] !== KIND_BUCKET[b.kind]) return false

  // (2) Panel disambiguation. If both descriptions explicitly reference
  // panel numbers, they must share at least one — otherwise they are
  // about different parts of the figure.
  const panelsA = panelNumbers(a.description)
  const panelsB = panelNumbers(b.description)
  if (panelsA.size > 0 && panelsB.size > 0) {
    let hasShared = false
    for (const p of panelsA) {
      if (panelsB.has(p)) {
        hasShared = true
        break
      }
    }
    if (!hasShared) return false
  }

  // (3) Description similarity — prefix fast path, token fallback.
  const aDesc = normalise(a.description)
  const bDesc = normalise(b.description)
  if (!aDesc || !bDesc) return false

  const prefixLen = Math.min(PREFIX_LEN, aDesc.length, bDesc.length)
  if (prefixLen >= 10 && aDesc.slice(0, prefixLen) === bDesc.slice(0, prefixLen)) {
    return true
  }

  const aTokens = distinctiveTokens(a.description)
  const bTokens = distinctiveTokens(b.description)
  let shared = 0
  for (const t of aTokens) if (bTokens.has(t)) shared++
  if (shared < MIN_SHARED_TOKENS) return false
  const union = aTokens.size + bTokens.size - shared
  if (union === 0) return false
  return shared / union >= MIN_JACCARD
}

export function findMatch(
  target: BlockingIssue,
  pool: BlockingIssue[],
): BlockingIssue | undefined {
  return pool.find((candidate) => issuesMatch(target, candidate))
}

/**
 * Issues present in `previous` but absent in `current` — i.e. the reviewer
 * stopped complaining about them. These are what we want the next edit
 * pass to preserve.
 */
export function fixedBetween(
  previous: BlockingIssue[],
  current: BlockingIssue[],
): BlockingIssue[] {
  return previous.filter((p) => !findMatch(p, current))
}

/**
 * Issues visible in `current` that match something previously marked as
 * fixed. These are regressions — the model undid a previous correction.
 */
export function regressionsAgainst(
  fixedHistory: BlockingIssue[],
  current: BlockingIssue[],
): BlockingIssue[] {
  return current.filter((c) => findMatch(c, fixedHistory))
}
