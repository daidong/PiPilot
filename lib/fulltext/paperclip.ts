/**
 * Paperclip MCP client — fetch full-text via the hosted MCP server.
 *
 * https://paperclip.gxl.ai/mcp speaks JSON-RPC 2.0 / MCP 2025-03-26 and
 * exposes ONE tool, `paperclip(command: string)`, which interprets shell-like
 * commands. We use:
 *
 *   lookup pmc <id>                 → resolve canonical ID + meta
 *   lookup doi <doi>                → resolve canonical ID + meta
 *   ls /papers/<id>/sections/       → list section files
 *   cat /papers/<id>/meta.json      → JSON metadata
 *   cat /papers/<id>/content.lines  → full body, line-numbered
 *   cat /papers/<id>/sections/<N>.lines → one section
 *
 * Auth: `X-API-Key: <token>` header. Token comes from PAPERCLIP_API_KEY env.
 *
 * On any failure (no key, network, 4xx/5xx, parse error, paper not in
 * corpus) returns null so the caller falls through to arXiv. Errors are
 * logged but never thrown.
 */

import {
  paperclipConvertedPath,
  fileMtimeIso,
  writePaperclipConverted,
  writePaperclipRaw,
  writePaperclipSectionList,
} from './cache.js'
import { existsSync, readFileSync } from 'fs'

const MCP_URL = 'https://paperclip.gxl.ai/mcp'
const NETWORK_TIMEOUT_MS = 20_000

// `cat` triggers Paperclip's auto-summary mode (~1000 char preview with a
// `[~XXXX tokens total, showing first ~YYYY chars]` header). `head -N` returns
// raw bytes. We use head everywhere for the wiki + agent paths so we can read
// full content; the safety upper bound is HEAD_LINE_CAP and head stops at EOF.
const HEAD_LINE_CAP = 100_000

// Sections that are pure metadata or already covered by the wiki page header
// — skip during section-aware assembly to avoid wasting tokens repeating
// authors / affiliations / keywords. Abstract is also already injected into
// the wiki prompt by buildPaperUserContent, so skipping it here keeps the
// "Full Text" section focused on body content.
const SKIP_SECTIONS = new Set([
  'Title',
  'Metadata',
  'Authors',
  'Affiliations',
  'Categories',
  'Keywords',
  'Abstract',
])

// Skip section bodies shorter than this — usually heading-only stubs that
// Paperclip's parser couldn't extract real content for.
const MIN_SECTION_BYTES = 80

// ── Rate gate + defensive observability ────────────────────────────────────
// Bumped to 30 req/s (≈33 ms between calls) to support per-section fetching
// (a single paper can need 25-35 cat calls). Paperclip's actual server-side
// limit isn't documented; the logging below captures empirical data so we
// can tune this number if 429s start showing up.

const RATE_LIMIT_MS = 33   // ~30 req/s
let nextAllowedAt = 0

// Rolling 1-second request log — used to annotate 429 events with how many
// requests we sent in the moments leading up to the throttle.
const recentRequests: number[] = []
function recordRequest(): void {
  const now = Date.now()
  recentRequests.push(now)
  // Drop entries older than 5 seconds — we only need a short rolling window
  // to characterize rate-at-throttle.
  while (recentRequests.length > 0 && now - recentRequests[0] > 5_000) {
    recentRequests.shift()
  }
}
function requestsInLastMs(windowMs: number): number {
  const cutoff = Date.now() - windowMs
  let count = 0
  for (let i = recentRequests.length - 1; i >= 0; i--) {
    if (recentRequests[i] < cutoff) break
    count++
  }
  return count
}

async function waitRate(): Promise<number> {
  const now = Date.now()
  let waited = 0
  if (now < nextAllowedAt) {
    waited = nextAllowedAt - now
    await new Promise(resolve => setTimeout(resolve, waited))
  }
  nextAllowedAt = Date.now() + RATE_LIMIT_MS
  recordRequest()
  return waited
}

// ── In-process disable flag (tripped on auth failure) ──────────────────────

let disabledForSession = false
function isDisabled(): boolean {
  return disabledForSession || !apiKey()
}
function apiKey(): string | null {
  const k = (process.env.PAPERCLIP_API_KEY || '').trim()
  return k || null
}

// ── Low-level MCP call ─────────────────────────────────────────────────────

interface McpTextResult {
  text: string | null
  isError: boolean
}

