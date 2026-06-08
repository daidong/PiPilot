/**
 * Citation resolvability (audit-graph A1).
 *
 * Pure functions: extract bibliographic identifiers (DOI / arXiv id / URL)
 * from delivered text and resolve them against the set of identifiers the
 * agent actually retrieved during the session. A high resolution rate is the
 * closest non-oracle proxy for "grounded vs. fabricated" citations — the
 * signal that catches hallucinated references the agent never actually fetched.
 *
 * Semantics: "resolved" means the cited identifier was *seen* by a retrieval
 * tool (fetch-fulltext / web_fetch / web_search / literature-search /
 * convert_document) or already lives in the project's paper library — not that
 * the source was deeply read. It answers "is this citation real?", not "did
 * the agent understand it?".
 *
 * Design:
 *   - Every identifier is reduced to a CANONICAL string so the citing side and
 *     the retrieved side match regardless of surface form: `10.1/x`,
 *     `doi:10.1/x`, and `https://doi.org/10.1/x` all canonicalize to
 *     `doi:10.1/x`; an arXiv abs/pdf URL collapses to `arxiv:2404.18021`
 *     (version suffix stripped).
 *   - Read-only and side-effect free. The projector (project.ts) owns the I/O
 *     (reading artifact content + spans) and feeds strings in here.
 */

// Negated char classes keep these linear-time (no catastrophic backtracking).
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>)\]}]+/gi
const ARXIV_BARE_RE = /arxiv\s*[:/]?\s*((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/gi
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/gi
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi

const TRAILING_PUNCT = /[.,;:)\]}>"']+$/

function stripTrailing(s: string): string {
  return s.replace(TRAILING_PUNCT, '')
}

/** `10.1234/Foo.` / `https://doi.org/10.1234/Foo` → `doi:10.1234/foo`. */
export function toCanonicalDoi(raw: string): string | null {
  const m = stripTrailing(raw.trim()).match(/10\.\d{4,9}\/\S+/i)
  if (!m) return null
  return 'doi:' + stripTrailing(m[0]).toLowerCase()
}

/** `2404.18021v2` / `hep-th/9901001` → `arxiv:2404.18021` / `arxiv:hep-th/9901001`. */
export function toCanonicalArxiv(rawId: string): string {
  const id = rawId.trim().toLowerCase().replace(/v\d+$/, '')
  return 'arxiv:' + id
}

/**
 * Canonicalize a URL. doi.org / arxiv.org URLs collapse into their `doi:` /
 * `arxiv:` forms so a citation written as a URL still matches a DOI-based
 * retrieval. Other URLs are lowercased with the fragment and trailing slash
 * dropped. Returns null only if the input isn't a usable http(s) URL.
 */
export function toCanonicalUrl(raw: string): string | null {
  const u = stripTrailing(raw.trim())
  const doiInUrl = u.match(/doi\.org\/(10\.\d{4,9}\/\S+)/i)
  if (doiInUrl) return toCanonicalDoi(doiInUrl[1]!)
  const ax = u.match(/arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})/i)
  if (ax) return toCanonicalArxiv(ax[1]!)
  if (!/^https?:\/\//i.test(u)) return null
  try {
    const parsed = new URL(u)
    parsed.hash = ''
    return 'url:' + parsed.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return 'url:' + u.toLowerCase()
  }
}

export interface ExtractedCitation {
  kind: 'doi' | 'arxiv' | 'url'
  /** First surface form seen in the text (for display / debugging). */
  raw: string
  /** Canonical id used for matching. Unique within an extract result. */
  canonical: string
}

/**
 * Extract every distinct bibliographic identifier from a blob of text.
 * Deduplicated by canonical form. Order is deterministic (first appearance).
 */
export function extractCitations(text: string): ExtractedCitation[] {
  if (!text) return []
  const found = new Map<string, ExtractedCitation>()
  const add = (kind: ExtractedCitation['kind'], raw: string, canonical: string | null): void => {
    if (canonical && !found.has(canonical)) found.set(canonical, { kind, raw, canonical })
  }

  // arXiv first (URL form, then bare) so an arxiv.org link isn't also kept as a
  // plain `url:` entry. doi.org URLs are likewise folded into `doi:` below.
  for (const m of text.matchAll(ARXIV_URL_RE)) add('arxiv', m[0], toCanonicalArxiv(m[1]!))
  for (const m of text.matchAll(ARXIV_BARE_RE)) add('arxiv', m[0], toCanonicalArxiv(m[1]!))
  for (const m of text.matchAll(DOI_RE)) add('doi', m[0], toCanonicalDoi(m[0]))
  for (const m of text.matchAll(URL_RE)) {
    const c = toCanonicalUrl(m[0])
    if (!c) continue
    add(c.startsWith('doi:') ? 'doi' : c.startsWith('arxiv:') ? 'arxiv' : 'url', m[0], c)
  }

  return [...found.values()]
}

export interface CitationResolution {
  /** Distinct identifiers cited in the text. */
  total: number
  /** How many of those were seen by a retrieval tool or in the paper library. */
  resolved: number
  /** resolved / total. null when total === 0 (no citations → no signal). */
  rate: number | null
  /** Canonical ids that were NOT retrieved (capped). The fabrication watchlist. */
  unresolved: string[]
}

/**
 * Resolve extracted citations against the retrieved-identifier set.
 * `maxUnresolved` caps the watchlist so a pathological document can't bloat the
 * graph; the counts (`total`/`resolved`) are always exact.
 */
export function resolveCitations(
  cites: ExtractedCitation[],
  retrieved: ReadonlySet<string>,
  opts: { maxUnresolved?: number } = {}
): CitationResolution {
  const max = opts.maxUnresolved ?? 25
  let resolved = 0
  const unresolved: string[] = []
  for (const c of cites) {
    if (retrieved.has(c.canonical)) resolved++
    else if (unresolved.length < max) unresolved.push(c.canonical)
  }
  const total = cites.length
  return { total, resolved, rate: total === 0 ? null : resolved / total, unresolved }
}
