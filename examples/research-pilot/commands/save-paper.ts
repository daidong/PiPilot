/**
 * /save-paper Command Handler
 *
 * Saves a literature entry with provenance tracking.
 *
 * Usage (Ink UI):
 *   /save-paper <title> --authors "A, B" --year 2024 --abstract "..." --citekey key
 *   /save-paper <title>   (minimal — only title required, rest defaults)
 */

import { writeFileSync, readFileSync, mkdirSync } from 'fs'
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
 * Update an existing paper entity on disk, merging in any non-empty fields
 * that are currently missing. Preserves user edits (only fills blanks).
 */
export function updatePaperMetadata(
  existing: Literature,
  enriched: {
    authors?: string[]
    year?: number
    abstract?: string
    venue?: string
    url?: string
    citationCount?: number
    doi?: string
    bibtex?: string
    pdfUrl?: string
    enrichmentSource?: string
    enrichedAt?: string
  },
  context: CLIContext
): SavePaperResult {
  let changed = false

  // Only fill fields that are missing or have placeholder values
  if ((!existing.abstract || existing.abstract === '') && enriched.abstract) {
    existing.abstract = enriched.abstract
    changed = true
  }
  if ((!existing.venue) && enriched.venue) {
    existing.venue = enriched.venue
    changed = true
  }
  if ((!existing.year) && enriched.year) {
    existing.year = enriched.year
    changed = true
  }
  if ((!existing.url) && enriched.url) {
    existing.url = enriched.url
    changed = true
  }
  if ((!existing.doi) && enriched.doi) {
    existing.doi = enriched.doi
    changed = true
  }
  if ((!existing.citationCount) && enriched.citationCount) {
    existing.citationCount = enriched.citationCount
    changed = true
  }
  if ((!existing.bibtex) && enriched.bibtex) {
    existing.bibtex = enriched.bibtex
    changed = true
  }
  if ((!existing.pdfUrl) && enriched.pdfUrl) {
    existing.pdfUrl = enriched.pdfUrl
    changed = true
  }
  if (enriched.authors && enriched.authors.length > 0 &&
      (existing.authors.length === 0 || (existing.authors.length === 1 && existing.authors[0] === 'Unknown'))) {
    existing.authors = enriched.authors
    changed = true
  }
  // Always update enrichment provenance if any field changed
  if (changed) {
    if (enriched.enrichmentSource) existing.enrichmentSource = enriched.enrichmentSource
    existing.enrichedAt = enriched.enrichedAt || new Date().toISOString()
  }

  if (!changed) {
    return { success: true, paper: existing }
  }

  existing.updatedAt = new Date().toISOString()

  const literaturePath = context.projectPath
    ? join(context.projectPath, PATHS.literature)
    : PATHS.literature

  const filePath = join(literaturePath, `${existing.id}.json`)
  writeFileSync(filePath, JSON.stringify(existing, null, 2))

  return { success: true, paper: existing, filePath }
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
