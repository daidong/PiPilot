/**
 * Wiki Identity Migration — atomic transitions between canonical keys.
 *
 * Background: computeCanonicalKey() has a priority hierarchy (doi > arxiv >
 * title+year). Any change that elevates a paper to a higher-priority key
 * (agent resolves arxivId, user adds DOI, enrichment backfills identifiers)
 * changes the canonicalKey, which in turn changes the slug, which causes the
 * scanner to treat the paper as brand-new. The existing page, watermark,
 * provenance, and concept-page markers remain bound to the old key/slug and
 * become stale/duplicate. See lib/docs/wiki-identity-drift.md for the full
 * background (not written yet — trust the audit).
 *
 * This module owns the single atomic operation that moves everything tied to
 * `oldKey/oldSlug` to `newKey/newSlug`. Two shapes both land here:
 *
 *   migrate  — only the old identity exists. Rename files, rekey records,
 *              rewrite concept markers in place.
 *   collapse — both identities exist (historical drift). Delete the old
 *              page, drop the old watermark entry, merge provenance under
 *              the new key, and delete the old concept-marker blocks
 *              (keep-new policy, per design).
 *
 * Caller MUST already hold withWikiLock(). We do not re-enter the lock here
 * so this can be composed inside larger multi-step transactions.
 */

import { existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getWikiRoot, isValidArxivId, type ProcessedEntry, type ProvenanceEntry } from './types.js'
import { safeReadFile, safeWriteFile } from './io.js'
import { normalizeDoi } from '../memory-v2/store.js'
import type { PaperArtifact } from '../types.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface IdentityChange {
  oldKey: string
  oldSlug: string
  newKey: string
  newSlug: string
}

export interface MigrationResult {
  mode: 'noop' | 'migrate' | 'collapse'
  renamedPage: boolean
  deletedOldPage: boolean
  processedEntriesMigrated: number
  processedEntriesDeleted: number
  provenanceEntriesRewritten: number
  provenanceEntriesDeduped: number
  conceptPagesTouched: string[]
  conceptMarkerBlocksRenamed: number
  conceptMarkerBlocksDeleted: number
}

// ── Concept page marker rewriting ──────────────────────────────────────────

interface ConceptRewriteResult {
  updated: string
  renamed: number
  deleted: number
}

/**
 * Rewrite `<!-- paper:oldSlug --> ... <!-- /paper:oldSlug -->` blocks in a
 * concept page. If the page already contains a newSlug block, old blocks are
 * deleted (collapse — keep-new policy). Otherwise old blocks are renamed to
 * newSlug (migrate).
 */
export function rewriteConceptMarkers(
  content: string,
  oldSlug: string,
  newSlug: string,
): ConceptRewriteResult {
  const oldOpen = `<!-- paper:${oldSlug} -->`
  const oldClose = `<!-- /paper:${oldSlug} -->`
  const newOpen = `<!-- paper:${newSlug} -->`
  const newClose = `<!-- /paper:${newSlug} -->`

  let renamed = 0
  let deleted = 0
  let out = content

  const hasNew = out.includes(newOpen)

  while (true) {
    const start = out.indexOf(oldOpen)
    if (start < 0) break
    const end = out.indexOf(oldClose, start)
    if (end < 0) break  // malformed: leave alone to avoid data loss

    if (hasNew) {
      // Delete the entire block, including a leading blank line if present.
      let blockStart = start
      // Pull in a leading newline+whitespace run so we don't leave a blank hole.
      while (blockStart > 0 && (out[blockStart - 1] === '\n' || out[blockStart - 1] === ' ' || out[blockStart - 1] === '\t')) {
        blockStart--
      }
      let blockEnd = end + oldClose.length
      while (blockEnd < out.length && out[blockEnd] === '\n') blockEnd++
      out = out.slice(0, blockStart) + (blockStart > 0 ? '\n\n' : '') + out.slice(blockEnd)
      deleted++
    } else {
      const sectionBody = out.slice(start + oldOpen.length, end)
      const replacement = newOpen + sectionBody + newClose
      out = out.slice(0, start) + replacement + out.slice(end + oldClose.length)
      renamed++
    }
  }

  return { updated: out, renamed, deleted }
}

// ── Watermark + provenance helpers (JSONL) ─────────────────────────────────

function readJsonl<T>(filePath: string): T[] {
  const content = safeReadFile(filePath)
  if (!content) return []
  const out: T[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { out.push(JSON.parse(trimmed)) } catch { /* skip corrupt lines */ }
  }
  return out
}

