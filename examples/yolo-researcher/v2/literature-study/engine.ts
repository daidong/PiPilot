import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

import { ensureDir, fileExists, readTextOrEmpty, writeText } from '../utils.js'

export type LiteratureStudyMode = 'quick' | 'standard' | 'deep'

const CACHE_SCHEMA_VERSION = 'litstudy-cache.v1'
const SOURCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REQUEST_CACHE_ARTIFACTS = ['plan.json', 'papers.json', 'coverage.json', 'summary.json', 'review.md'] as const

interface StudyPaper {
  id: string
  title: string
  authors: string[]
  abstract: string
  year: number
  venue: string | null
  citationCount: number | null
  url: string
  source: string
  doi: string | null
  relevanceScore: number
}

interface StudySubTopic {
  name: string
  description: string
  priority: 'high' | 'medium' | 'low'
  expectedPaperCount: number
  seedTerms: string[]
}

interface StudyQueryBatch {
  subTopic: string
  queries: string[]
  sources: string[]
  priority: number
}

interface StudyCoverage {
  score: number
  subTopics: Array<{
    name: string
    paperCount: number
    covered: boolean
    gaps: string[]
  }>
  queriesExecuted: string[]
}

export interface RunLiteratureStudyInput {
  query: string
  context?: string
  mode: LiteratureStudyMode
  targetPaperCount: number
  projectRootAbs: string
  outputDirAbs: string
  outputDirRel: string
  timeoutMs: number
}

export interface RunLiteratureStudyResult {
  success: boolean
  data?: {
    mode: LiteratureStudyMode
    query: string
    targetPaperCount: number
    totalPapersFound: number
    papersAutoSaved: number
    coverage: StudyCoverage
    planPath: string
    reviewPath: string
    paperListPath: string
    coveragePath: string
    summaryPath: string
    durationMs: number
    errors: string[]
    cache: {
      requestHit: boolean
      sourceHits: number
      sourceMisses: number
      paperCacheHits: number
      paperCacheWrites: number
    }
  }
  error?: string
}

interface SourceCacheRecord {
  schema: string
  source: string
  query: string
  limit: number
  fetchedAt: string
  papers: StudyPaper[]
}

interface PaperCacheRecord {
  schema: string
  items: Record<string, { updatedAt: string; paper: StudyPaper }>
}

