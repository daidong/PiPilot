/**
 * Mention Candidates
 *
 * Builds autocomplete candidates from research entities and files on disk.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { listNotes, listLiterature, listData } from '../commands/index.js'
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

/**
 * Get all autocomplete candidates for a given project.
 * Optionally filter by type prefix if the user already typed @note: etc.
 */
export function getCandidates(
  projectPath: string,
  typeFilter?: MentionType,
  query?: string
): MentionCandidate[] {
  const candidates: MentionCandidate[] = []
  const q = query?.toLowerCase() ?? ''

  if (!typeFilter || typeFilter === 'note') {
    for (const n of listNotes(projectPath)) {
      candidates.push({
        type: 'note',
        value: n.id.slice(0, 8),
        label: n.title,
        detail: n.tags.length > 0 ? n.tags.join(', ') : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'paper') {
    for (const l of listLiterature(projectPath)) {
      candidates.push({
        type: 'paper',
        value: l.citeKey,
        label: l.title,
        detail: l.authors.slice(0, 2).join(', ') + (l.year ? ` (${l.year})` : '')
      })
    }
  }

  if (!typeFilter || typeFilter === 'data') {
    for (const d of listData(projectPath)) {
      candidates.push({
        type: 'data',
        value: d.id.slice(0, 8),
        label: d.name,
        detail: d.rowCount != null ? `${d.rowCount} rows` : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'file') {
    // List top-level files in projectPath (non-recursive, skip hidden)
    if (existsSync(projectPath)) {
      try {
        for (const entry of readdirSync(projectPath)) {
          if (entry.startsWith('.')) continue
          const full = join(projectPath, entry)
          try {
            const stat = statSync(full)
            candidates.push({
              type: 'file',
              value: stat.isDirectory() ? `${entry}/` : entry,
              label: entry,
              detail: stat.isDirectory() ? 'directory' : `${(stat.size / 1024).toFixed(1)}KB`
            })
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  // URL type has no candidates (user types it directly)

  if (q) {
    return candidates.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.value.toLowerCase().includes(q) ||
      c.detail?.toLowerCase().includes(q)
    )
  }

  return candidates
}