async function mcpCall(command: string): Promise<McpTextResult | null> {
  const key = apiKey()
  if (!key) return null

  const waited = await waitRate()
  const t0 = Date.now()

  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'paperclip',
      arguments: { command },
    },
  }

  // Truncate the logged command for grep-friendliness — full body is in the
  // network/server logs if we ever need it.
  const cmdShort = command.length > 80 ? command.slice(0, 77) + '...' : command

  let res: Response
  try {
    res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
  } catch (err) {
    console.warn(
      `[paperclip] network error after ${Date.now() - t0}ms (waited ${waited}ms): ${err instanceof Error ? err.message : String(err)} | cmd: ${cmdShort}`,
    )
    return null
  }

  const elapsed = Date.now() - t0

  if (res.status === 401 || res.status === 403) {
    console.warn(
      `[paperclip] auth rejected (HTTP ${res.status}) — disabling Paperclip source for this process lifetime | cmd: ${cmdShort}`,
    )
    disabledForSession = true
    return null
  }
  if (res.status === 429) {
    // Server-side rate limit hit. Surface the empirical rate that triggered
    // the throttle so we can tune RATE_LIMIT_MS. NOTE: this is the most
    // important defensive log — if you see this, our client-side rate is
    // too aggressive for the actual server policy.
    const inLast1s = requestsInLastMs(1_000)
    const inLast5s = requestsInLastMs(5_000)
    console.warn(
      `[paperclip] 429 RATE-LIMITED — sent ${inLast1s} req in last 1s, ${inLast5s} in last 5s ` +
      `(client-side limit is currently ~${Math.round(1000 / RATE_LIMIT_MS)} req/s). ` +
      `Consider raising RATE_LIMIT_MS in lib/fulltext/paperclip.ts. | cmd: ${cmdShort}`,
    )
    return null
  }
  if (!res.ok) {
    console.warn(
      `[paperclip] HTTP ${res.status} after ${elapsed}ms | cmd: ${cmdShort}`,
    )
    return null
  }

  let json: any
  try {
    json = await res.json()
  } catch (err) {
    console.warn(
      `[paperclip] response parse error after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)} | cmd: ${cmdShort}`,
    )
    return null
  }

  // Slow-call observability: server-side latency >5s is a signal worth
  // surfacing without spamming for normal calls.
  if (elapsed > 5_000) {
    console.warn(`[paperclip] slow call (${elapsed}ms) | cmd: ${cmdShort}`)
  }

  const result = json?.result ?? {}
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.find((c: any) => c?.type === 'text')?.text ?? null
  return { text, isError: !!result.isError }
}

// ── Lookup parsing ─────────────────────────────────────────────────────────

interface LookupHit {
  paperclipId: string
  source: string
  date?: string
  title: string
  authors?: string
  doi?: string
}

/**
 * Parse the formatted output of `lookup ...`. Format (one entry):
 *
 *   Found N papers
 *
 *     1. <title>
 *        <authors>
 *        <paperclip-id> · <source-name> · <date>
 *        https://doi.org/<doi>          (optional)
 */
function parseLookupOutput(text: string): LookupHit | null {
  const lines = text.split('\n').map(l => l)
  // Find the first numbered entry "  1. <title>"
  let idx = lines.findIndex(l => /^\s*1\.\s/.test(l))
  if (idx < 0) return null
  const titleLine = lines[idx].replace(/^\s*1\.\s+/, '').trim()
  if (!titleLine) return null

  const next = (offset: number): string => (lines[idx + offset] || '').trim()
  const authors = next(1)
  const idLine = next(2)              // "<id> · <source> · <date>"
  const doiLine = next(3)             // "https://doi.org/..." OR ""

  const idParts = idLine.split('·').map(s => s.trim())
  if (idParts.length < 2) return null
  const paperclipId = idParts[0]
  const source = idParts[1] || 'unknown'
  const date = idParts[2]

  const doiMatch = doiLine.match(/doi\.org\/(.+)$/i)
  const doi = doiMatch ? doiMatch[1].trim() : undefined

  return { paperclipId, source, date, title: titleLine, authors, doi }
}

// ── meta.json parsing ──────────────────────────────────────────────────────