interface RequestCacheRecord {
  schema: string
  createdAt: string
  payload: {
    mode: LiteratureStudyMode
    query: string
    targetPaperCount: number
    totalPapersFound: number
    papersAutoSaved: number
    coverage: StudyCoverage
    errors: string[]
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'literature'
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function parseJsonObject<T>(raw: string): T | null {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildCacheRoot(projectRootAbs: string): string {
  return path.join(projectRootAbs, '.yolo-researcher', 'cache', 'literature-study')
}

function normalizeCacheText(value: string): string {
  return normalizeWhitespace(value).toLowerCase()
}

function getRequestCacheKey(input: {
  query: string
  context?: string
  mode: LiteratureStudyMode
  targetPaperCount: number
}): string {
  return hashValue({
    schema: CACHE_SCHEMA_VERSION,
    query: normalizeCacheText(input.query),
    context: normalizeCacheText(input.context || ''),
    mode: input.mode,
    targetPaperCount: input.targetPaperCount
  })
}

function getSourceCacheKey(source: string, query: string, limit: number): string {
  return hashValue({
    schema: CACHE_SCHEMA_VERSION,
    source,
    query: normalizeCacheText(query),
    limit
  })
}

function getPaperCacheKey(paper: StudyPaper): string {
  const doi = normalizeCacheText(paper.doi || '')
  if (doi) return `doi:${doi}`
  const title = normalizeCacheText(paper.title || '')
  if (title) return `title:${title}`
  const id = normalizeCacheText(paper.id || '')
  if (id) return `id:${id}`
  return ''
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
}

function splitTopicHints(query: string, context: string): string[] {
  const raw = `${query};${context || ''}`
  return raw
    .split(/[;,]| and | vs | with /i)
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean)
    .slice(0, 6)
}

function buildSubTopics(query: string, context: string, mode: LiteratureStudyMode, targetPaperCount: number): StudySubTopic[] {
  const hints = splitTopicHints(query, context)
  const subTopics: StudySubTopic[] = []

  const baseCount = mode === 'quick' ? 2 : mode === 'deep' ? 5 : 4
  const used = new Set<string>()
  for (const hint of hints) {
    const normalized = hint.toLowerCase()
    if (!normalized || used.has(normalized)) continue
    used.add(normalized)
    const terms = tokenize(hint).slice(0, 6)
    if (terms.length === 0) continue
    subTopics.push({
      name: hint.length > 80 ? `${hint.slice(0, 77)}...` : hint,
      description: `Evidence for: ${hint}`,
      priority: subTopics.length === 0 ? 'high' : (subTopics.length < 2 ? 'medium' : 'low'),
      expectedPaperCount: Math.max(3, Math.ceil(targetPaperCount / Math.max(1, baseCount))),
      seedTerms: terms
    })
    if (subTopics.length >= baseCount) break
  }

  if (subTopics.length === 0) {
    subTopics.push({
      name: query,
      description: `Evidence for: ${query}`,
      priority: 'high',
      expectedPaperCount: Math.max(4, Math.ceil(targetPaperCount / 2)),
      seedTerms: tokenize(query).slice(0, 8)
    })
  }

  return subTopics
}

function buildQueryBatches(query: string, subTopics: StudySubTopic[], mode: LiteratureStudyMode): StudyQueryBatch[] {
  const maxQueries = mode === 'quick' ? 2 : mode === 'deep' ? 4 : 3
  const sources = ['semantic_scholar', 'arxiv', 'openalex', 'dblp']

  return subTopics.map((topic, idx) => {
    const base = topic.name
    const variants = [
      query,
      base,
      `${base} survey`,
      `${base} benchmark`,
      `${base} methodology`
    ]
    const dedupedQueries: string[] = []
    const seen = new Set<string>()
    for (const value of variants) {
      const normalized = normalizeWhitespace(value)
      if (!normalized) continue
      const key = normalized.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      dedupedQueries.push(normalized)
      if (dedupedQueries.length >= maxQueries) break
    }

    return {
      subTopic: topic.name,
      queries: dedupedQueries,
      sources,
      priority: idx + 1
    }
  })
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

function parseSemanticScholar(data: any): StudyPaper[] {
  const rows = Array.isArray(data?.data) ? data.data : []
  return rows.map((row: any) => {
    const externalIds = row?.externalIds || {}
    return {
      id: String(row?.paperId || ''),
      title: String(row?.title || ''),
      authors: Array.isArray(row?.authors) ? row.authors.slice(0, 20).map((a: any) => String(a?.name || '')).filter(Boolean) : [],
      abstract: String(row?.abstract || ''),
      year: Number(row?.year || 0),
      venue: row?.venue ? String(row.venue) : null,
      citationCount: Number.isFinite(Number(row?.citationCount)) ? Number(row.citationCount) : null,
      url: String(row?.url || `https://www.semanticscholar.org/paper/${row?.paperId || ''}`),
      source: 'semantic_scholar',
      doi: externalIds?.DOI ? String(externalIds.DOI) : null,
      relevanceScore: 0
    }
  })
}

function parseArxiv(xml: string): StudyPaper[] {
  const papers: StudyPaper[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1] || ''
    const id = entry.match(/<id>([^<]+)<\/id>/)?.[1] || ''
    const title = normalizeWhitespace(entry.match(/<title>([^<]+)<\/title>/)?.[1] || '')
    const summary = normalizeWhitespace(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '')
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''
    const authors: string[] = []
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      const name = normalizeWhitespace(authorMatch[1] || '')
      if (name) authors.push(name)
    }
    papers.push({
      id: id.split('/abs/')[1] || id,
      title,
      authors: authors.slice(0, 20),
      abstract: summary,
      year: Number.parseInt(published.slice(0, 4), 10) || 0,
      venue: null,
      citationCount: null,
      url: id,
      source: 'arxiv',
      doi: null,
      relevanceScore: 0
    })
  }
  return papers
}

function parseOpenAlex(data: any): StudyPaper[] {
  const rows = Array.isArray(data?.results) ? data.results : []
  return rows.map((row: any) => {
    let abstract = ''
    const inverted = row?.abstract_inverted_index as Record<string, number[]> | undefined
    if (inverted && typeof inverted === 'object') {
      const words: Array<{ word: string; pos: number }> = []
      for (const [word, positions] of Object.entries(inverted)) {
        if (!Array.isArray(positions)) continue
        for (const pos of positions) {
          if (Number.isFinite(Number(pos))) words.push({ word, pos: Number(pos) })
        }
      }
      words.sort((a, b) => a.pos - b.pos)
      abstract = words.map((item) => item.word).join(' ')
    }
    const authorships = Array.isArray(row?.authorships) ? row.authorships : []
    return {
      id: String(row?.id || ''),
      title: String(row?.title || ''),
      authors: authorships.slice(0, 20).map((a: any) => String(a?.author?.display_name || '')).filter(Boolean),
      abstract,
      year: Number(row?.publication_year || 0),
      venue: row?.primary_location?.source?.display_name ? String(row.primary_location.source.display_name) : null,
      citationCount: Number.isFinite(Number(row?.cited_by_count)) ? Number(row.cited_by_count) : null,
      url: String(row?.id || ''),
      source: 'openalex',
      doi: typeof row?.doi === 'string' ? row.doi.replace('https://doi.org/', '') : null,
      relevanceScore: 0
    }
  })
}

function parseDblp(data: any): StudyPaper[] {
  const hits = Array.isArray(data?.result?.hits?.hit) ? data.result.hits.hit : []
  return hits.map((hit: any) => {
    const info = hit?.info || {}
    const rawAuthors = info?.authors?.author
    const authors = Array.isArray(rawAuthors)
      ? rawAuthors.slice(0, 20).map((row: any) => String(row?.text || '')).filter(Boolean)
      : rawAuthors?.text ? [String(rawAuthors.text)] : []
    return {
      id: String(info?.['@key'] || hit?.['@id'] || ''),
      title: String(info?.title || ''),
      authors,
      abstract: '',
      year: Number(info?.year || 0),
      venue: info?.venue ? String(info.venue) : null,
      citationCount: null,
      url: String(info?.ee || info?.url || ''),
      source: 'dblp',
      doi: info?.doi ? String(info.doi) : null,
      relevanceScore: 0
    }
  })
}

async function searchSource(source: string, query: string, limit: number, timeoutMs: number): Promise<StudyPaper[]> {
  const encoded = encodeURIComponent(query)
  if (source === 'semantic_scholar') {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=${limit}&fields=paperId,title,abstract,year,venue,citationCount,url,authors,externalIds`
    return parseSemanticScholar(await fetchJson(url, timeoutMs))
  }
  if (source === 'arxiv') {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encoded}&max_results=${limit}`
    return parseArxiv(await fetchText(url, timeoutMs))
  }
  if (source === 'openalex') {
    const url = `https://api.openalex.org/works?search=${encoded}&per-page=${limit}`
    return parseOpenAlex(await fetchJson(url, timeoutMs))
  }
  if (source === 'dblp') {
    const url = `https://dblp.org/search/publ/api?q=${encoded}&format=json&h=${limit}`
    return parseDblp(await fetchJson(url, timeoutMs))
  }
  return []
}

function scorePaperRelevance(query: string, paper: StudyPaper): number {
  const queryTokens = tokenize(query)
  const text = `${paper.title} ${paper.abstract}`.toLowerCase()
  let overlap = 0
  for (const token of queryTokens) {
    if (text.includes(token)) overlap += 1
  }
  const overlapScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0
  const citationBonus = Math.min(0.5, (paper.citationCount || 0) / 1000)
  const recencyBonus = paper.year >= 2022 ? 0.15 : paper.year >= 2018 ? 0.05 : 0
  return Number((overlapScore + citationBonus + recencyBonus).toFixed(4))
}

function deduplicatePapers(papers: StudyPaper[]): StudyPaper[] {
  const seen = new Map<string, StudyPaper>()
  for (const paper of papers) {
    const key = (paper.doi || normalizeWhitespace(paper.title).toLowerCase()) || paper.id
    if (!key) continue
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, paper)
      continue
    }
    const existingCitations = existing.citationCount || 0
    const nextCitations = paper.citationCount || 0
    if (nextCitations > existingCitations) {
      seen.set(key, paper)
    }
  }
  return [...seen.values()]
}

