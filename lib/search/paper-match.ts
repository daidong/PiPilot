/**
 * Paper search scoring — pure, zero-index fuzzy matcher used by the Literature
 * tab. Not a retrieval index: this is a linear O(N × tokens) scan intended for
 * ≤ a few hundred rows per keystroke.
 *
 * Matching rules (locked with design):
 *   - Normalization: NFD fold + strip diacritics, lowercase, collapse
 *     punctuation to spaces.
 *   - Token coverage:
 *       tokens.length <= 3  → every token must hit at least one field
 *       tokens.length >= 4  → at least ceil(0.7 * n) tokens must hit
 *   - Per-token score is the best single field hit for that token; the paper
 *     score is the sum across tokens.
 *
 * Weights:
 *   title:   exact word 20 / substring 10 / in-word subsequence 4 (token len >= 4)
 *   authors: first-or-last name-token prefix 10 / full-name substring 8
 *   venue:   substring 3
 *   tldr:    substring 3
 *   abstract substring 2
 *
 * Design notes:
 *   - Author prefix matches first OR last whitespace-split token of each
 *     author name, so both "Yichen Zhang" and "Zhang Yichen" answer to the
 *     query "zhang" with the high-weight prefix hit.
 *   - Title subsequence matching is bounded to a single title word. Cross-word
 *     subsequence matching was too permissive (e.g. "cats" hitting "scaling
 *     ... routing policies"). Intra-word subsequence still rescues typos like
 *     "attn" ↦ "attention".
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PaperSearchInput {
  title: string
  authors: string[]
  venue?: string
  tldr?: string
  abstract?: string
}

/** Pre-normalized paper, built once per row and reused across keystrokes. */
export interface SearchablePaper {
  normTitle: string
  titleWords: string[]          // keeps order; also indexed via titleWordSet
  titleWordSet: Set<string>
  normAuthors: string[]         // full-name normalized
  authorPrefixTokens: string[]  // first + last whitespace-split token of each author
  normVenue?: string
  normTldr?: string
  normAbstract?: string
}

export interface ScoreResult {
  score: number
  hitFields: string[]
}

// ── Normalization ──────────────────────────────────────────────────────────

/**
 * Lowercase, NFD-decompose, strip diacritical marks, and collapse any
 * non-alphanumeric runs into single spaces. Preserves word boundaries.
 */
export function normalize(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function splitWords(s: string): string[] {
  const out: string[] = []
  for (const w of s.split(' ')) if (w) out.push(w)
  return out
}

/** Pull first + last whitespace-split tokens from a normalized author name. */
function firstAndLastWords(s: string): string[] {
  const words = splitWords(s)
  if (words.length === 0) return []
  if (words.length === 1) return [words[0]]
  return words[0] === words[words.length - 1]
    ? [words[0]]
    : [words[0], words[words.length - 1]]
}

export function makeSearchable(p: PaperSearchInput): SearchablePaper {
  const normTitle = normalize(p.title || '')
  const titleWords = splitWords(normTitle)
  const normAuthors = (p.authors || []).map(a => normalize(a)).filter(Boolean)
  const prefixTokens = new Set<string>()
  for (const a of normAuthors) for (const t of firstAndLastWords(a)) prefixTokens.add(t)
  return {
    normTitle,
    titleWords,
    titleWordSet: new Set(titleWords),
    normAuthors,
    authorPrefixTokens: Array.from(prefixTokens),
    normVenue: p.venue ? normalize(p.venue) : undefined,
    normTldr: p.tldr ? normalize(p.tldr) : undefined,
    normAbstract: p.abstract ? normalize(p.abstract) : undefined,
  }
}

// ── Query tokenization ─────────────────────────────────────────────────────

/** Normalize + split the user query into search tokens (min length 2, deduped). */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of normalize(query).split(' ')) {
    if (w.length < 2) continue
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

// ── Subsequence matcher ────────────────────────────────────────────────────

/** Returns true if every character of `needle` appears in order in `hay`. */
function isSubsequence(needle: string, hay: string): boolean {
  if (needle.length === 0) return true
  if (needle.length > hay.length) return false
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay.charCodeAt(j) === needle.charCodeAt(i)) i++
  }
  return i === needle.length
}

// ── Per-token scoring ──────────────────────────────────────────────────────

/** Best-field score for a single token against a searchable paper. 0 = no hit. */
function scoreToken(token: string, p: SearchablePaper): number {
  let best = 0

  // Title: exact word (20) > substring (10) > in-word subsequence (4)
  if (p.titleWordSet.has(token)) {
    best = Math.max(best, 20)
  } else if (p.normTitle.includes(token)) {
    best = Math.max(best, 10)
  } else if (token.length >= 4) {
    for (const word of p.titleWords) {
      if (word.length >= token.length && isSubsequence(token, word)) {
        best = Math.max(best, 4)
        break
      }
    }
  }

  // Authors: first-or-last name-token prefix (10) > full-name substring (8)
  for (const pref of p.authorPrefixTokens) {
    if (pref.startsWith(token)) { best = Math.max(best, 10); break }
  }
  if (best < 8) {
    for (const full of p.normAuthors) {
      if (full.includes(token)) { best = Math.max(best, 8); break }
    }
  }

  // Venue substring (3)
  if (p.normVenue && p.normVenue.includes(token)) best = Math.max(best, 3)

  // tldr substring (3)
  if (p.normTldr && p.normTldr.includes(token)) best = Math.max(best, 3)

  // Abstract substring (2)
  if (p.normAbstract && p.normAbstract.includes(token)) best = Math.max(best, 2)

  return best
}

// ── Public scoring entry point ─────────────────────────────────────────────

/**
 * Score a paper against a pre-tokenized query.
 * Returns `null` if the paper fails the coverage rule (i.e. should be hidden).
 *
 * Coverage:
 *   tokens.length <= 3 → every token must produce a non-zero field score
 *   tokens.length >= 4 → at least ceil(0.7 * n) tokens must hit
 */
export function scorePaper(tokens: string[], p: SearchablePaper): number | null {
  if (tokens.length === 0) return 0

  let total = 0
  let hits = 0
  for (const t of tokens) {
    const s = scoreToken(t, p)
    if (s > 0) {
      hits++
      total += s
    }
  }

  const required = tokens.length <= 3 ? tokens.length : Math.ceil(0.7 * tokens.length)
  if (hits < required) return null
  return total
}
