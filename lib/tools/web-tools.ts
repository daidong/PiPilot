/**
 * Web tools for Research Copilot: search + fetch.
 *
 * Adapted from myRAM's web-tools.ts with these changes:
 * - Removed globalEmitter, buildFilePointer, getRuntimeSettings()
 * - Removed .ram/ file persistence (tool outputs stay in-memory)
 * - Uses our ResearchToolContext + toAgentResult infrastructure
 * - Hardcoded sensible defaults instead of runtime-settings
 */

import { createHash } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError, truncateHeadTail, type ToolResult } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WebSearchProvider = 'auto' | 'brave' | 'arxiv'

interface SearchResult {
  title: string
  url: string
  snippet: string
  published?: string
  source: 'brave' | 'arxiv'
}

// ---------------------------------------------------------------------------
// Defaults (replaces getRuntimeSettings().tools.web)
// ---------------------------------------------------------------------------

const WEB_DEFAULTS = {
  braveMinIntervalMs: 200,
  arxivMinIntervalMs: 3_000,     // arXiv asks for >= 3s between requests
  braveMaxRetries: 2,
  braveRetryBaseMs: 1_000,
  arxivMaxRetries: 2,
  arxivRetryBaseMs: 3_000,
  maxRetryDelayMs: 30_000,
  defaultSearchCount: 5,
  maxSearchCount: 10,
  defaultFetchMaxChars: 50_000,
  maxFetchMaxChars: 200_000,
  defaultFetchTimeoutMs: 30_000,
  maxArxivCacheEntries: 100,
  arxivSearchCacheTtlMs: 10 * 60 * 1000, // 10 min
  /** Content above this size is saved to disk; agent gets preview + file path */
  fetchPersistThresholdChars: 30_000,
  fetchPreviewChars: 2_000,
} as const

// ---------------------------------------------------------------------------
// Rate-limiter (serial queue with minimum interval)
// ---------------------------------------------------------------------------

class ProviderRateGate {
  private tail: Promise<void> = Promise.resolve()
  private nextAllowedAt = 0
  private minIntervalMs: number

  constructor(minIntervalMs: number) {
    this.minIntervalMs = Math.max(0, Math.floor(minIntervalMs))
  }

  setMinInterval(ms: number): void {
    if (!Number.isFinite(ms)) return
    this.minIntervalMs = Math.max(0, Math.floor(ms))
  }

  deferFor(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + Math.floor(delayMs))
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const now = Date.now()
      if (this.nextAllowedAt > now) {
        await sleep(this.nextAllowedAt - now)
      }
      try {
        return await task()
      } finally {
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + this.minIntervalMs)
      }
    }

    const queued = this.tail.then(execute, execute)
    this.tail = queued.then(() => undefined, () => undefined)
    return queued
  }
}

// ---------------------------------------------------------------------------
// Shared state (module-level singletons)
// ---------------------------------------------------------------------------

const braveGate = new ProviderRateGate(WEB_DEFAULTS.braveMinIntervalMs)
const arxivGate = new ProviderRateGate(WEB_DEFAULTS.arxivMinIntervalMs)

type CachedArxivResult = { expiresAt: number; results: SearchResult[] }
const arxivSearchCache = new Map<string, CachedArxivResult>()

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WebSearchSchema = Type.Object({
  query: Type.String({ description: 'Search query string.' }),
  count: Type.Optional(
    Type.Number({ description: 'Result count (1-10).', minimum: 1, maximum: 10 })
  ),
  provider: Type.Optional(
    Type.String({ description: 'auto | brave | arxiv (auto defaults to brave when BRAVE_API_KEY is set).' })
  ),
})

const WebFetchSchema = Type.Object({
  url: Type.String({ description: 'HTTP or HTTPS URL to fetch.' }),
  extract_mode: Type.Optional(Type.String({ description: 'text or markdown' })),
  extractMode: Type.Optional(Type.String({ description: 'Alias of extract_mode.' })),
  max_chars: Type.Optional(Type.Number({ minimum: 100 })),
  maxChars: Type.Optional(Type.Number({ minimum: 100 })),
  timeout_sec: Type.Optional(Type.Number({ minimum: 1 })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 1 })),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/?(h[1-6]|p|div|section|article|main|header|footer|li|tr|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  )
}

function parseCsvIntegerHeader(raw: string | null): number[] {
  if (!raw) return []
  return raw.split(',').map(p => Number.parseInt(p.trim(), 10)).filter(Number.isFinite)
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (!retryAfter) return undefined
  const seconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(retryAfter)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  return undefined
}

function computeBackoffMs(baseMs: number, attempt: number): number {
  const exponential = baseMs * 2 ** attempt
  const jitter = Math.floor(Math.random() * baseMs)
  return Math.min(WEB_DEFAULTS.maxRetryDelayMs, exponential + jitter)
}

