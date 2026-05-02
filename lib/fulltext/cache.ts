/**
 * Full-text cache — pure path-convention probe.
 *
 * Layout (under <wiki-root>):
 *   converted/arxiv/<safeArxivId>.md     — arXiv-source converted markdown
 *   converted/paperclip/<paperclipId>.md  — Paperclip-source markdown
 *   raw/arxiv/<safeArxivId>.pdf           — arXiv source PDF (untouched)
 *   raw/paperclip/<paperclipId>.json      — Paperclip raw response (debugging)
 *
 * Lookup: try Paperclip path (by pmcId) first, then arXiv path (by arxivId).
 * Falls back to legacy flat layout (<wiki-root>/converted/<id>.md) for
 * back-compat with pre-fulltext-service caches. No reverse-lookup index file.
 *
 * Trade-off accepted: a request with only a `doi` will not hit the cache on
 * first call; once Paperclip resolves it the artifact gains a pmcId and
 * subsequent calls hit the cache. (See spec §5.4 for rationale.)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { getWikiRoot } from '../wiki/types.js'
import type { CacheHit, FulltextRequest, FulltextSource } from './types.js'

// ── Path helpers ───────────────────────────────────────────────────────────

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9.-]/g, '_')
}

export function arxivConvertedPath(arxivId: string): string {
  const bare = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  return join(getWikiRoot(), 'converted', 'arxiv', `${safeId(bare)}.md`)
}

export function arxivRawPdfPath(arxivId: string): string {
  const bare = arxivId
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '')
  return join(getWikiRoot(), 'raw', 'arxiv', `${safeId(bare)}.pdf`)
}

export function paperclipConvertedPath(paperclipId: string): string {
  return join(getWikiRoot(), 'converted', 'paperclip', `${safeId(paperclipId)}.md`)
}

export function paperclipRawPath(paperclipId: string): string {
  return join(getWikiRoot(), 'raw', 'paperclip', `${safeId(paperclipId)}.json`)
}

function legacyFlatPath(id: string): string {
  return join(getWikiRoot(), 'converted', `${safeId(id)}.md`)
}

// ── Lookup ─────────────────────────────────────────────────────────────────

/**
 * Sequential path probe. First-existing-file wins.
 *
 * Order:
 *   1. paperclip + pmcId (cheapest, source-aware)
 *   2. arxiv + arxivId
 *   3. legacy flat layout (back-compat for pre-service caches)
 *
 * Returns null on miss. Does NOT go online.
 */
export function cacheLookup(req: FulltextRequest): CacheHit | null {
  if (req.pmcId) {
    const p = paperclipConvertedPath(req.pmcId)
    if (existsSync(p) && statSync(p).size > 100) {
      return { path: p, source: 'paperclip', sectionList: readPaperclipSectionList(req.pmcId) }
    }
  }

  if (req.arxivId) {
    const p = arxivConvertedPath(req.arxivId)
    if (existsSync(p) && statSync(p).size > 100) {
      return { path: p, source: 'arxiv' }
    }
    // Legacy flat path: pre-service caches wrote <wiki-root>/converted/<arxivId>.md
    const legacy = legacyFlatPath(req.arxivId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, ''))
    if (existsSync(legacy) && statSync(legacy).size > 100) {
      return { path: legacy, source: 'arxiv' }
    }
  }

  return null
}

/**
 * Section list for a Paperclip-cached paper, derived from a sibling
 * sections directory written alongside the converted markdown.
 *
 * Paperclip's MCP server returns sections via `ls /papers/<id>/sections/`.
 * paperclip.ts saves the listing as <wiki-root>/raw/paperclip/<id>.sections.json
 * during the initial fetch so we can return it on cache hit without going
 * back to the network.
 */
function readPaperclipSectionList(paperclipId: string): string[] | undefined {
  const path = join(getWikiRoot(), 'raw', 'paperclip', `${safeId(paperclipId)}.sections.json`)
  try {
    if (!existsSync(path)) return undefined
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (Array.isArray(data)) return data as string[]
  } catch {
    // ignore — section list is best-effort
  }
  return undefined
}

// ── Write paths ────────────────────────────────────────────────────────────

export function writeArxivConverted(arxivId: string, markdown: string): string {
  const path = arxivConvertedPath(arxivId)
  ensureDir(dirname(path))
  writeFileSync(path, markdown, 'utf-8')
  return path
}

export function writeArxivRawPdf(arxivId: string, buffer: Buffer): string {
  const path = arxivRawPdfPath(arxivId)
  ensureDir(dirname(path))
  writeFileSync(path, buffer)
  return path
}

export function writePaperclipConverted(paperclipId: string, markdown: string): string {
  const path = paperclipConvertedPath(paperclipId)
  ensureDir(dirname(path))
  writeFileSync(path, markdown, 'utf-8')
  return path
}

export function writePaperclipRaw(paperclipId: string, body: unknown): string {
  const path = paperclipRawPath(paperclipId)
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf-8')
  return path
}

export function writePaperclipSectionList(paperclipId: string, sections: string[]): string {
  const path = join(getWikiRoot(), 'raw', 'paperclip', `${safeId(paperclipId)}.sections.json`)
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(sections, null, 2), 'utf-8')
  return path
}

// ── Probing ────────────────────────────────────────────────────────────────

/**
 * Best-effort: list cached paperclip IDs (used by backfill diagnostics).
 * Internal — not part of the public API.
 */
export function listCachedPaperclipIds(): string[] {
  const dir = join(getWikiRoot(), 'converted', 'paperclip')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

export function fileMtimeIso(path: string): string {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}
