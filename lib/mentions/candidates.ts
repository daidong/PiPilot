/**
 * Mention Candidates
 *
 * Builds autocomplete candidates from research entities and files on disk.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
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

// Directories to skip during recursive file walk
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.research-pilot', '.agentfoundry',
  'dist', 'out', '.next', '.venv', 'venv'
])
const MAX_FILE_CANDIDATES = 500
const MAX_DEPTH = 8

/**
 * Recursively walk directories and collect file candidates.
 * Uses relative POSIX paths as values for @file: insertion.
 */
function walkFiles(
  root: string,
  rel: string,
  depth: number,
  out: MentionCandidate[]
): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILE_CANDIDATES) return
  const dir = rel ? join(root, rel) : root
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }

  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (out.length >= MAX_FILE_CANDIDATES) return
    const childRel = rel ? `${rel}/${name}` : name
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walkFiles(root, childRel, depth + 1, out)
    } else {
      out.push({
        type: 'file',
        value: childRel,
        label: childRel,
        detail: `${(stat.size / 1024).toFixed(1)}KB`
      })
    }
  }
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
        label: n.title || n.id.slice(0, 8),
        detail: n.tags?.length > 0 ? n.tags.join(', ') : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'paper') {
    for (const l of listLiterature(projectPath)) {
      candidates.push({
        type: 'paper',
        value: l.citeKey,
        label: l.title || l.citeKey,
        detail: (l.authors?.slice(0, 2).join(', ') || '') + (l.year ? ` (${l.year})` : '')
      })
    }
  }

  if (!typeFilter || typeFilter === 'data') {
    for (const d of listData(projectPath)) {
      candidates.push({
        type: 'data',
        value: d.id.slice(0, 8),
        label: d.name || d.id.slice(0, 8),
        detail: d.rowCount != null ? `${d.rowCount} rows` : undefined
      })
    }
  }

  if (!typeFilter || typeFilter === 'file') {
    if (existsSync(projectPath)) {
      walkFiles(projectPath, '', 0, candidates)
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

  // For empty query, cap file results to avoid overwhelming the list.
  // Sort files by path depth (shallow first) so top-level files appear first.
  const MAX_EMPTY_QUERY_FILES = 30
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