function buildCoverage(subTopics: StudySubTopic[], papers: StudyPaper[], queriesExecuted: string[]): StudyCoverage {
  const rows = subTopics.map((topic) => {
    const hits = papers.filter((paper) => {
      const haystack = `${paper.title} ${paper.abstract}`.toLowerCase()
      return topic.seedTerms.some((term) => haystack.includes(term))
    })
    const covered = hits.length >= Math.max(2, Math.floor(topic.expectedPaperCount / 2))
    const gaps = covered ? [] : [`Need more papers for "${topic.name}"`]
    return {
      name: topic.name,
      paperCount: hits.length,
      covered,
      gaps
    }
  })
  const coveredCount = rows.filter((row) => row.covered).length
  const score = rows.length > 0 ? Number((coveredCount / rows.length).toFixed(4)) : 0
  return { score, subTopics: rows, queriesExecuted }
}

function preferString(current: string, next: string): string {
  const left = normalizeWhitespace(current || '')
  const right = normalizeWhitespace(next || '')
  if (!left) return right
  if (!right) return left
  return right.length > left.length ? right : left
}

function preferAuthors(current: string[], next: string[]): string[] {
  if (next.length > current.length) return next
  return current.length > 0 ? current : next
}

function mergePaper(cached: StudyPaper | null, incoming: StudyPaper): StudyPaper {
  if (!cached) return incoming
  return {
    id: preferString(cached.id, incoming.id),
    title: preferString(cached.title, incoming.title),
    authors: preferAuthors(cached.authors, incoming.authors),
    abstract: preferString(cached.abstract, incoming.abstract),
    year: Math.max(cached.year || 0, incoming.year || 0),
    venue: preferString(cached.venue || '', incoming.venue || '') || null,
    citationCount: Math.max(cached.citationCount || 0, incoming.citationCount || 0) || null,
    url: preferString(cached.url, incoming.url),
    source: preferString(cached.source, incoming.source),
    doi: preferString(cached.doi || '', incoming.doi || '') || null,
    relevanceScore: 0
  }
}

