/**
 * Sidecar Status Log — append-only record of per-paper meta block parse outcomes.
 *
 * Stored at `~/.research-pilot/paper-wiki/.state/sidecar_status.jsonl`.
 * Used by the repair pass (RFC-005 §12) to find pages needing re-extraction.
 */

import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getWikiRoot } from './types.js'
import { safeReadFile, safeWriteFile } from './io.js'
import type { ParseStatus } from './meta-parser.js'

export interface SidecarStatusEntry {
  slug: string
  status: ParseStatus
  reason?: string
  droppedFields: string[]
  generator_version: number
  recorded_at: string
  repairUsed?: boolean
}

function statusFilePath(): string {
  return join(getWikiRoot(), '.state', 'sidecar_status.jsonl')
}

function ensureStateDir(): void {
  const dir = dirname(statusFilePath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Read all status entries. The file is small (one line per paper) so we load
 * it wholesale. Last write for a given slug wins.
 */
export function readSidecarStatus(): Map<string, SidecarStatusEntry> {
  const map = new Map<string, SidecarStatusEntry>()
  const content = safeReadFile(statusFilePath())
  if (!content) return map
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as SidecarStatusEntry
      if (entry.slug) map.set(entry.slug, entry)
    } catch {
      // skip corrupt lines — they'll be overwritten on next write
    }
  }
  return map
}

/**
 * Upsert a status entry. Rewrites the full file to collapse duplicates.
 */
export function recordSidecarStatus(entry: SidecarStatusEntry): void {
  ensureStateDir()
  const existing = readSidecarStatus()
  existing.set(entry.slug, entry)
  const content =
    Array.from(existing.values())
      .map(e => JSON.stringify(e))
      .join('\n') + '\n'
  safeWriteFile(statusFilePath(), content)
}

/**
 * List slugs whose status is 'missing' or whose generator_version is stale.
 * Used by the repair pass to prioritize re-extraction.
 */
export function listStaleOrMissing(currentGeneratorVersion: number): SidecarStatusEntry[] {
  const result: SidecarStatusEntry[] = []
  for (const entry of readSidecarStatus().values()) {
    if (entry.status === 'missing' || entry.generator_version < currentGeneratorVersion) {
      result.push(entry)
    }
  }
  return result
}

/**
 * Drop status entries whose slug is no longer in the provided live set.
 * Called after identity reconcile / page deletion to keep the status log
 * from accumulating dead rows that the repair pass would otherwise read and
 * silently skip every cycle.
 *
 * Returns the number of entries removed.
 */
export function pruneSidecarStatus(liveSlugs: Set<string>): number {
  const current = readSidecarStatus()
  let removed = 0
  const kept: SidecarStatusEntry[] = []
  for (const entry of current.values()) {
    if (liveSlugs.has(entry.slug)) kept.push(entry)
    else removed++
  }
  if (removed === 0) return 0
  const content = kept.length > 0
    ? kept.map(e => JSON.stringify(e)).join('\n') + '\n'
    : ''
  safeWriteFile(statusFilePath(), content)
  return removed
}