interface MetaJson {
  document_id?: string
  pmc_id?: string
  pmid?: string
  doi?: string
  title?: string
  authors?: string
  abstract?: string
  abstract_text?: string
  journal?: string
  journal_title?: string
  pub_year?: number
  year?: number
  pub_date?: string
  source?: string
  categories?: string[]
  keywords?: string[]
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text.trim()) as T
  } catch {
    return null
  }
}

// ── Public: resolve and fetch ──────────────────────────────────────────────

export interface PaperclipFetchInput {
  doi?: string
  pmcId?: string
  arxivId?: string
  /** Optional: only fetch these named sections (fuzzy-matched). */
  sections?: string[]
}

export interface PaperclipFetchResult {
  paperclipId: string
  /** Markdown — either content.lines verbatim, or concatenated requested sections. */
  markdown: string
  cachePath: string
  fetchedAt: string
  sections?: Record<string, string>
  sectionList?: string[]
  /** Set when Paperclip's lookup returned a PMC ID we didn't have. */
  resolvedPmcId?: string
  meta?: MetaJson
}

/**
 * Try to resolve a paper in Paperclip's corpus and fetch its full text.
 * Returns null on any failure or miss. Never throws.
 */
export async function fetchPaperclipFulltext(
  input: PaperclipFetchInput,
): Promise<PaperclipFetchResult | null> {
  if (isDisabled()) return null

  // Step 1: resolve a paperclipId via lookup. Try strongest ID first.
  let paperclipId: string | null = null
  let lookupHit: LookupHit | null = null

  if (input.pmcId) {
    const r = await mcpCall(`lookup pmc ${input.pmcId}`)
    if (r?.text) lookupHit = parseLookupOutput(r.text)
  }
  if (!lookupHit && input.doi) {
    // Escape inner quotes; Paperclip's shell parser is forgiving.
    const safeDoi = input.doi.replace(/"/g, '\\"')
    const r = await mcpCall(`lookup doi ${safeDoi}`)
    if (r?.text) lookupHit = parseLookupOutput(r.text)
  }
  if (!lookupHit && input.arxivId) {
    // Paperclip does not have an `arxiv` lookup field; their corpus uses
    // arXiv IDs prefixed `arx_` but lookup is by DOI/title only. Skip.
    // (We rely on arxiv.ts as the fallback for arXiv-only papers.)
    return null
  }
  if (!lookupHit) return null
  paperclipId = lookupHit.paperclipId

  // Cache short-circuit (paperclipPath uses the source's canonical ID,
  // which we now have). Skip when specific sections were requested — the
  // cached file is the concatenated body and we cannot split it back into
  // named sections without re-fetching the section files.
  //
  // Also invalidate caches that look like the legacy `cat` truncated preview
  // ("[~XXXX tokens total, showing first ~YYYY chars]" header) — those were
  // written before we switched to `head -N` and are dramatically thinner
  // than what the new path produces.
  const wantsSections = !!(input.sections && input.sections.length > 0)
  const cachedPath = paperclipConvertedPath(paperclipId)
  if (!wantsSections && existsSync(cachedPath)) {
    try {
      const cached = readFileSync(cachedPath, 'utf-8')
      const looksTruncated = /^\[~\d+\s+tokens total,\s+showing first/i.test(cached.trim())
      if (cached && cached.trim().length > 100 && !looksTruncated) {
        return {
          paperclipId,
          markdown: cached,
          cachePath: cachedPath,
          fetchedAt: fileMtimeIso(cachedPath),
          resolvedPmcId: paperclipId.startsWith('PMC') ? paperclipId : undefined,
        }
      }
      if (looksTruncated) {
        console.warn(
          `[paperclip] cache invalidated — found legacy ~1000-char preview at ${cachedPath}; re-fetching with head -N`,
        )
      }
    } catch {
      // fall through to re-fetch
    }
  }

  // Step 2: meta.json (best-effort, for surfaced metadata).
  // `head -N` instead of `cat` to bypass Paperclip's auto-summary mode.
  // meta.json is small so HEAD_LINE_CAP is dramatically more than needed,
  // but `head` always stops at EOF.
  let meta: MetaJson | undefined
  {
    const r = await mcpCall(`head -${HEAD_LINE_CAP} /papers/${paperclipId}/meta.json`)
    if (r?.text) {
      const parsed = safeJson<MetaJson>(r.text)
      if (parsed) meta = parsed
    }
  }

  // Step 3: section list (always — used both for default response and fuzzy
  // match below).
  let sectionList: string[] | undefined
  {
    const r = await mcpCall(`ls /papers/${paperclipId}/sections/`)
    if (r?.text) {
      sectionList = parseLsOutput(r.text)
      if (sectionList.length > 0) {
        try {
          writePaperclipSectionList(paperclipId, sectionList)
        } catch { /* ignore */ }
      }
    }
  }

  // Step 4: body. Three modes:
  //   A. caller asked for specific sections → fuzzy-match + fetch each
  //   B. caller didn't specify, but a section list exists → assemble
  //      section-aware markdown (the Wiki indexer's path; gives the LLM
  //      explicit `## Section` headers instead of flat prose)
  //   C. no section list available → fall back to content.lines via head
  let body: string | null = null
  let sections: Record<string, string> | undefined

  if (input.sections && input.sections.length > 0 && sectionList && sectionList.length > 0) {
    // Mode A: targeted sections.
    sections = {}
    for (const requested of input.sections) {
      const matched = fuzzyMatchSection(requested, sectionList)
      if (!matched) continue
      // Section names often contain spaces (e.g. "Online Methods"); the
      // Paperclip shell parser splits unquoted arguments on whitespace.
      // Wrap the path in double quotes so the section file resolves.
      const r = await mcpCall(`head -${HEAD_LINE_CAP} "/papers/${paperclipId}/sections/${matched}.lines"`)
      if (r?.text) {
        const stripped = stripLineNumbers(r.text)
        if (stripped.trim().length >= MIN_SECTION_BYTES) {
          sections[matched] = stripped
        }
      }
    }
    body = Object.entries(sections)
      .map(([name, text]) => `## ${name}\n\n${text}`)
      .join('\n\n')

    // Fallback: if no requested sections matched OR all section fetches
    // produced empty/heading-stub content, return the assembled full body
    // (Mode B) so the caller still gets something useful.
    if (!body || body.trim().length < 100) {
      body = await assembleSectionAwareBody(paperclipId, sectionList)
      if (!body) {
        const r = await mcpCall(`head -${HEAD_LINE_CAP} /papers/${paperclipId}/content.lines`)
        if (r?.text) body = stripLineNumbers(r.text)
      }
    }
  } else if (sectionList && sectionList.length > 0) {
    // Mode B: section-aware assembly — the wiki indexer's default path.
    body = await assembleSectionAwareBody(paperclipId, sectionList)

    // Fallback to flat content.lines if section assembly produced too
    // little (e.g. all sections were heading stubs).
    if (!body || body.trim().length < 100) {
      const r = await mcpCall(`head -${HEAD_LINE_CAP} /papers/${paperclipId}/content.lines`)
      if (r?.text) body = stripLineNumbers(r.text)
    }
  } else {
    // Mode C: no section structure available — flat body.
    const r = await mcpCall(`head -${HEAD_LINE_CAP} /papers/${paperclipId}/content.lines`)
    if (r?.text) body = stripLineNumbers(r.text)
  }

  if (!body || body.trim().length < 100) return null

  // Step 5: cache + return.
  let cachePath: string
  try {
    cachePath = writePaperclipConverted(paperclipId, body)
    if (meta) writePaperclipRaw(paperclipId, meta)
  } catch (err) {
    console.warn(`[paperclip] cache write failed: ${err instanceof Error ? err.message : String(err)}`)
    cachePath = paperclipConvertedPath(paperclipId)
  }

  return {
    paperclipId,
    markdown: body,
    cachePath,
    fetchedAt: new Date().toISOString(),
    sections,
    sectionList,
    resolvedPmcId: paperclipId.startsWith('PMC') ? paperclipId : (meta?.pmc_id ?? undefined),
    meta,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the output of `ls /papers/<id>/sections/`. Paperclip prints names
 * separated by 2+ spaces, with an optional trailing notice line.
 */
function parseLsOutput(text: string): string[] {
  const tokens: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('(') || line.startsWith('ERR')) continue  // notice / error lines
    // Section file names end in `.lines` per Paperclip convention.
    for (const tok of line.split(/\s{2,}/)) {
      const name = tok.trim().replace(/\.lines$/, '')
      if (name) tokens.push(name)
    }
  }
  return tokens
}

/**
 * Strip `L<n>: ` prefixes that Paperclip prepends to every line of
 * content.lines and section files. Preserves the rest of the text.
 */
function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map(l => l.replace(/^L\d+:\s?/, ''))
    .join('\n')
}

/**
 * Fuzzy-match a user-supplied section name against the actual section names
 * in the paper. Strategy: lowercase token-overlap, longest-overlap-wins.
 *
 * Examples (assuming sectionList contains "Online Methods", "Methods", "Results"):
 *   "methods"               → "Online Methods"  (or "Methods" — tie-broken by length)
 *   "online methods"        → "Online Methods"
 *   "materials and methods" → "Online Methods"  (token overlap on "methods")
 *   "discussion"            → null
 */
export function fuzzyMatchSection(requested: string, sectionList: string[]): string | null {
  const reqTokens = new Set(requested.toLowerCase().split(/\s+/).filter(Boolean))
  if (reqTokens.size === 0) return null

  let best: { name: string; overlap: number; lengthDelta: number } | null = null
  for (const name of sectionList) {
    const nameTokens = new Set(name.toLowerCase().split(/\s+/).filter(Boolean))
    let overlap = 0
    for (const t of reqTokens) if (nameTokens.has(t)) overlap++
    if (overlap === 0) continue
    const lengthDelta = Math.abs(name.length - requested.length)
    if (
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && lengthDelta < best.lengthDelta)
    ) {
      best = { name, overlap, lengthDelta }
    }
  }

  return best?.name ?? null
}

