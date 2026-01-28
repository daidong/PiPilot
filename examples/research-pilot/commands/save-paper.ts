/**
 * /save-paper Command Handler
 *
 * Saves a literature entry with provenance tracking.
 *
 * Usage (Ink UI):
 *   /save-paper <title> --authors "A, B" --year 2024 --abstract "..." --citekey key
 *   /save-paper <title>   (minimal — only title required, rest defaults)
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Literature, CLIContext } from '../types.js'

export interface SavePaperResult {
  success: boolean
  paper?: Literature
  filePath?: string
  error?: string
}

/**
 * Save a paper programmatically.
 */
export function savePaper(
  title: string,
  opts: {
    authors?: string[]
    year?: number
    abstract?: string
    venue?: string
    url?: string
    citeKey?: string
    tags?: string[]
    // New search metadata fields for local paper caching
    searchKeywords?: string[]
    externalSource?: string
    relevanceScore?: number
    citationCount?: number
    doi?: string
    bibtex?: string
  },
  context: CLIContext
): SavePaperResult {
  if (!title) return { success: false, error: 'Paper title is required.' }

  // Auto-generate citeKey from first author + year if not provided
  const firstAuthor = opts.authors?.[0]?.split(' ').pop()?.toLowerCase() ?? 'unknown'
  const citeKey = opts.citeKey ?? `${firstAuthor}${opts.year ?? 'nd'}`

  const paper: Literature = {
    id: crypto.randomUUID(),
    type: 'literature',
    title,
    authors: opts.authors ?? ['Unknown'],
    abstract: opts.abstract ?? '',
    year: opts.year,
    venue: opts.venue,
    url: opts.url,
    citeKey,
    tags: opts.tags ?? [],
    pinned: false,
    selectedForAI: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      source: opts.externalSource ? 'agent' : 'user',
      sessionId: context.sessionId,
      agentId: opts.externalSource ? 'literature-team' : undefined,
      extractedFrom: opts.externalSource ? 'agent-response' : 'user-input'
    },
    // Search metadata fields
    searchKeywords: opts.searchKeywords,
    externalSource: opts.externalSource,
    relevanceScore: opts.relevanceScore,
    citationCount: opts.citationCount,
    doi: opts.doi,
    bibtex: opts.bibtex
  }

  // Use projectPath if provided, otherwise fall back to relative path
  const literaturePath = context.projectPath
    ? join(context.projectPath, PATHS.literature)
    : PATHS.literature

  mkdirSync(literaturePath, { recursive: true })
  const filePath = join(literaturePath, `${paper.id}.json`)
  writeFileSync(filePath, JSON.stringify(paper, null, 2))

  return { success: true, paper, filePath }
}

/**
 * Parse /save-paper arguments.
 * Format: /save-paper <title> [--authors "A, B"] [--year N] [--abstract "..."] [--venue "..."] [--url "..."] [--citekey key] [--tags "a, b"]
 */
export function parseSavePaperArgs(raw: string): {
  title: string
  authors?: string[]
  year?: number
  abstract?: string
  venue?: string
  url?: string
  citeKey?: string
  tags?: string[]
} {
  // Extract flag values first, remainder is the title
  const flagPattern = /--(\w+)\s+"([^"]+)"|--(\w+)\s+(\S+)/g
  const flags: Record<string, string> = {}
  let cleaned = raw

  let match: RegExpExecArray | null
  while ((match = flagPattern.exec(raw)) !== null) {
    const key = match[1] || match[3]
    const value = match[2] || match[4]
    flags[key] = value
    cleaned = cleaned.replace(match[0], '')
  }

  const title = cleaned.trim()

  return {
    title,
    authors: flags.authors?.split(',').map(a => a.trim()),
    year: flags.year ? parseInt(flags.year, 10) : undefined,
    abstract: flags.abstract,
    venue: flags.venue,
    url: flags.url,
    citeKey: flags.citekey,
    tags: flags.tags?.split(',').map(t => t.trim())
  }
}
