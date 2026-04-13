/**
 * Wiki Paper Meta Cache — lightweight in-memory index of wiki paper metadata
 * for the Literature search feature. NOT a retrieval index — retrieval uses
 * the BM25 layer in indexer.ts. This cache only holds fields needed to render
 * a search result row (title, authors, year, venue, tldr, canonicalKey, slug).
 *
 * Scale assumption: O(100s) of papers per user. Full rescan is cheap; we skip
 * files whose mtime hasn't changed since the last scan.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getWikiRoot } from './types.js'
import { safeReadFile } from './io.js'
import { parsePaperPage } from './meta-parser.js'

export interface WikiPaperMeta {
  slug: string
  canonicalKey?: string
  title: string
  authors: string[]
  year?: number
  venue?: string
  tldr?: string
  sourceTier?: 'metadata-only' | 'abstract-only' | 'fulltext'
}

interface CacheEntry {
  mtimeMs: number
  meta: WikiPaperMeta
}

const cache = new Map<string, CacheEntry>()
let lastScanAt = 0

// ── Regex parsers for the RFC-003 header (pre-sidecar pages) ───────────────

const TITLE_RE = /^#\s+(.+?)\s*$/m
// Line 3 form: "**Authors:** A, B, C  |  **Year:** 2022  |  **Venue:** ICLR 2023"
const HEADER_LINE_RE = /\*\*Authors:\*\*\s*([^|]*?)(?:\s*\|\s*\*\*Year:\*\*\s*([^|]*?))?(?:\s*\|\s*\*\*Venue:\*\*\s*(.+?))?\s*$/m

/** Extract the first markdown H1 title; fall back to the slug. */
function extractTitle(body: string, fallback: string): string {
  const m = body.match(TITLE_RE)
  return m ? m[1].trim() : fallback
}

function parseAuthorsLine(raw: string): string[] {
  return raw
    .split(/,|;|\sand\s/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length < 120)
}

function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = raw.match(/\b(19|20)\d{2}\b/)
  return m ? parseInt(m[0], 10) : undefined
}

/** Parse the body header for title/authors/year/venue. All fields optional. */
function parseBodyHeader(body: string, slug: string): {
  title: string
  authors: string[]
  year?: number
  venue?: string
} {
  const title = extractTitle(body, slug)
  const headerMatch = body.match(HEADER_LINE_RE)
  if (!headerMatch) return { title, authors: [] }
  const authors = parseAuthorsLine(headerMatch[1] || '')
  const year = parseYear(headerMatch[2])
  const venue = headerMatch[3]?.trim() || undefined
  return { title, authors, year, venue }
}

// ── Single-file parse ──────────────────────────────────────────────────────

function parsePaperFile(slug: string, filePath: string): WikiPaperMeta | null {
  const content = safeReadFile(filePath)
  if (!content) return null

  const outcome = parsePaperPage(content, slug)
  const header = parseBodyHeader(outcome.body, slug)
  const sidecar = outcome.sidecar

  return {
    slug,
    canonicalKey: sidecar?.canonicalKey,
    title: header.title,
    authors: header.authors,
    year: header.year,
    venue: header.venue,
    tldr: sidecar?.tldr,
    sourceTier: sidecar?.source_tier,
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Return metadata for every wiki paper page, using an mtime-based cache to
 * avoid re-parsing files that haven't changed since the last call.
 *
 * Eviction: any slug whose file is missing is dropped from the cache.
 */
export function listWikiPaperMeta(): WikiPaperMeta[] {
  const papersDir = join(getWikiRoot(), 'papers')
  if (!existsSync(papersDir)) return []

  const seen = new Set<string>()
  const results: WikiPaperMeta[] = []

  for (const file of readdirSync(papersDir)) {
    if (!file.endsWith('.md')) continue
    const slug = file.slice(0, -3)
    const filePath = join(papersDir, file)

    let mtimeMs = 0
    try { mtimeMs = statSync(filePath).mtimeMs } catch { continue }

    seen.add(slug)
    const cached = cache.get(slug)
    if (cached && cached.mtimeMs === mtimeMs) {
      results.push(cached.meta)
      continue
    }

    const meta = parsePaperFile(slug, filePath)
    if (!meta) continue
    cache.set(slug, { mtimeMs, meta })
    results.push(meta)
  }

  // Evict deleted files
  for (const slug of cache.keys()) {
    if (!seen.has(slug)) cache.delete(slug)
  }

  lastScanAt = Date.now()
  return results
}

/** Clear the cache — used by tests or after a bulk wiki regeneration. */
export function clearWikiPaperMetaCache(): void {
  cache.clear()
  lastScanAt = 0
}

export function getWikiPaperMetaScanInfo(): { cachedCount: number; lastScanAt: number } {
  return { cachedCount: cache.size, lastScanAt }
}
