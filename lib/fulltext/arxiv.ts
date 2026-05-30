/**
 * arXiv full-text — PDF download + markitdown convert.
 *
 * Logic moved verbatim from lib/wiki/downloader.ts. Reachable only via
 * resolveFulltext() in lib/fulltext/index.ts.
 *
 * Rate-limited: 3s between arXiv requests (process-global token bucket).
 * On failure: returns null — caller maps that to abstract-fallback.
 */

import { existsSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { dirname } from 'path'
import {
  arxivConvertedPath,
  arxivRawPdfPath,
  fileMtimeIso,
  writeArxivConverted,
} from './cache.js'
import { mkdirSync, readFileSync } from 'fs'

// ── Rate gate ──────────────────────────────────────────────────────────────

const ARXIV_RATE_LIMIT_MS = 3_000
let arxivNextAllowedAt = 0

async function waitForArxivRate(): Promise<void> {
  const now = Date.now()
  if (now < arxivNextAllowedAt) {
    await new Promise(resolve => setTimeout(resolve, arxivNextAllowedAt - now))
  }
  arxivNextAllowedAt = Date.now() + ARXIV_RATE_LIMIT_MS
}

// ── URL derivation ─────────────────────────────────────────────────────────

export function deriveArxivPdfUrl(arxivId: string): string {
  const bareId = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  return `https://arxiv.org/pdf/${bareId}.pdf`
}

// ── Resolve arXiv ID by title search ───────────────────────────────────────

/**
 * Search arXiv by title to find the correct arXiv ID for a paper.
 * Returns a valid arXiv ID (e.g. "2301.12345") or null if no match.
 */
export async function resolveArxivIdByTitle(
  title: string,
  year?: number | null,
): Promise<string | null> {
  const cleanTitle = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleanTitle.length < 10) return null

  await waitForArxivRate()

  const url = new URL('http://export.arxiv.org/api/query')
  url.searchParams.set('search_query', `ti:"${cleanTitle}"`)
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', '5')
  url.searchParams.set('sortBy', 'relevance')

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null

    const xml = await res.text()
    const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) ?? []

    for (const entry of entries) {
      const tag = (name: string) => {
        const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
        return m ? m[1].trim() : ''
      }
      const entryTitle = tag('title').replace(/\s+/g, ' ')
      const entryId = tag('id')

      const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
      const sim = normalize(entryTitle) === normalize(title)
      if (!sim) continue

      if (year) {
        const entryYear = parseInt(tag('published').slice(0, 4), 10)
        if (entryYear && Math.abs(entryYear - year) > 1) continue
      }

      const idMatch = entryId.match(/arxiv\.org\/abs\/(.+?)(?:v\d+)?$/)
      if (idMatch) return idMatch[1]
    }

    return null
  } catch {
    return null
  }
}

// ── Download + conversion ──────────────────────────────────────────────────

export interface ArxivFetchResult {
  markdown: string
  cachePath: string
  fetchedAt: string
}

/**
 * Download arXiv PDF and convert to Markdown via the markitdown CLI.
 * Returns the converted markdown + cache metadata, or null on failure
 * (network, missing markitdown, conversion error, undersized PDF).
 *
 * Idempotent — returns the cached `.md` if one already exists with
 * non-trivial content.
 */
export async function fetchArxivFulltext(arxivId: string): Promise<ArxivFetchResult | null> {
  const mdPath = arxivConvertedPath(arxivId)
  const pdfPath = arxivRawPdfPath(arxivId)

  // Cache check (also handled by cacheLookup() upstream, but keeping this
  // local short-circuit avoids re-running markitdown on a partial download).
  try {
    if (existsSync(mdPath)) {
      const cached = readFileSync(mdPath, 'utf-8')
      if (cached && cached.trim().length > 100) {
        return { markdown: cached, cachePath: mdPath, fetchedAt: fileMtimeIso(mdPath) }
      }
    }
  } catch {
    // fall through to re-fetch
  }

  // Download PDF if not cached
  if (!existsSync(pdfPath)) {
    await waitForArxivRate()
    const url = deriveArxivPdfUrl(arxivId)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ResearchPilot/1.0 (academic research tool)' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 1000) return null
      mkdirSync(dirname(pdfPath), { recursive: true })
      writeFileSync(pdfPath, buffer)
    } catch {
      return null
    }
  }

  // Convert PDF to Markdown via markitdown CLI
  try {
    const output = execSync(`markitdown "${pdfPath}"`, {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      // stdin ignored, stdout captured (the Markdown), stderr buffered —
      // NOT forwarded to the parent process's stderr (execSync's default
      // when stdio is unset). markitdown shells out to pdfminer, which
      // logs a `log.warning` per unresolved named pattern color (e.g.
      // "Cannot set gray non-stroke color because /'H2' is an invalid
      // float value") on tagged PDFs. These are harmless — text still
      // extracts — but with stderr inherited they flood the app console.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (output && output.trim().length > 100) {
      const cachePath = writeArxivConverted(arxivId, output)
      return { markdown: output, cachePath, fetchedAt: new Date().toISOString() }
    }
    return null
  } catch {
    // markitdown not installed or conversion failed
    return null
  }
}
