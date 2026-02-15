import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type CLIContext, type Literature, PATHS } from './types.js'

export interface UpsertPaperResult {
  success: boolean
  paper?: Literature
  filePath?: string
  error?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function papersDir(projectPath: string): string {
  return join(projectPath, PATHS.papers)
}

function normalizeDoi(doi: string): string {
  return doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '').trim()
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function readAllPapers(projectPath: string): Literature[] {
  const dir = papersDir(projectPath)
  if (!existsSync(dir)) return []

  const papers: Literature[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const filePath = join(dir, file)
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Literature
      if (raw.type === 'paper' && raw.id && raw.title) papers.push(raw)
    } catch {
      // Skip invalid paper records.
    }
  }
  return papers
}

function findExistingPaperByIdentity(
  projectPath: string,
  identity: { doi?: string | null; citeKey?: string | null; title: string; year?: number | null }
): Literature | null {
  const papers = readAllPapers(projectPath)

  if (identity.doi) {
    const inputDoi = normalizeDoi(identity.doi)
    const byDoi = papers.find(p => p.doi && normalizeDoi(p.doi) === inputDoi)
    if (byDoi) return byDoi
  }

  if (identity.citeKey) {
    const key = identity.citeKey.trim().toLowerCase()
    const byCiteKey = papers.find(p => p.citeKey.trim().toLowerCase() === key)
    if (byCiteKey) return byCiteKey
  }

  const title = normalizeTitle(identity.title)
  const byTitleYear = papers.find(p => {
    if (normalizeTitle(p.title) !== title) return false
    if (!identity.year || !p.year) return true
    return p.year === identity.year
  })
  return byTitleYear ?? null
}

function writePaper(projectPath: string, paper: Literature): string {
  const dir = papersDir(projectPath)
  ensureDir(dir)
  const filePath = join(dir, `${paper.id}.json`)
  writeFileSync(filePath, JSON.stringify(paper, null, 2), 'utf-8')
  return filePath
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

export function upsertPaperArtifact(
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
): UpsertPaperResult {
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

  const existing = findExistingPaperByIdentity(context.projectPath, {
    doi,
    citeKey,
    title,
    year: opts.year
  })

  if (existing) {
    const merged: Literature = {
      ...existing,
      title,
      authors,
      abstract: opts.abstract ?? existing.abstract,
      year: opts.year ?? existing.year,
      venue: opts.venue ?? existing.venue,
      url: opts.url ?? existing.url,
      citeKey,
      doi,
      bibtex,
      pdfUrl: opts.pdfUrl ?? existing.pdfUrl,
      searchKeywords: opts.searchKeywords ?? existing.searchKeywords,
      externalSource: opts.externalSource ?? existing.externalSource,
      relevanceScore: opts.relevanceScore ?? existing.relevanceScore,
      citationCount: opts.citationCount ?? existing.citationCount,
      tags: opts.tags ?? existing.tags,
      updatedAt: nowIso()
    }

    return {
      success: true,
      paper: merged,
      filePath: writePaper(context.projectPath, merged)
    }
  }

  const timestamp = nowIso()
  const paper: Literature = {
    id: randomUUID(),
    type: 'paper',
    title,
    tags: opts.tags ?? [],
    provenance: {
      source: opts.externalSource ? 'agent' : 'user',
      sessionId: context.sessionId,
      agentId: opts.externalSource ? 'literature-team' : undefined,
      extractedFrom: opts.externalSource ? 'agent-response' : 'user-input'
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    citeKey,
    bibtex,
    doi,
    authors,
    abstract: opts.abstract ?? '',
    year: opts.year,
    venue: opts.venue,
    url: opts.url,
    pdfUrl: opts.pdfUrl,
    searchKeywords: opts.searchKeywords,
    externalSource: opts.externalSource,
    relevanceScore: opts.relevanceScore,
    citationCount: opts.citationCount
  }

  return {
    success: true,
    paper,
    filePath: writePaper(context.projectPath, paper)
  }
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
): UpsertPaperResult {
  const update: Partial<Literature> = {}

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

  const merged: Literature = {
    ...existing,
    ...update,
    updatedAt: nowIso()
  }

  return {
    success: true,
    paper: merged,
    filePath: writePaper(context.projectPath, merged)
  }
}