function consumeResponse(response: Response): Promise<void> {
  return response.arrayBuffer().then(() => undefined, () => undefined)
}

// ---------------------------------------------------------------------------
// Brave rate-limit header handling
// ---------------------------------------------------------------------------

function applyBraveRateLimitHints(response: Response): void {
  const remainingValues = parseCsvIntegerHeader(response.headers.get('x-ratelimit-remaining'))
  const resetValues = parseCsvIntegerHeader(response.headers.get('x-ratelimit-reset'))
  const burstRemaining = remainingValues[0]
  const burstResetSec = resetValues[0]
  if (!Number.isFinite(burstResetSec) || burstResetSec <= 0) return

  const resetMs = burstResetSec * 1000
  if (Number.isFinite(burstRemaining)) {
    if (burstRemaining <= 0) {
      braveGate.deferFor(resetMs)
      return
    }
    const spacing = Math.ceil(resetMs / Math.max(1, burstRemaining))
    braveGate.setMinInterval(Math.max(100, Math.min(2_000, spacing)))
  }
}

// ---------------------------------------------------------------------------
// Rate-limited fetch with retries
// ---------------------------------------------------------------------------

async function runRateLimitedFetch(args: {
  gate: ProviderRateGate
  url: string
  init: RequestInit
  maxRetries: number
  retryBaseMs: number
  onResponse?: (response: Response) => void
}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await args.gate.run(async () => fetch(args.url, args.init))
    args.onResponse?.(response)

    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt >= args.maxRetries) return response

    const retryAfterMs = parseRetryAfterMs(response.headers)
    const backoffMs = computeBackoffMs(args.retryBaseMs, attempt)
    const delayMs = Math.max(retryAfterMs ?? 0, backoffMs)

    args.gate.deferFor(delayMs)
    await consumeResponse(response)
    await sleep(delayMs)
  }
}

// ---------------------------------------------------------------------------
// arXiv XML parsing + cache
// ---------------------------------------------------------------------------

function parseXmlTag(entry: string, tagName: string): string | undefined {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  const match = entry.match(re)
  if (!match) return undefined
  return decodeHtmlEntities(match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim())
}

function parseArxivEntries(xml: string, maxCount: number): SearchResult[] {
  const entries: SearchResult[] = []
  const entryMatches = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) ?? []
  for (const raw of entryMatches) {
    if (entries.length >= maxCount) break
    const title = parseXmlTag(raw, 'title')
    const id = parseXmlTag(raw, 'id')
    const summary = parseXmlTag(raw, 'summary')
    const published = parseXmlTag(raw, 'published')
    if (!title || !id) continue
    entries.push({
      title,
      url: id,
      snippet: (summary ?? '').replace(/\s+/g, ' ').trim(),
      published,
      source: 'arxiv',
    })
  }
  return entries
}

function getArxivCacheKey(query: string, count: number): string {
  return `${query}\u0000${count}`
}

function getArxivCachedResult(cacheKey: string): SearchResult[] | null {
  const cached = arxivSearchCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    arxivSearchCache.delete(cacheKey)
    return null
  }
  return cached.results.map(r => ({ ...r }))
}

function setArxivCachedResult(cacheKey: string, results: SearchResult[]): void {
  if (arxivSearchCache.size >= WEB_DEFAULTS.maxArxivCacheEntries) {
    const oldest = arxivSearchCache.keys().next().value
    if (oldest) arxivSearchCache.delete(oldest)
  }
  arxivSearchCache.set(cacheKey, {
    expiresAt: Date.now() + WEB_DEFAULTS.arxivSearchCacheTtlMs,
    results: results.map(r => ({ ...r })),
  })
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function runBraveSearch(query: string, count: number, apiKey: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const response = await runRateLimitedFetch({
    gate: braveGate,
    url: url.toString(),
    init: {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    maxRetries: WEB_DEFAULTS.braveMaxRetries,
    retryBaseMs: WEB_DEFAULTS.braveRetryBaseMs,
    onResponse: applyBraveRateLimitHints,
  })

  if (!response.ok) {
    const reset = parseCsvIntegerHeader(response.headers.get('x-ratelimit-reset'))[0]
    const waitHint = Number.isFinite(reset) && reset > 0 ? ` Wait about ${reset}s before retrying.` : ''
    const body = await response.text().catch(() => '')
    throw new Error(`Brave search failed (${response.status}).${waitHint} ${body.slice(0, 400)}`.trim())
  }

  const json = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> }
  }
  return (json.web?.results ?? [])
    .map(item => ({
      title: item.title?.trim() ?? '',
      url: item.url?.trim() ?? '',
      snippet: item.description?.trim() ?? '',
      published: item.age?.trim(),
      source: 'brave' as const,
    }))
    .filter(item => item.title && item.url)
    .slice(0, count)
}

