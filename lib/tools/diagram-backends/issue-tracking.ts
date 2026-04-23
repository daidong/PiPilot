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
 * rephrase descriptions. We use a cheap heuristic: same `kind` plus a
 * prefix-overlap on the description. It is intentionally loose — a
 * false positive just adds a harmless "preserve this" hint, while a
 * false negative at worst fails to detect a regression (the existing
 * iteration cap still stops things eventually).
 */

import type { BlockingIssue } from './types.js'

const DESC_PREFIX_LEN = 40

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Two issues are considered "the same" when they share a `kind` and
 * their descriptions overlap at the prefix. Works well for our reviewers
 * because they tend to lead with the element/panel name.
 */
export function issuesMatch(a: BlockingIssue, b: BlockingIssue): boolean {
  if (a.kind !== b.kind) return false
  const aDesc = normalise(a.description).slice(0, DESC_PREFIX_LEN)
  const bDesc = normalise(b.description).slice(0, DESC_PREFIX_LEN)
  if (!aDesc || !bDesc) return false
  return aDesc === bDesc || aDesc.startsWith(bDesc) || bDesc.startsWith(aDesc)
}

export function findMatch(
  target: BlockingIssue,
  pool: BlockingIssue[]
): BlockingIssue | undefined {
  return pool.find((candidate) => issuesMatch(target, candidate))
}

/**
 * Issues that were present in `previous` but are absent in `current` —
 * i.e. the reviewer stopped complaining about them. These are what we
 * want to tell the next edit pass to preserve.
 */
export function fixedBetween(
  previous: BlockingIssue[],
  current: BlockingIssue[]
): BlockingIssue[] {
  return previous.filter((p) => !findMatch(p, current))
}

/**
 * Issues visible in `current` that match something once marked fixed in
 * `fixedHistory` (accumulated from earlier iterations). These are
 * regressions — the model undid a previous correction.
 */
export function regressionsAgainst(
  fixedHistory: BlockingIssue[],
  current: BlockingIssue[]
): BlockingIssue[] {
  return current.filter((c) => findMatch(c, fixedHistory))
}
