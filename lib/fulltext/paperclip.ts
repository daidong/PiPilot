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

// ── Rate gate ──────────────────────────────────────────────────────────────
// 1 req/s — undocumented by Paperclip, so this is a polite default.
// (Spec §13 decision row 18.)

const RATE_LIMIT_MS = 1_000
let nextAllowedAt = 0

async function waitRate(): Promise<void> {
  const now = Date.now()
  if (now < nextAllowedAt) {
    await new Promise(resolve => setTimeout(resolve, nextAllowedAt - now))
  }
  nextAllowedAt = Date.now() + RATE_LIMIT_MS
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

  await waitRate()

  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'paperclip',
      arguments: { command },
    },
  }

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
    console.warn(`[paperclip] network error: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (res.status === 401 || res.status === 403) {
    console.warn('[paperclip] auth rejected — disabling Paperclip source for this process lifetime')
    disabledForSession = true
    return null
  }
  if (res.status === 429) {
    // Server-rate-limited. Wait a beat, then surface as failure (let backoff
    // handle the next pass; a single retry inline would be intrusive).
    console.warn('[paperclip] 429 rate-limited; skipping for this attempt')
    return null
  }
  if (!res.ok) {
    console.warn(`[paperclip] HTTP ${res.status} on command: ${command}`)
    return null
  }

  let json: any
  try {
    json = await res.json()
  } catch {
    return null
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
  // cached file is the concatenated content.lines body and we cannot split
  // it back into named sections without re-fetching the section files.
  const wantsSections = !!(input.sections && input.sections.length > 0)
  const cachedPath = paperclipConvertedPath(paperclipId)
  if (!wantsSections && existsSync(cachedPath)) {
    try {
      const cached = readFileSync(cachedPath, 'utf-8')
      if (cached && cached.trim().length > 100) {
        return {
          paperclipId,
          markdown: cached,
          cachePath: cachedPath,
          fetchedAt: fileMtimeIso(cachedPath),
          resolvedPmcId: paperclipId.startsWith('PMC') ? paperclipId : undefined,
        }
      }
    } catch {
      // fall through to re-fetch
    }
  }

  // Step 2: meta.json (best-effort, for surfaced metadata).
  let meta: MetaJson | undefined
  {
    const r = await mcpCall(`cat /papers/${paperclipId}/meta.json`)
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

  // Step 4: body.
  let body: string | null = null
  let sections: Record<string, string> | undefined

  if (input.sections && input.sections.length > 0 && sectionList && sectionList.length > 0) {
    sections = {}
    for (const requested of input.sections) {
      const matched = fuzzyMatchSection(requested, sectionList)
      if (!matched) continue
      // Section names often contain spaces (e.g. "Online Methods"); the
      // Paperclip shell parser splits unquoted arguments on whitespace.
      // Wrap the path in double quotes so the section file resolves.
      const r = await mcpCall(`cat "/papers/${paperclipId}/sections/${matched}.lines"`)
      if (r?.text) sections[matched] = stripLineNumbers(r.text)
    }
    body = Object.entries(sections)
      .map(([name, text]) => `## ${name}\n\n${text}`)
      .join('\n\n')

    // Fallback: if no requested sections matched OR all section fetches
    // failed, fall back to the full body so the caller still gets
    // something usable. The empty `sections` object signals to the caller
    // that no specific sections were resolved.
    if (!body || body.trim().length < 100) {
      const r = await mcpCall(`cat /papers/${paperclipId}/content.lines`)
      if (r?.text) body = stripLineNumbers(r.text)
    }
  } else {
    const r = await mcpCall(`cat /papers/${paperclipId}/content.lines`)
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
 * fetching the body. Used by the agent tool's default `mode='metadata'`.
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
  const metaCall = await mcpCall(`cat /papers/${paperclipId}/meta.json`)
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