async function runArxivSearch(query: string, count: number): Promise<SearchResult[]> {
  const cacheKey = getArxivCacheKey(query, count)
  const cached = getArxivCachedResult(cacheKey)
  if (cached) return cached

  const url = new URL('http://export.arxiv.org/api/query')
  url.searchParams.set('search_query', `all:${query}`)
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', String(count))
  url.searchParams.set('sortBy', 'relevance')
  url.searchParams.set('sortOrder', 'descending')

  const response = await runRateLimitedFetch({
    gate: arxivGate,
    url: url.toString(),
    init: { headers: { Accept: 'application/atom+xml' } },
    maxRetries: WEB_DEFAULTS.arxivMaxRetries,
    retryBaseMs: WEB_DEFAULTS.arxivRetryBaseMs,
  })

  if (!response.ok) {
    const waitHint =
      response.status === 429 || response.status >= 500
        ? ' Respect arXiv API limits (single connection, >=3s between requests) and retry.'
        : ''
    const body = await response.text().catch(() => '')
    throw new Error(`arXiv search failed (${response.status}).${waitHint} ${body.slice(0, 400)}`.trim())
  }

  const xml = await response.text()
  const results = parseArxivEntries(xml, count)
  setArxivCachedResult(cacheKey, results)
  return results
}

function normalizeSearchProvider(value: unknown): WebSearchProvider {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : 'auto'
  if (raw === 'brave' || raw === 'arxiv' || raw === 'auto') return raw
  return 'auto'
}

// ---------------------------------------------------------------------------
// Exported tool factories
// ---------------------------------------------------------------------------

export function createWebSearchTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web and academic sources. Uses Brave Search API when BRAVE_API_KEY is set; falls back to arXiv.',
    parameters: WebSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      if (!query) {
        return toAgentResult('web_search', toolError('MISSING_PARAMETER', 'Missing query.', {
          suggestions: ['Provide a non-empty search query string.']
        }))
      }

      const countRaw = typeof params.count === 'number' && Number.isFinite(params.count)
        ? params.count
        : undefined
      const count = typeof countRaw === 'number'
        ? Math.max(1, Math.min(WEB_DEFAULTS.maxSearchCount, Math.floor(countRaw)))
        : WEB_DEFAULTS.defaultSearchCount

      const providerRequested = normalizeSearchProvider(params.provider)
      const braveApiKey = process.env.BRAVE_API_KEY?.trim()
      let effectiveProvider: 'brave' | 'arxiv' =
        providerRequested === 'auto' ? (braveApiKey ? 'brave' : 'arxiv') : providerRequested

      let results: SearchResult[] = []
      try {
        if (effectiveProvider === 'brave') {
          if (!braveApiKey) {
            if (providerRequested === 'brave') {
              return toAgentResult('web_search', toolError('MISSING_PARAMETER',
                'BRAVE_API_KEY is required when provider=brave.', {
                suggestions: [
                  'Set BRAVE_API_KEY environment variable.',
                  'Use provider=arxiv as a fallback for academic search.',
                ]
              }))
            }
            effectiveProvider = 'arxiv'
          } else {
            results = await runBraveSearch(query, count, braveApiKey)
          }
        }
        if (effectiveProvider === 'arxiv') {
          results = await runArxivSearch(query, count)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isRateLimit = msg.includes('429')
        return toAgentResult('web_search', toolError(
          isRateLimit ? 'API_RATE_LIMITED' : 'API_ERROR',
          msg,
          {
            retryable: true,
            suggestions: isRateLimit
              ? ['Wait before retrying — the search API rate limit was hit.']
              : ['Retry the search.', 'Try provider=arxiv if Brave is unavailable.'],
            context: { provider: effectiveProvider, query }
          }
        ))
      }

      const payload = {
        provider: effectiveProvider,
        query,
        count: results.length,
        results,
      }

      return toAgentResult('web_search', {
        success: true,
        data: payload,
      })
    },
  }
}

