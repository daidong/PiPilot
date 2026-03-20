/**
 * Mention Candidates
 *
 * Builds autocomplete candidates from entities and files on disk.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { listNotes, listDocs } from '../commands/index.js'
import type { MentionType } from './parser.js'

export interface MentionCandidate {
  type: MentionType
  /** The value to insert after @type: */
  value: string
  /** Display label shown in popup */
  label: string
  /** Optional secondary info (e.g. tags) */
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

  if (!typeFilter || typeFilter === 'doc') {
    for (const d of listDocs(projectPath)) {
      candidates.push({
        type: 'doc',
        value: d.id.slice(0, 8),
        label: d.title,
        detail: d.description || d.mimeType || undefined
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