function cacheArtifactsDir(requestCacheDir: string): string {
  return path.join(requestCacheDir, 'artifacts')
}

async function copyRequestArtifacts(sourceDir: string, targetDir: string): Promise<boolean> {
  await ensureDir(targetDir)
  for (const fileName of REQUEST_CACHE_ARTIFACTS) {
    const src = path.join(sourceDir, fileName)
    if (!(await fileExists(src))) return false
    await fs.copyFile(src, path.join(targetDir, fileName))
  }
  return true
}

async function loadRequestCache(requestCacheDir: string): Promise<RequestCacheRecord | null> {
  const recordPath = path.join(requestCacheDir, 'result.json')
  const parsed = parseJsonObject<RequestCacheRecord>(await readTextOrEmpty(recordPath))
  if (!parsed || parsed.schema !== CACHE_SCHEMA_VERSION || !parsed.payload) return null
  const artifactsDir = cacheArtifactsDir(requestCacheDir)
  for (const fileName of REQUEST_CACHE_ARTIFACTS) {
    if (!(await fileExists(path.join(artifactsDir, fileName)))) return null
  }
  return parsed
}

async function storeRequestCache(
  requestCacheDir: string,
  outputDirAbs: string,
  payload: RequestCacheRecord['payload']
): Promise<void> {
  const artifactsDir = cacheArtifactsDir(requestCacheDir)
  await ensureDir(requestCacheDir)
  const copied = await copyRequestArtifacts(outputDirAbs, artifactsDir)
  if (!copied) return
  const record: RequestCacheRecord = {
    schema: CACHE_SCHEMA_VERSION,
    createdAt: nowIso(),
    payload
  }
  await writeText(path.join(requestCacheDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`)
}

async function loadPaperCache(paperCachePath: string): Promise<PaperCacheRecord> {
  const parsed = parseJsonObject<PaperCacheRecord>(await readTextOrEmpty(paperCachePath))
  if (parsed && parsed.schema === CACHE_SCHEMA_VERSION && parsed.items && typeof parsed.items === 'object') {
    return parsed
  }
  return {
    schema: CACHE_SCHEMA_VERSION,
    items: {}
  }
}

async function loadSourceCache(sourceCachePath: string, source: string, query: string, limit: number): Promise<StudyPaper[] | null> {
  const parsed = parseJsonObject<SourceCacheRecord>(await readTextOrEmpty(sourceCachePath))
  if (!parsed || parsed.schema !== CACHE_SCHEMA_VERSION) return null
  if (parsed.source !== source || parsed.limit !== limit) return null
  if (normalizeCacheText(parsed.query) !== normalizeCacheText(query)) return null
  const fetchedAtMs = Date.parse(parsed.fetchedAt)
  if (!Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs > SOURCE_CACHE_TTL_MS) return null
  return Array.isArray(parsed.papers) ? parsed.papers : null
}

async function storeSourceCache(
  sourceCachePath: string,
  source: string,
  query: string,
  limit: number,
  papers: StudyPaper[]
): Promise<void> {
  const record: SourceCacheRecord = {
    schema: CACHE_SCHEMA_VERSION,
    source,
    query,
    limit,
    fetchedAt: nowIso(),
    papers
  }
  await writeText(sourceCachePath, `${JSON.stringify(record, null, 2)}\n`)
}

function renderReviewMarkdown(input: {
  query: string
  mode: LiteratureStudyMode
  papers: StudyPaper[]
  coverage: StudyCoverage
  durationMs: number
}): string {
  const lines = [
    `# Literature Study: ${input.query}`,
    '',
    `- mode: ${input.mode}`,
    `- papers: ${input.papers.length}`,
    `- coverage_score: ${input.coverage.score}`,
    `- duration_ms: ${input.durationMs}`,
    '',
    '## Coverage',
    ...input.coverage.subTopics.map((row) => `- ${row.name}: ${row.paperCount} papers (${row.covered ? 'covered' : 'gap'})`),
    '',
    '## Top Papers'
  ]

  for (const paper of input.papers.slice(0, 30)) {
    const venue = paper.venue ? `, ${paper.venue}` : ''
    const citations = paper.citationCount !== null ? `, citations=${paper.citationCount}` : ''
    lines.push(`- ${paper.title} (${paper.year}${venue}${citations}) [${paper.source}]`)
    if (paper.url) lines.push(`  - url: ${paper.url}`)
    if (paper.abstract) lines.push(`  - abstract: ${paper.abstract.slice(0, 220)}${paper.abstract.length > 220 ? '...' : ''}`)
  }

  return `${lines.join('\n')}\n`
}

export async function runLiteratureStudy(input: RunLiteratureStudyInput): Promise<RunLiteratureStudyResult> {
  const query = normalizeWhitespace(input.query)
  if (!query) return { success: false, error: 'query is required' }

  const startedAt = Date.now()
  const cacheRoot = buildCacheRoot(input.projectRootAbs)
  const requestCacheKey = getRequestCacheKey({
    query,
    context: input.context,
    mode: input.mode,
    targetPaperCount: input.targetPaperCount
  })
  const requestCacheDir = path.join(cacheRoot, 'requests', requestCacheKey)
  const sourceCacheDir = path.join(cacheRoot, 'sources')
  const paperCachePath = path.join(cacheRoot, 'papers', 'paper-cache.json')

  const planPathAbs = path.join(input.outputDirAbs, 'plan.json')
  const paperListPathAbs = path.join(input.outputDirAbs, 'papers.json')
  const coveragePathAbs = path.join(input.outputDirAbs, 'coverage.json')
  const summaryPathAbs = path.join(input.outputDirAbs, 'summary.json')
  const reviewPathAbs = path.join(input.outputDirAbs, 'review.md')
  const toRel = (abs: string) => `${input.outputDirRel}/${path.basename(abs)}`

  const cachedRequest = await loadRequestCache(requestCacheDir)
  if (cachedRequest) {
    const copied = await copyRequestArtifacts(cacheArtifactsDir(requestCacheDir), input.outputDirAbs)
    if (copied) {
      return {
        success: true,
        data: {
          mode: cachedRequest.payload.mode,
          query: cachedRequest.payload.query,
          targetPaperCount: cachedRequest.payload.targetPaperCount,
          totalPapersFound: cachedRequest.payload.totalPapersFound,
          papersAutoSaved: cachedRequest.payload.papersAutoSaved,
          coverage: cachedRequest.payload.coverage,
          planPath: toRel(planPathAbs),
          reviewPath: toRel(reviewPathAbs),
          paperListPath: toRel(paperListPathAbs),
          coveragePath: toRel(coveragePathAbs),
          summaryPath: toRel(summaryPathAbs),
          durationMs: Date.now() - startedAt,
          errors: cachedRequest.payload.errors,
          cache: {
            requestHit: true,
            sourceHits: 0,
            sourceMisses: 0,
            paperCacheHits: 0,
            paperCacheWrites: 0
          }
        }
      }
    }
  }

  const subTopics = buildSubTopics(query, input.context || '', input.mode, input.targetPaperCount)
  const queryBatches = buildQueryBatches(query, subTopics, input.mode)
  const errors: string[] = []
  const queriesExecuted: string[] = []
  const results: StudyPaper[] = []
  let sourceHits = 0
  let sourceMisses = 0
  let paperCacheHits = 0
  let paperCacheWrites = 0

  const perSourceLimit = input.mode === 'quick' ? 5 : input.mode === 'deep' ? 12 : 8
  const paperCache = await loadPaperCache(paperCachePath)

  for (const batch of queryBatches) {
    for (const candidateQuery of batch.queries) {
      queriesExecuted.push(candidateQuery)
      for (const source of batch.sources) {
        const sourceCachePath = path.join(sourceCacheDir, `${source}-${getSourceCacheKey(source, candidateQuery, perSourceLimit)}.json`)
        try {
          const cachedPapers = await loadSourceCache(sourceCachePath, source, candidateQuery, perSourceLimit)
          const papers = cachedPapers ?? await searchSource(source, candidateQuery, perSourceLimit, input.timeoutMs)
          if (cachedPapers) {
            sourceHits += 1
          } else {
            sourceMisses += 1
            await storeSourceCache(sourceCachePath, source, candidateQuery, perSourceLimit, papers)
          }

          for (const paper of papers) {
            const paperKey = getPaperCacheKey(paper)
            const cachedPaper = paperKey ? paperCache.items[paperKey]?.paper || null : null
            if (cachedPaper) paperCacheHits += 1
            const mergedPaper = mergePaper(cachedPaper, paper)
            const normalizedForCache: StudyPaper = { ...mergedPaper, relevanceScore: 0 }

            if (paperKey) {
              const existingSerialized = cachedPaper ? stableStringify(cachedPaper) : ''
              const nextSerialized = stableStringify(normalizedForCache)
              if (!cachedPaper || existingSerialized !== nextSerialized) {
                paperCache.items[paperKey] = {
                  updatedAt: nowIso(),
                  paper: normalizedForCache
                }
                paperCacheWrites += 1
              }
            }

            const score = scorePaperRelevance(query, mergedPaper)
            results.push({ ...mergedPaper, relevanceScore: score })
          }
        } catch (error) {
          sourceMisses += 1
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`${source}[${candidateQuery}]: ${message}`)
        }
      }
    }
  }

  const deduped = deduplicatePapers(results)
  deduped.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore
    return (b.citationCount || 0) - (a.citationCount || 0)
  })
  const topPapers = deduped.slice(0, Math.max(1, input.targetPaperCount))
  const coverage = buildCoverage(subTopics, topPapers, queriesExecuted)
  const durationMs = Date.now() - startedAt

  await ensureDir(input.outputDirAbs)

  await writeText(planPathAbs, `${JSON.stringify({
    topic: query,
    subTopics,
    queryBatches,
    targetPaperCount: input.targetPaperCount,
    minimumCoveragePerSubTopic: 2
  }, null, 2)}\n`)

  await writeText(paperListPathAbs, `${JSON.stringify({
    papers: topPapers
  }, null, 2)}\n`)

  await writeText(coveragePathAbs, `${JSON.stringify(coverage, null, 2)}\n`)

  await writeText(summaryPathAbs, `${JSON.stringify({
    briefSummary: `Literature study found ${topPapers.length} papers with coverage score ${coverage.score}.`,
    totalPapersFound: topPapers.length,
    errors,
    durationMs
  }, null, 2)}\n`)

  await writeText(reviewPathAbs, renderReviewMarkdown({
    query,
    mode: input.mode,
    papers: topPapers,
    coverage,
    durationMs
  }))

  if (paperCacheWrites > 0) {
    await writeText(paperCachePath, `${JSON.stringify(paperCache, null, 2)}\n`)
  }

  await storeRequestCache(requestCacheDir, input.outputDirAbs, {
    mode: input.mode,
    query,
    targetPaperCount: input.targetPaperCount,
    totalPapersFound: topPapers.length,
    papersAutoSaved: topPapers.length,
    coverage,
    errors
  })

  return {
    success: true,
    data: {
      mode: input.mode,
      query,
      targetPaperCount: input.targetPaperCount,
      totalPapersFound: topPapers.length,
      papersAutoSaved: topPapers.length,
      coverage,
      planPath: toRel(planPathAbs),
      reviewPath: toRel(reviewPathAbs),
      paperListPath: toRel(paperListPathAbs),
      coveragePath: toRel(coveragePathAbs),
      summaryPath: toRel(summaryPathAbs),
      durationMs,
      errors,
      cache: {
        requestHit: false,
        sourceHits,
        sourceMisses,
        paperCacheHits,
        paperCacheWrites
      }
    }
  }
}