export function createWebFetchTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a URL and extract readable text or markdown. Content over 30K chars is saved to disk — use the read tool on the returned content_path to access full content.',
    parameters: WebFetchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const urlRaw = typeof params.url === 'string' ? params.url.trim() : ''
      if (!urlRaw) {
        return toAgentResult('web_fetch', toolError('MISSING_PARAMETER', 'Missing url.', {
          suggestions: ['Provide a valid HTTP or HTTPS URL to fetch.']
        }))
      }

      let url: URL
      try {
        url = new URL(urlRaw)
      } catch {
        return toAgentResult('web_fetch', toolError('INVALID_PARAMETER', `Invalid URL: ${urlRaw}`, {
          suggestions: ['Ensure the URL is well-formed (e.g., https://example.com/page).']
        }))
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        return toAgentResult('web_fetch', toolError('INVALID_PARAMETER', 'Only http/https URLs are supported.', {
          suggestions: [`The URL uses protocol "${url.protocol}". Provide an http:// or https:// URL instead.`]
        }))
      }

      // Parse parameters with snake_case / camelCase aliases
      const extractModeRaw =
        (typeof params.extract_mode === 'string' ? params.extract_mode : undefined) ??
        (typeof params.extractMode === 'string' ? params.extractMode : undefined) ??
        'text'
      const extractMode = extractModeRaw.trim().toLowerCase() === 'markdown' ? 'markdown' : 'text'

      const maxCharsRaw =
        (typeof params.max_chars === 'number' && Number.isFinite(params.max_chars) ? params.max_chars : undefined) ??
        (typeof params.maxChars === 'number' && Number.isFinite(params.maxChars) ? params.maxChars : undefined)
      const maxChars = typeof maxCharsRaw === 'number'
        ? Math.max(100, Math.min(WEB_DEFAULTS.maxFetchMaxChars, Math.floor(maxCharsRaw)))
        : WEB_DEFAULTS.defaultFetchMaxChars

      const timeoutSecRaw =
        (typeof params.timeout_sec === 'number' && Number.isFinite(params.timeout_sec)
          ? params.timeout_sec : undefined) ??
        (typeof params.timeoutSec === 'number' && Number.isFinite(params.timeoutSec)
          ? params.timeoutSec : undefined)
      const timeoutMs = typeof timeoutSecRaw === 'number'
        ? Math.max(1_000, Math.floor(timeoutSecRaw * 1000))
        : WEB_DEFAULTS.defaultFetchTimeoutMs

      // Note: onToolCall/onToolResult are handled by coordinator hooks (beforeToolCall/afterToolCall)
      // with proper toolCallId for reliable call→result correlation. No need to self-report here.

      let response: Response
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'research-copilot-web-fetch/0.1' },
        })
      } catch (err) {
        clearTimeout(timer)
        const msg = err instanceof Error ? err.message : String(err)
        const isTimeout = msg.includes('abort')
        return toAgentResult('web_fetch', toolError(
          isTimeout ? 'NETWORK_TIMEOUT' : 'DOWNLOAD_FAILED',
          `Fetch failed: ${msg}`,
          {
            retryable: true,
            suggestions: isTimeout
              ? ['The request timed out. Try increasing timeout_sec or retry later.']
              : ['Check that the URL is accessible.', 'The server may be temporarily unavailable.'],
            context: { url: url.toString() }
          }
        ))
      } finally {
        clearTimeout(timer)
      }

      const body = await response.text()
      const contentType = response.headers.get('content-type') ?? ''
      const extracted = contentType.toLowerCase().includes('html') ? htmlToText(body) : body
      const normalized = extracted.replace(/\r\n/g, '\n').trim()
      const truncated = normalized.length > maxChars
      const sliced = truncated ? normalized.slice(0, maxChars) : normalized

      const output = extractMode === 'markdown'
        ? `# Fetched Content\n\nSource: ${url.toString()}\n\n---\n\n${sliced}`
        : sliced

      let payload: Record<string, unknown>

      if (output.length > WEB_DEFAULTS.fetchPersistThresholdChars) {
        // Large content → write to disk, return preview + path
        const hash = createHash('md5').update(url.toString() + Date.now()).digest('hex').slice(0, 12)
        const ext = extractMode === 'markdown' ? 'md' : 'txt'
        const contentDir = path.join(ctx.projectPath, 'web-content')
        await mkdir(contentDir, { recursive: true })
        const filePath = path.join(contentDir, `${hash}.${ext}`)
        await writeFile(filePath, output, 'utf-8')

        // Preview: up to 2K chars, cut at last newline for readability
        const previewRaw = output.slice(0, WEB_DEFAULTS.fetchPreviewChars)
        const lastNl = previewRaw.lastIndexOf('\n')
        const preview = (lastNl > WEB_DEFAULTS.fetchPreviewChars * 0.5
          ? previewRaw.slice(0, lastNl)
          : previewRaw) + '\n...'

        payload = {
          url: url.toString(),
          status_code: response.status,
          content_type: contentType,
          extract_mode: extractMode,
          chars: normalized.length,
          content_path: path.relative(ctx.workspacePath, filePath),
          preview,
        }
      } else {
        payload = {
          url: url.toString(),
          status_code: response.status,
          content_type: contentType,
          extract_mode: extractMode,
          chars: normalized.length,
          truncated,
          content: output || '(empty response)',
        }
      }

      return toAgentResult('web_fetch', {
        success: response.ok,
        data: payload,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      })
    },
  }
}