/**
 * Convenience: return only metadata + section list for a paper, without
 * fetching the body. Used by the agent tool's default metadata-only mode.
 *
 * Returns null on any failure.
 */
export async function fetchPaperclipMetadata(
  input: PaperclipFetchInput,
): Promise<{ paperclipId: string; meta?: MetaJson; sectionList: string[] } | null> {
  if (isDisabled()) return null

  let paperclipId: string | null = null
  let lookupHit: LookupHit | null = null

  if (input.pmcId) {
    const r = await mcpCall(`lookup pmc ${input.pmcId}`)
    if (r?.text) lookupHit = parseLookupOutput(r.text)
  }
  if (!lookupHit && input.doi) {
    const safeDoi = input.doi.replace(/"/g, '\\"')
    const r = await mcpCall(`lookup doi ${safeDoi}`)
    if (r?.text) lookupHit = parseLookupOutput(r.text)
  }
  if (!lookupHit) return null
  paperclipId = lookupHit.paperclipId

  let meta: MetaJson | undefined
  const metaCall = await mcpCall(`head -${HEAD_LINE_CAP} /papers/${paperclipId}/meta.json`)
  if (metaCall?.text) {
    const parsed = safeJson<MetaJson>(metaCall.text)
    if (parsed) meta = parsed
  }

  let sectionList: string[] = []
  const lsCall = await mcpCall(`ls /papers/${paperclipId}/sections/`)
  if (lsCall?.text) sectionList = parseLsOutput(lsCall.text)
  if (sectionList.length > 0) {
    try { writePaperclipSectionList(paperclipId, sectionList) } catch { /* ignore */ }
  }

  return { paperclipId, meta, sectionList }
}

// ── Section-aware assembly (Mode B) ────────────────────────────────────────

/**
 * Walk the section list, fetch each meaningful section file, and concatenate
 * as `## <Name>\n\n<body>` markdown.
 *
 * Skips structural / metadata sections (Title, Authors, Abstract, etc.) and
 * heading-only stubs (< MIN_SECTION_BYTES). Each section uses `head -N` so
 * Paperclip's auto-summary doesn't truncate. Cost: ~30 MCP calls per paper
 * for a typical biomedical paper, paced by the rate gate above.
 *
 * Returns null on total failure (no section produced usable content).
 */
async function assembleSectionAwareBody(
  paperclipId: string,
  sectionList: string[],
): Promise<string | null> {
  const parts: string[] = []
  for (const name of sectionList) {
    if (SKIP_SECTIONS.has(name)) continue
    // Some section names start with markdown markers like "**1 Supplementary
    // Methods**" (bold-wrapped headings extracted from the source PDF). They
    // are real content sections; fetch them anyway. Don't filter on shape.
    const r = await mcpCall(
      `head -${HEAD_LINE_CAP} "/papers/${paperclipId}/sections/${name}.lines"`,
    )
    if (!r?.text) continue
    const text = stripLineNumbers(r.text)
    if (text.trim().length < MIN_SECTION_BYTES) continue
    parts.push(`## ${name}\n\n${text.trim()}`)
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}
