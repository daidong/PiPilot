/**
 * Legacy compatibility wrapper for paper creation.
 * RFC-012 canonical API is artifact.create(type=paper).
 */

import { type CLIContext, type Literature } from '../types.js'
import { findExistingPaperArtifact } from '../memory-v2/store.js'
import { artifactCreate, artifactUpdate } from './artifact.js'

export interface SavePaperResult {
  success: boolean
  paper?: Literature
  filePath?: string
  error?: string
}

function generateCiteKey(authors: string[] | undefined, year?: number): string {
  const firstAuthor = authors?.[0]?.split(/\s+/).pop()?.toLowerCase() ?? 'unknown'
  return `${firstAuthor}${year ?? 'nd'}`
}

function buildFallbackBibtex(params: {
  citeKey: string
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  url?: string
}): string {
  const authorText = params.authors.length > 0 ? params.authors.join(' and ') : 'Unknown'
  return [
    `@article{${params.citeKey},`,
    `  title = {${params.title}},`,
    `  author = {${authorText}},`,
    ...(params.year ? [`  year = {${params.year}},`] : []),
    ...(params.venue ? [`  journal = {${params.venue}},`] : []),
    ...(params.doi ? [`  doi = {${params.doi}},`] : []),
    ...(params.url ? [`  url = {${params.url}},`] : []),
    '}'
  ].join('\n')
}

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
    searchKeywords?: string[]
    externalSource?: string
    relevanceScore?: number
    citationCount?: number
    doi?: string
    bibtex?: string
    pdfUrl?: string
  },
  context: CLIContext
): SavePaperResult {
  if (!title) return { success: false, error: 'Paper title is required.' }

  const authors = opts.authors && opts.authors.length > 0 ? opts.authors : ['Unknown']
  const citeKey = opts.citeKey ?? generateCiteKey(authors, opts.year)
  const doi = (opts.doi ?? '').trim() || `unknown:${citeKey}`
  const bibtex = (opts.bibtex ?? '').trim() || buildFallbackBibtex({
    citeKey,
    title,
    authors,
    year: opts.year,
    venue: opts.venue,
    doi,
    url: opts.url
  })

  const dedup = findExistingPaperArtifact(context.projectPath, {
    doi,
    citeKey,
    title,
    year: opts.year
  })

  if (dedup) {
    const updated = artifactUpdate(context.projectPath, dedup.id, {
      title,
      authors,
      abstract: opts.abstract ?? dedup.abstract,
      year: opts.year ?? dedup.year,
      venue: opts.venue ?? dedup.venue,
      url: opts.url ?? dedup.url,
      citeKey,
      doi,
      bibtex,
      pdfUrl: opts.pdfUrl ?? dedup.pdfUrl,
      searchKeywords: opts.searchKeywords ?? dedup.searchKeywords,
      externalSource: opts.externalSource ?? dedup.externalSource,
      relevanceScore: opts.relevanceScore ?? dedup.relevanceScore,
      citationCount: opts.citationCount ?? dedup.citationCount
    })

    if (!updated.success || !updated.artifact || updated.artifact.type !== 'paper') {
      return { success: false, error: 'Failed to update existing paper.' }
    }

    return {
      success: true,
      paper: updated.artifact,
      filePath: updated.filePath
    }
  }

  const created = artifactCreate({
    type: 'paper',
    title,
    authors,
    abstract: opts.abstract ?? '',
    year: opts.year,
    venue: opts.venue,
    url: opts.url,
    citeKey,
    doi,
    bibtex,
    pdfUrl: opts.pdfUrl,
    tags: opts.tags ?? [],
    searchKeywords: opts.searchKeywords,
    externalSource: opts.externalSource,
    relevanceScore: opts.relevanceScore,
    citationCount: opts.citationCount,
    provenance: {
      source: opts.externalSource ? 'agent' : 'user',
      sessionId: context.sessionId,
      agentId: opts.externalSource ? 'literature-team' : undefined,
      extractedFrom: opts.externalSource ? 'agent-response' : 'user-input'
    }
  }, context)

  if (!created.success || !created.artifact || created.artifact.type !== 'paper') {
    return { success: false, error: 'Failed to create paper artifact.' }
  }

  return { success: true, paper: created.artifact, filePath: created.filePath }
}

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
  const update: Record<string, unknown> = {}

  if ((!existing.abstract || existing.abstract === '') && enriched.abstract) update.abstract = enriched.abstract
  if ((!existing.venue) && enriched.venue) update.venue = enriched.venue
  if ((!existing.year) && enriched.year) update.year = enriched.year
  if ((!existing.url) && enriched.url) update.url = enriched.url
  if ((!existing.doi || existing.doi.startsWith('unknown:')) && enriched.doi) update.doi = enriched.doi
  if ((!existing.citationCount) && enriched.citationCount) update.citationCount = enriched.citationCount
  if ((!existing.bibtex || existing.bibtex.trim().length === 0) && enriched.bibtex) update.bibtex = enriched.bibtex
  if ((!existing.pdfUrl) && enriched.pdfUrl) update.pdfUrl = enriched.pdfUrl
  if (enriched.authors && enriched.authors.length > 0 && (existing.authors.length === 0 || (existing.authors.length === 1 && existing.authors[0] === 'Unknown'))) {
    update.authors = enriched.authors
  }
  if (enriched.enrichmentSource) update.enrichmentSource = enriched.enrichmentSource
  if (enriched.enrichedAt) update.enrichedAt = enriched.enrichedAt

  if (Object.keys(update).length === 0) {
    return { success: true, paper: existing }
  }

  const updated = artifactUpdate(context.projectPath, existing.id, update)
  if (!updated.success || !updated.artifact || updated.artifact.type !== 'paper') {
    return { success: false, error: `Failed to update paper: ${existing.id}` }
  }

  return {
    success: true,
    paper: updated.artifact,
    filePath: updated.filePath
  }
}

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