function writeJsonl<T>(filePath: string, entries: T[]): void {
  const body = entries.map(e => JSON.stringify(e)).join('\n')
  safeWriteFile(filePath, entries.length > 0 ? body + '\n' : '')
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Apply an identity migration atomically. Caller must hold withWikiLock.
 *
 * All steps are write-heavy but idempotent: re-running the same migration
 * after a crash is a no-op.
 */
export function applyIdentityMigration(change: IdentityChange): MigrationResult {
  const { oldKey, oldSlug, newKey, newSlug } = change
  const result: MigrationResult = {
    mode: 'noop',
    renamedPage: false,
    deletedOldPage: false,
    processedEntriesMigrated: 0,
    processedEntriesDeleted: 0,
    provenanceEntriesRewritten: 0,
    provenanceEntriesDeduped: 0,
    conceptPagesTouched: [],
    conceptMarkerBlocksRenamed: 0,
    conceptMarkerBlocksDeleted: 0,
  }
  if (oldKey === newKey && oldSlug === newSlug) return result

  const root = getWikiRoot()

  // ── 1. Paper page file ──
  const oldPath = join(root, 'papers', `${oldSlug}.md`)
  const newPath = join(root, 'papers', `${newSlug}.md`)
  const oldPageExists = existsSync(oldPath)
  const newPageExists = existsSync(newPath)

  // Determine mode. Collapse if both pages exist, else migrate.
  const isCollapse = oldPageExists && newPageExists
  result.mode = isCollapse ? 'collapse' : 'migrate'

  if (oldSlug !== newSlug && oldPageExists) {
    if (isCollapse) {
      try {
        unlinkSync(oldPath)
        result.deletedOldPage = true
      } catch { /* ignore */ }
    } else {
      const content = safeReadFile(oldPath)
      if (content != null) {
        safeWriteFile(newPath, content)
        try { unlinkSync(oldPath) } catch { /* ignore */ }
        result.renamedPage = true
      }
    }
  }

  // ── 2. processed.jsonl ──
  const processedPath = join(root, '.state', 'processed.jsonl')
  const processedEntries = readJsonl<ProcessedEntry>(processedPath)
  const hasNewProcessed = processedEntries.some(e => e.canonicalKey === newKey)
  const nextProcessed: ProcessedEntry[] = []
  for (const e of processedEntries) {
    if (e.canonicalKey === oldKey) {
      if (hasNewProcessed) {
        // Collapse — drop the old entry entirely.
        result.processedEntriesDeleted++
        continue
      }
      // Migrate — rewrite with the new canonical key + slug.
      nextProcessed.push({ ...e, canonicalKey: newKey, slug: newSlug })
      result.processedEntriesMigrated++
    } else {
      nextProcessed.push(e)
    }
  }
  writeJsonl(processedPath, nextProcessed)

  // ── 3. provenance.jsonl ──
  // Rewrite canonicalKey=oldKey → newKey, then dedup by (newKey, projectPath, paperId).
  const provPath = join(root, '.state', 'provenance.jsonl')
  const provEntries = readJsonl<ProvenanceEntry>(provPath)
  const seen = new Set<string>()
  const nextProv: ProvenanceEntry[] = []
  for (const e of provEntries) {
    const effectiveKey = e.canonicalKey === oldKey ? newKey : e.canonicalKey
    const dedupKey = `${effectiveKey}\0${e.projectPath}\0${e.paperId}`
    if (seen.has(dedupKey)) {
      result.provenanceEntriesDeduped++
      continue
    }
    seen.add(dedupKey)
    if (e.canonicalKey === oldKey) {
      nextProv.push({ ...e, canonicalKey: newKey })
      result.provenanceEntriesRewritten++
    } else {
      nextProv.push(e)
    }
  }
  writeJsonl(provPath, nextProv)

  // ── 4. concept pages ──
  if (oldSlug !== newSlug) {
    const conceptsDir = join(root, 'concepts')
    if (existsSync(conceptsDir)) {
      for (const f of readdirSync(conceptsDir)) {
        if (!f.endsWith('.md')) continue
        const path = join(conceptsDir, f)
        const content = safeReadFile(path)
        if (!content) continue
        const { updated, renamed, deleted } = rewriteConceptMarkers(content, oldSlug, newSlug)
        if (renamed === 0 && deleted === 0) continue
        safeWriteFile(path, updated)
        result.conceptPagesTouched.push(f)
        result.conceptMarkerBlocksRenamed += renamed
        result.conceptMarkerBlocksDeleted += deleted
      }
    }
  }

  return result
}

// ── Fallback key enumeration ──────────────────────────────────────────────

/**
 * Return every canonicalKey this paper could have under the priority
 * hierarchy, ordered from highest priority to lowest. The first element
 * equals `computeCanonicalKey(paper).canonicalKey`. Remaining elements are
 * "what the key would have been if the higher-priority identity fields were
 * absent" — used by the scanner pre-pass to detect identity upgrades.
 *
 * Example: a paper with both DOI and arXiv ID returns
 *   [`doi:...`, `arxiv:...`, `title:...:YEAR`]
 *
 * The scanner checks fallback keys in order against the watermark; the first
 * hit is the pre-upgrade key that needs migrating.
 */
export function computeAllCanonicalKeys(paper: PaperArtifact): string[] {
  const keys: string[] = []

  if (paper.doi && !paper.doi.startsWith('unknown:')) {
    keys.push(`doi:${normalizeDoi(paper.doi)}`)
  }
  if (paper.arxivId && isValidArxivId(paper.arxivId)) {
    const bareId = paper.arxivId
      .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      .replace(/v\d+$/, '')
    keys.push(`arxiv:${bareId}`)
  }
  const title = paper.title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  keys.push(`title:${title}:${paper.year ?? 'nd'}`)

  return keys
}
