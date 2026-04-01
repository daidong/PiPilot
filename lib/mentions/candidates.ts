/**
 * Mention Candidates
 *
 * Builds autocomplete candidates from research entities and files on disk.
 * Uses a cached file index (git ls-files) and substring filtering.
 */

import { statSync } from 'fs'
import { join } from 'path'
import { getFileList } from './file-index.js'
import { getEntityCache } from './entity-index.js'
import { fuzzyMatch } from './fuzzy-match.js'
import type { MentionType } from './parser.js'

export interface MentionCandidate {
  type: MentionType
  /** The value to insert after @type: */
  value: string
  /** Display label shown in popup */
  label: string
  /** Optional secondary info (e.g. author, tags) */
  detail?: string
}

const MAX_EMPTY_QUERY_FILES = 30

/**
 * Get all autocomplete candidates for a given project.
 * Optionally filter by type prefix if the user already typed @note: etc.
 */
export async function getCandidates(
  projectPath: string,
  typeFilter?: MentionType,
  query?: string
): Promise<MentionCandidate[]> {
  const candidates: MentionCandidate[] = []
  const q = query?.toLowerCase() ?? ''

  const entities = getEntityCache(projectPath)

  if (!typeFilter || typeFilter === 'note') {
    for (const n of entities.notes) {
      candidates.push({
        type: 'note',
        value: n.id.slice(0, 8),
        label: n.title || n.id.slice(0, 8),
        detail: n.tags?.length > 0 ? n.tags.join(', ') : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'paper') {
    for (const l of entities.papers) {
      candidates.push({
        type: 'paper',
        value: l.citeKey,
        label: l.title || l.citeKey,
        detail: (l.authors?.slice(0, 2).join(', ') || '') + (l.year ? ` (${l.year})` : '')
      })
    }
  }

  if (!typeFilter || typeFilter === 'data') {
    for (const d of entities.data) {
      candidates.push({
        type: 'data',
        value: d.id.slice(0, 8),
        label: d.name || d.id.slice(0, 8),
        detail: d.rowCount != null ? `${d.rowCount} rows` : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'file') {
    const files = await getFileList(projectPath)
    for (const rel of files) {
      let detail: string | undefined
      try {
        const stat = statSync(join(projectPath, rel))
        detail = `${(stat.size / 1024).toFixed(1)}KB`
      } catch { /* skip stat errors */ }
      candidates.push({ type: 'file', value: rel, label: rel, detail })
    }
  }

  // URL type has no candidates (user types it directly)

  if (q) {
    return fuzzyMatch(
      candidates,
      q,
      c => `${c.label} ${c.value} ${c.detail ?? ''}`,
      50
    ).map(r => r.item)
  }

  // For empty query, cap file results to avoid overwhelming the list.
  // Sort files by path depth (shallow first) so top-level files appear first.
  const fileCount = candidates.filter(c => c.type === 'file').length
  if (fileCount > MAX_EMPTY_QUERY_FILES) {
    const nonFiles = candidates.filter(c => c.type !== 'file')
    const files = candidates
      .filter(c => c.type === 'file')
      .sort((a, b) => {
        const depthA = (a.value.match(/\//g) || []).length
        const depthB = (b.value.match(/\//g) || []).length
        return depthA - depthB || a.value.localeCompare(b.value)
      })
      .slice(0, MAX_EMPTY_QUERY_FILES)
    return [...nonFiles, ...files]
  }

  return candidates
}
