/**
 * Full-text Retrieval — public entry point.
 *
 * `resolveFulltext()` is the single shared implementation backing both the
 * Paper Wiki background indexer and the agent-facing `fetch-fulltext` tool.
 *
 * Dispatch:
 *   1. cache.lookup (zero network)
 *   2. Paperclip MCP — when PAPERCLIP_API_KEY is set AND a relevant ID exists
 *   3. arXiv direct — when arxivId is valid OR title-resolve succeeds
 *   4. null
 *
 * `preferSource` overrides 2↔3 ordering.
 *
 * See docs/spec/fulltext-retrieval.md.
 */

import { cacheLookup, fileMtimeIso } from './cache.js'
import { fetchArxivFulltext, resolveArxivIdByTitle } from './arxiv.js'
import { fetchPaperclipFulltext } from './paperclip.js'
import { isValidArxivId } from '../wiki/types.js'
import type { PaperArtifact } from '../types.js'
import type {
  FulltextRequest,
  FulltextResult,
  FulltextSource,
} from './types.js'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getWikiRoot } from '../wiki/types.js'

export type { FulltextRequest, FulltextResult, FulltextSource } from './types.js'
export {
  arxivConvertedPath,
  paperclipConvertedPath,
  arxivRawPdfPath,
  cacheLookup,
} from './cache.js'
export { resolveArxivIdByTitle } from './arxiv.js'

// ── Eligibility predicate (shared by scanner.ts and generator.ts) ──────────

/**
 * Does this artifact have at least one identifier we can try to resolve via
 * the full-text service? This widens the wiki's existing arxiv-only gate so
 * DOI/PMC-only biomedical papers are also retryable.
 *
 * Reads `process.env.PAPERCLIP_API_KEY` directly — no settings argument —
 * to mirror the existing `BRAVE_API_KEY` env-var pattern.
 */
export function hasAnyFulltextSource(a: PaperArtifact): boolean {
  const hasPaperclipKey = !!(process.env.PAPERCLIP_API_KEY || '').trim()
  const hasUsefulDoi = !!a.doi && !a.doi.startsWith('unknown:')
  if (hasPaperclipKey && (hasUsefulDoi || a.pmcId || a.pubmedId)) return true
  if (a.arxivId && isValidArxivId(a.arxivId)) return true
  return false
}

// ── Core dispatch ──────────────────────────────────────────────────────────

interface SourceAttempt {
  source: FulltextSource
  run: () => Promise<FulltextResult | null>
}

export async function resolveFulltext(
  req: FulltextRequest,
): Promise<FulltextResult | null> {
  // Step 1: cache probe (cheap). Body-cache short-circuit applies ONLY when
  // the caller did NOT request specific sections — otherwise the cached
  // file is the concatenated content.lines and can't be split back into
  // named sections without re-fetching from Paperclip. Section list itself
  // is still surfaced to the caller for discoverability.
  const wantsSections = !!(req.sections && req.sections.length > 0)
  const hit = cacheLookup(req)
  if (hit && !wantsSections) {
    try {
      const md = readFileSync(hit.path, 'utf-8')
      if (md && md.trim().length > 100) {
        return {
          markdown: md,
          source: hit.source,
          cachePath: hit.path,
          sectionList: hit.sectionList,
          fetchedAt: fileMtimeIso(hit.path),
        }
      }
    } catch {
      // Cache read failed — fall through to live fetch.
    }
  }

  // Step 2: build attempt order
  const attempts: SourceAttempt[] = []

  const paperclipAttempt: SourceAttempt = {
    source: 'paperclip',
    run: async () => {
      const r = await fetchPaperclipFulltext({
        doi: req.doi,
        pmcId: req.pmcId,
        arxivId: req.arxivId,
        sections: req.sections,
      })
      if (!r) return null
      return {
        markdown: r.markdown,
        source: 'paperclip',
        cachePath: r.cachePath,
        sections: r.sections,
        sectionList: r.sectionList,
        fetchedAt: r.fetchedAt,
        resolvedPmcId: r.resolvedPmcId,
      }
    },
  }

  const arxivAttempt: SourceAttempt = {
    source: 'arxiv',
    run: async () => {
      let arxivId = req.arxivId
      if (!arxivId && req.title) {
        const resolved = await resolveArxivIdByTitle(req.title, req.year ?? null)
        if (resolved) arxivId = resolved
      }
      if (!arxivId || !isValidArxivId(arxivId)) return null
      const r = await fetchArxivFulltext(arxivId)
      if (!r) return null
      return {
        markdown: r.markdown,
        source: 'arxiv',
        cachePath: r.cachePath,
        fetchedAt: r.fetchedAt,
      }
    },
  }

  const order: FulltextSource[] =
    req.preferSource === 'arxiv'
      ? ['arxiv', 'paperclip']
      : ['paperclip', 'arxiv']
  for (const s of order) {
    if (s === 'paperclip') attempts.push(paperclipAttempt)
    else if (s === 'arxiv') attempts.push(arxivAttempt)
  }

  for (const attempt of attempts) {
    try {
      const result = await attempt.run()
      if (result) return result
    } catch (err) {
      console.warn(
        `[fulltext] ${attempt.source} attempt failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return null
}

// ── Cache-only lookup (no network) — for wiki_source ───────────────────────

/**
 * Cache probe without falling through to the network. Used by `wiki_source`
 * to surface paths to already-cached fulltext without spending Paperclip
 * quota on every coordinator call.
 */
export function lookupCachedFulltext(req: FulltextRequest): {
  path: string
  source: FulltextSource
  sectionList?: string[]
} | null {
  const hit = cacheLookup(req)
  if (!hit) return null
  // Sanity: ensure file is non-empty.
  try {
    if (statSync(hit.path).size <= 100) return null
  } catch {
    return null
  }
  return hit
}

// Re-export wiki-root helper for convenience in tools that need to resolve
// cache paths without importing wiki/types.
export function getFulltextCacheRoot(): string {
  return join(getWikiRoot(), 'converted')
}
