/**
 * Literature Research Team v2 (RFC-008)
 *
 * Major changes from v1:
 * - Planner generates a full SearchPlan with sub-topics and query batches
 * - Planner receives filtered conversation history + local library state
 * - Searcher executes all query batches with rate limiting + circuit breaker
 * - Metadata enrichment fills missing DOI, abstract, venue, citationCount
 * - Reviewer uses stricter scoring (>= 8 threshold) with forced ranking
 * - Compressed result with coverage state returned to coordinator
 * - Full review saved to disk (.research-pilot/reviews/)
 *
 * Flow: planner → searcher (all batches) → loop(reviewer → searcher) → summarizer
 */

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  createAutoTeamRuntime,
  simpleStep,
  simpleBranch
} from '../../../src/team/index.js'

import {
  defineAgent as defineSimpleAgent,
  createAgentContext,
  type Agent as SimpleAgent,
  type AgentContext
} from '../../../src/agent/define-simple-agent.js'

import { getLanguageModelByModelId } from '../../../src/index.js'
import { loadPrompt } from './prompts/index.js'

import { searchLocalPapers, findExistingPaper, scanLocalLibrary } from './local-paper-lookup.js'
import { getBibtex, type PaperMetadata } from './bibtex-utils.js'
import { savePaper, updatePaperMetadata } from '../commands/save-paper.js'
import { RateLimiter, CircuitBreaker, DEFAULT_SEARCHER_CONFIG } from './rate-limiter.js'
import { enrichPapers, createEnrichmentConfig, type PaperInput } from './metadata-enrichment.js'
import type {
  CLIContext,
  SearchPlan,
  QueryBatch,
  PlannerContext,
  FilteredMessage,
  LiteratureSearchResult,
  CoverageTracker
} from '../types.js'
import { PATHS } from '../types.js'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

// ============================================================================
// Conversation Filter (mechanical, no LLM)
// ============================================================================

/**
 * Filter coordinator messages to extract only user messages and
 * literature-search tool call results. This provides the planner
 * with focused context about what the user wants and what was already found.
 */
export function filterConversationForPlanner(messages: unknown[]): FilteredMessage[] {
  const filtered: FilteredMessage[] = []

  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown }
    if (!m.role) continue

    if (m.role === 'user' && typeof m.content === 'string') {
      // Skip system injections
      if (m.content.startsWith('[REFERENCE MATERIAL]')) continue
      if (m.content.startsWith('<accumulated-findings>')) continue
      if (m.content.startsWith('[System Notice]')) continue
      filtered.push({ role: 'user', content: m.content })
    }

    // Tool results: look for literature-search results
    if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as { type?: string; content?: string; tool_use_id?: string }
        if (b.type === 'tool_result' && b.content) {
          try {
            const parsed = JSON.parse(b.content)
            // Check if this looks like a literature-search result
            if (parsed.data?.coverage || parsed.data?.summary || parsed.summary) {
              filtered.push({
                role: 'tool-result',
                content: b.content,
                toolName: 'literature-search'
              })
            }
          } catch {
            // Not JSON, skip
          }
        }
      }
    }
  }

  return filtered
}

// ============================================================================
// Agent Definitions
// ============================================================================

const planner = defineSimpleAgent({
  id: 'planner',
  description: 'Search Plan Specialist for academic literature research',

  system: loadPrompt('literature-planner-system'),

  prompt: (input) => {
    const data = input as { plannerContext?: PlannerContext; userRequest?: string } | string
    if (typeof data === 'string') {
      return `Create a comprehensive search plan for this research request:\n\n"${data}"`
    }

    const ctx = (data as { plannerContext?: PlannerContext }).plannerContext
    if (!ctx) {
      const request = (data as { userRequest?: string }).userRequest ?? ''
      return `Create a comprehensive search plan for this research request:\n\n"${request}"`
    }

    // Build a rich prompt with conversation history and local library state
    let prompt = `Create a comprehensive search plan for this research request:\n\n"${ctx.request}"`

    if (ctx.conversationHistory.length > 0) {
      prompt += '\n\n## Previous conversation context\n'
      for (const msg of ctx.conversationHistory) {
        if (msg.role === 'user') {
          prompt += `\n[User]: ${msg.content}`
        } else if (msg.role === 'tool-result') {
          prompt += `\n[Previous literature-search result]: ${msg.content}`
        }
      }
    }

    if (ctx.localLibrary.totalPapers > 0) {
      prompt += `\n\n## Local library state\n`
      prompt += `Total papers already saved: ${ctx.localLibrary.totalPapers}\n`
      for (const cluster of ctx.localLibrary.topicClusters) {
        prompt += `- "${cluster.topic}": ${cluster.count} papers (e.g. ${cluster.sampleTitles.slice(0, 2).join(', ')})\n`
      }
    }

    return prompt
  }
})

const reviewer = defineSimpleAgent({
  id: 'reviewer',
  description: 'Research Quality Reviewer with strict scoring rubric',

  system: loadPrompt('literature-reviewer-system'),

  prompt: (input) => {
    const data = input as {
      papers?: Array<{ id: string; title: string; year: number; abstract: string; source?: string; doi?: string | null; venue?: string | null; citationCount?: number | null }>
      queriesUsed?: string[]
      userRequest?: string
      metadata?: { apiCallCount?: number; totalDurationMs?: number }
    }
    const papers = data?.papers ?? []
    const queries = data?.queriesUsed ?? []
    const userRequest = data?.userRequest ?? ''

    const localCount = papers.filter(p => p.source === 'local').length
    const sourceInfo = localCount > 0 ? ` (${localCount} from local library)` : ''

    const paperSummaries = papers
      .slice(0, 20)
      .map((p, i) => {
        const sourceTag = p.source ? ` [${p.source}]` : ''
        const doiTag = p.doi ? ` doi:${p.doi}` : ''
        const venueTag = p.venue ? ` venue:${p.venue}` : ''
        const citeTag = p.citationCount != null ? ` citations:${p.citationCount}` : ''
        const authorsList = Array.isArray((p as any).authors) ? ` authors:${(p as any).authors.join(', ')}` : ''
        return `Paper ${i + 1} (id: ${p.id})${sourceTag}${doiTag}${venueTag}${citeTag}${authorsList}: "${p.title}" (${p.year})\nAbstract: ${p.abstract ?? '(none)'}`
      })
      .join('\n')

    let prompt = `Original user research request:\n"${userRequest}"\n\nReview these ${papers.length} papers${sourceInfo} against the user's request. Apply the STRICT scoring rubric (>= 8 for auto-save, forced ranking to cut bottom 30%):\n\n${paperSummaries}`

    // Explicitly list queries already used so the reviewer avoids duplicates in additionalQueries
    prompt += `\n\n## Queries already executed (DO NOT repeat these in additionalQueries)\n${queries.map((q, i) => `${i + 1}. "${q}"`).join('\n')}`

    return prompt
  }
})

const summarizer = defineSimpleAgent({
  id: 'summarizer',
  description: 'Research Synthesizer who creates comprehensive summaries',

  system: loadPrompt('literature-summarizer-system'),

  prompt: (input) => {
    const data = input as {
      relevantPapers?: Array<{ title: string; authors: string[]; year: number; abstract: string; source?: string }>
      coverage?: { coveredTopics?: string[]; score?: number; missingTopics?: string[] }
      userRequest?: string
    }
    const papers = data?.relevantPapers ?? []
    const coverage = data?.coverage
    const userRequest = data?.userRequest ?? ''

    const localCount = papers.filter(p => p.source === 'local').length
    const externalCount = papers.length - localCount

    const paperDetails = papers
      .slice(0, 15)
      .map((p, i) => `Paper ${i + 1}: "${p.title}" by ${(p.authors ?? []).slice(0, 3).join(', ')} (${p.year}) [source: ${p.source ?? 'unknown'}]\nAbstract: ${p.abstract?.slice(0, 350) ?? ''}`)
      .join('\n\n')

    const sourceInfo = localCount > 0
      ? `\n\nSource breakdown: ${localCount} from local library, ${externalCount} from external sources.`
      : ''

    const coverageInfo = coverage
      ? `\n\nCoverage score: ${coverage.score ?? 'N/A'}\nCovered topics: ${(coverage.coveredTopics ?? []).join(', ')}\nMissing topics: ${(coverage.missingTopics ?? []).join(', ')}`
      : ''

    return `Original user research request:\n"${userRequest}"\n\nCreate a literature review summary from these papers that addresses the user's request:\n\n${paperDetails}${sourceInfo}${coverageInfo}`
  }
})

// ============================================================================
// Searcher Agent (Tool-based, no LLM) — v2 with rate limiting
// ============================================================================

interface Paper {
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
  pdfUrl: string | null
  relevanceScore: number | null
}

interface SearchMetadata {
  sourcesTried: string[]
  sourcesSucceeded: string[]
  sourcesFailed: string[]
  totalDurationMs: number
  allSourcesSucceeded: boolean
  hasResults: boolean
  localPapersFound: number
  externalPapersFound: number
  apiCallCount: number
  apiFailureCount: number
}

interface SearchResults {
  papers: Paper[]
  totalFound: number
  queriesUsed: string[]
  metadata: SearchMetadata
}

/** Callback for emitting real-time activity events from inside the searcher */
export type SearcherActivityCallback = (phase: 'search-batch-start' | 'search-batch-done' | 'enrich-start' | 'enrich-done', detail: string) => void

function createSearcherAgent(
  projectPath?: string,
  rateLimiter?: RateLimiter,
  circuitBreaker?: CircuitBreaker,
  onActivity?: SearcherActivityCallback
) {
  return {
    id: 'searcher',
    kind: 'tool-agent' as const,

    async run(input: {
      queries?: string[]
      dblpQueries?: string[]
      sources?: string[]
      queryBatches?: QueryBatch[]
    }): Promise<{ output: SearchResults }> {
      const startTime = Date.now()
      const config = DEFAULT_SEARCHER_CONFIG
      const allPapers: Paper[] = []
      const sourcesTried: string[] = []
      const sourcesSucceeded: string[] = []
      const sourcesFailed: string[] = []
      let localPapersFound = 0
      let apiCallCount = 0
      let apiFailureCount = 0
      const allQueriesUsed: string[] = []

      // Determine what to search: either queryBatches (v2) or flat queries (v1 compat)
      const flatQueries = input.queries ?? []
      const fallbackName = flatQueries.length > 0
        ? flatQueries[0].slice(0, 60) + (flatQueries[0].length > 60 ? '...' : '')
        : 'Search'
      const batches: QueryBatch[] = input.queryBatches ?? [{
        subTopic: fallbackName,
        queries: flatQueries,
        dblpQueries: input.dblpQueries,
        sources: input.sources ?? ['semantic_scholar', 'arxiv', 'openalex', 'dblp'],
        priority: 1
      }]

      // Sort batches by priority (lower number = higher priority)
      batches.sort((a, b) => a.priority - b.priority)

      if (batches.every(b => b.queries.length === 0 && (!b.dblpQueries || b.dblpQueries.length === 0))) {
        const metadata: SearchMetadata = {
          sourcesTried: [], sourcesSucceeded: [], sourcesFailed: [],
          totalDurationMs: 0, allSourcesSucceeded: true, hasResults: false,
          localPapersFound: 0, externalPapersFound: 0, apiCallCount: 0, apiFailureCount: 0
        }
        return { output: { papers: [], totalFound: 0, queriesUsed: [], metadata } }
      }

      // Step 1: Search local papers first
      if (projectPath) {
        try {
          const allQueries = batches.flatMap(b => b.queries)
          const localMatches = searchLocalPapers(allQueries, projectPath)
          localPapersFound = localMatches.length

          if (localMatches.length > 0) {
            console.log(`  [Searcher] Found ${localMatches.length} papers from local library`)
            for (const match of localMatches) {
              const lit = match.paper
              allPapers.push({
                id: lit.id,
                title: lit.title,
                authors: lit.authors,
                abstract: lit.abstract || '',
                year: lit.year || 0,
                venue: lit.venue || null,
                citationCount: lit.citationCount ?? null,
                url: lit.url || '',
                source: 'local',
                doi: lit.doi || null,
                pdfUrl: null,
                relevanceScore: lit.relevanceScore ?? null
              })
            }
            if (!sourcesTried.includes('local')) sourcesTried.push('local')
            if (!sourcesSucceeded.includes('local')) sourcesSucceeded.push('local')
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.log(`  [Searcher] Local lookup failed: ${msg}`)
        }
      }

      // Step 2: Execute query batches — parallelize sources within each batch
      for (const batch of batches) {
        // Check session timeout
        if (Date.now() - startTime > config.maxTimeMs) {
          console.log('  [Searcher] Session timeout reached, stopping search')
          break
        }

        // Check global API call cap
        if (apiCallCount >= config.maxTotalApiCalls) {
          console.log('  [Searcher] Global API call cap reached, stopping search')
          break
        }

        onActivity?.('search-batch-start', `Searching: ${batch.subTopic}`)

        // Build all (source, query) pairs for this batch, then run them concurrently per-source
        const sourcePromises: Promise<void>[] = []

        for (const source of batch.sources) {
          if (!sourcesTried.includes(source)) sourcesTried.push(source)

          if (circuitBreaker && !circuitBreaker.isAllowed(source)) {
            console.log(`  [Searcher] Circuit breaker open for ${source}, skipping`)
            if (!sourcesFailed.includes(source)) sourcesFailed.push(source)
            continue
          }

          const sourceQueries = (source === 'dblp' && batch.dblpQueries && batch.dblpQueries.length > 0)
            ? batch.dblpQueries
            : batch.queries

          // Run all queries for this source sequentially (rate-limited), but run sources in parallel
          const sourceWork = async () => {
            for (const query of sourceQueries) {
              if (apiCallCount >= config.maxTotalApiCalls) break
              if (Date.now() - startTime > config.maxTimeMs) break

              try {
                if (rateLimiter) await rateLimiter.acquire(source)

                apiCallCount++
                const papers = await searchSource(source, query, 8)
                allPapers.push(...papers)
                allQueriesUsed.push(query)

                if (rateLimiter) rateLimiter.release(source)
                if (circuitBreaker) circuitBreaker.recordSuccess(source)
                if (!sourcesSucceeded.includes(source)) sourcesSucceeded.push(source)
              } catch (error) {
                if (rateLimiter) rateLimiter.release(source)
                if (circuitBreaker) circuitBreaker.recordFailure(source)
                apiFailureCount++

                const msg = error instanceof Error ? error.message : String(error)
                console.log(`  [Searcher] ${source} failed for "${query.slice(0, 40)}...": ${msg}`)
                if (!sourcesFailed.includes(source)) sourcesFailed.push(source)
              }
            }
          }

          sourcePromises.push(sourceWork())
        }

        // Wait for all sources in this batch to complete (parallel across sources)
        await Promise.all(sourcePromises)
        onActivity?.('search-batch-done', `Done: ${batch.subTopic}`)
      }

      // Step 3: Deduplicate (keeps local papers, skips external duplicates)
      const uniquePapers = deduplicatePapersPreferLocal(allPapers)
      const externalPapersFound = uniquePapers.filter(p => p.source !== 'local').length

      // Step 4: Metadata enrichment (non-LLM) — reduced time budget for responsiveness
      if (rateLimiter && circuitBreaker && uniquePapers.length > 0) {
        onActivity?.('enrich-start', `Enriching ${uniquePapers.length} papers metadata`)
        try {
          const enrichConfig = createEnrichmentConfig(rateLimiter, circuitBreaker)
          // Use shorter time budget to avoid blocking the pipeline
          enrichConfig.maxTimeMs = 15_000
          enrichConfig.maxPapersToEnrich = 20
          const enrichStats = await enrichPapers(uniquePapers as PaperInput[], enrichConfig)
          console.log(`  [Searcher] Enriched ${enrichStats.enriched} papers (${enrichStats.skipped} skipped, ${enrichStats.failed} failed)`)
          apiCallCount += enrichStats.enriched * 2
          onActivity?.('enrich-done', `Enriched ${enrichStats.enriched} papers`)
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.log(`  [Searcher] Metadata enrichment failed: ${msg}`)
          onActivity?.('enrich-done', `Enrichment failed: ${msg}`)
        }
      }

      const totalDurationMs = Date.now() - startTime
      const metadata: SearchMetadata = {
        sourcesTried, sourcesSucceeded, sourcesFailed,
        totalDurationMs,
        allSourcesSucceeded: sourcesFailed.length === 0,
        hasResults: uniquePapers.length > 0,
        localPapersFound,
        externalPapersFound,
        apiCallCount,
        apiFailureCount
      }

      return {
        output: {
          papers: uniquePapers,
          totalFound: uniquePapers.length,
          queriesUsed: [...new Set(allQueriesUsed)],
          metadata
        }
      }
    }
  }
}

// ============================================================================
// Search Utilities
// ============================================================================

async function searchSource(source: string, query: string, limit: number): Promise<Paper[]> {
  const encodedQuery = encodeURIComponent(query)
  const timeoutMs = source === 'arxiv' ? 20000 : 15000
  let url: string

  switch (source) {
    case 'semantic_scholar':
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${limit}&fields=paperId,title,abstract,year,venue,citationCount,url,authors,externalIds`
      break
    case 'arxiv':
      url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&max_results=${limit}`
      break
    case 'openalex':
      url = `https://api.openalex.org/works?search=${encodedQuery}&per-page=${limit}`
      break
    case 'dblp':
      url = `https://dblp.org/search/publ/api?q=${encodedQuery}&format=json&h=${limit}`
      break
    default:
      return []
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) return []

  if (source === 'arxiv') return parseArxiv(await response.text())
  const data = await response.json()
  if (source === 'semantic_scholar') return parseSemanticScholar(data)
  if (source === 'dblp') return parseDblp(data)
  return parseOpenAlex(data)
}

function parseSemanticScholar(data: { data?: Array<Record<string, unknown>> }): Paper[] {
  return (data.data || []).map((p): Paper => {
    const externalIds = (p.externalIds as Record<string, string>) || {}
    return {
      id: String(p.paperId || ''),
      title: String(p.title || 'Unknown'),
      authors: ((p.authors as Array<{ name: string }>) || []).slice(0, 20).map(a => a.name),
      abstract: String(p.abstract || ''),
      year: Number(p.year) || 0,
      venue: (p.venue as string) ?? null,
      citationCount: (p.citationCount as number) ?? null,
      url: String(p.url || `https://www.semanticscholar.org/paper/${p.paperId}`),
      source: 'semantic_scholar',
      doi: externalIds.DOI || null,
      pdfUrl: null,
      relevanceScore: null
    }
  })
}

function parseArxiv(xml: string): Paper[] {
  const papers: Paper[] = []
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
  let match
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]
    const id = entry.match(/<id>([^<]+)<\/id>/)?.[1] || ''
    const title = entry.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || ''
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || ''
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] || ''
    const authors: string[] = []
    const authorRegex = /<author>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/g
    let authorMatch
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1])
    }
    papers.push({
      id: id.split('/abs/')[1] || id,
      title, authors: authors.slice(0, 20), abstract: summary,
      year: parseInt(published.slice(0, 4)) || 0,
      url: id, source: 'arxiv',
      venue: null, citationCount: null, doi: null, pdfUrl: null, relevanceScore: null
    })
  }
  return papers
}

function parseOpenAlex(data: { results?: Array<Record<string, unknown>> }): Paper[] {
  return (data.results || []).map((w): Paper => {
    let abstract = ''
    const inverted = w.abstract_inverted_index as Record<string, number[]> | undefined
    if (inverted) {
      const words: [string, number][] = []
      for (const [word, positions] of Object.entries(inverted)) {
        for (const pos of positions) words.push([word, pos])
      }
      words.sort((a, b) => a[1] - b[1])
      abstract = words.map(w => w[0]).join(' ')
    }
    return {
      id: String(w.id),
      title: String(w.title || 'Unknown'),
      authors: ((w.authorships as Array<{ author: { display_name: string } }>) || [])
        .slice(0, 20).map(a => a.author.display_name),
      abstract,
      year: Number(w.publication_year) || 0,
      venue: (w.primary_location as { source?: { display_name: string } })?.source?.display_name ?? null,
      citationCount: (w.cited_by_count as number) ?? null,
      url: String(w.id), source: 'openalex',
      doi: typeof w.doi === 'string' ? w.doi.replace('https://doi.org/', '') : null,
      pdfUrl: null, relevanceScore: null
    }
  })
}

function parseDblp(data: { result?: { hits?: { hit?: Array<Record<string, unknown>> } } }): Paper[] {
  const hits = data?.result?.hits?.hit ?? []
  return hits.map((h): Paper => {
    const info = (h.info ?? {}) as Record<string, unknown>
    const rawAuthors = info.authors as { author: { text: string } | Array<{ text: string }> } | undefined
    let authors: string[] = []
    if (rawAuthors?.author) {
      authors = Array.isArray(rawAuthors.author)
        ? rawAuthors.author.slice(0, 20).map(a => a.text)
        : [rawAuthors.author.text]
    }
    return {
      id: String(info['@key'] ?? h['@id'] ?? ''),
      title: String(info.title ?? 'Unknown'),
      authors,
      abstract: '', // DBLP does not provide abstracts
      year: Number(info.year) || 0,
      venue: (info.venue as string) ?? null,
      citationCount: null,
      url: String(info.ee ?? info.url ?? `https://dblp.org/rec/${info['@key']}`),
      source: 'dblp',
      doi: (info.doi as string) ?? null,
      pdfUrl: null,
      relevanceScore: null
    }
  })
}

/**
 * Deduplicate papers, preferring local copies over external duplicates.
 */
function deduplicatePapersPreferLocal(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>()

  for (const paper of papers) {
    const key = paper.doi || paper.title.toLowerCase().replace(/\s+/g, ' ').trim()
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, paper)
    } else if (paper.source === 'local' && existing.source !== 'local') {
      seen.set(key, paper)
    } else if (paper.source !== 'local' && existing.source === 'local') {
      // Keep existing local copy
    } else {
      if ((paper.citationCount || 0) > (existing.citationCount || 0)) {
        seen.set(key, paper)
      }
    }
  }

  return Array.from(seen.values())
}

// ============================================================================
// Review Output Saving
// ============================================================================

/**
 * Save the full review and paper list to disk.
 */
function saveReviewToDisk(
  projectPath: string,
  reviewId: string,
  summary: unknown,
  papers: unknown[],
  coverage: unknown
): { reviewPath: string; paperListPath: string } {
  const reviewsDir = join(projectPath, PATHS.reviews)
  if (!existsSync(reviewsDir)) {
    mkdirSync(reviewsDir, { recursive: true })
  }

  const reviewPath = join(reviewsDir, `${reviewId}.md`)
  const paperListPath = join(reviewsDir, `${reviewId}-papers.json`)

  // Write full review as markdown
  const summaryData = summary as Record<string, unknown> | undefined
  let markdown = `# Literature Review: ${summaryData?.title ?? 'Untitled'}\n\n`
  markdown += `Generated: ${new Date().toISOString()}\n\n`
  markdown += `## Overview\n\n${summaryData?.overview ?? ''}\n\n`

  const themes = (summaryData?.themes as Array<{ name: string; insight: string; papers: string[] }>) ?? []
  if (themes.length > 0) {
    markdown += `## Themes\n\n`
    for (const theme of themes) {
      markdown += `### ${theme.name}\n\n${theme.insight}\n\nPapers: ${theme.papers.join(', ')}\n\n`
    }
  }

  const findings = (summaryData?.keyFindings as string[]) ?? []
  if (findings.length > 0) {
    markdown += `## Key Findings\n\n`
    for (const f of findings) markdown += `- ${f}\n`
    markdown += '\n'
  }

  const gaps = (summaryData?.researchGaps as string[]) ?? []
  if (gaps.length > 0) {
    markdown += `## Research Gaps\n\n`
    for (const g of gaps) markdown += `- ${g}\n`
    markdown += '\n'
  }

  writeFileSync(reviewPath, markdown, 'utf-8')
  writeFileSync(paperListPath, JSON.stringify({ papers, coverage }, null, 2), 'utf-8')

  return {
    reviewPath: join(PATHS.reviews, `${reviewId}.md`),
    paperListPath: join(PATHS.reviews, `${reviewId}-papers.json`)
  }
}

// ============================================================================
// Team Definition & Factory
// ============================================================================

export function createLiteratureTeam(config: {
  apiKey: string
  model?: string
  maxReviewIterations?: number
  projectPath?: string
  sessionId?: string
  messages?: unknown[]
  onSearcherActivity?: SearcherActivityCallback
}) {
  const {
    apiKey,
    model = 'gpt-5.2',
    maxReviewIterations = 2,
    projectPath,
    sessionId = 'default',
    messages: coordinatorMessages,
    onSearcherActivity
  } = config
  if (!apiKey) throw new Error('API key is required')

  const languageModel = getLanguageModelByModelId(model, { apiKey })

  // Create shared rate limiter and circuit breaker
  const rateLimiter = new RateLimiter(DEFAULT_SEARCHER_CONFIG.rateLimits)
  const circuitBreakerInstance = new CircuitBreaker(DEFAULT_SEARCHER_CONFIG.circuitBreaker)

  const searcherAgent = createSearcherAgent(projectPath, rateLimiter, circuitBreakerInstance, onSearcherActivity)

  const agentCtx: AgentContext = {
    getLanguageModel: () => languageModel
  }

  const createLLMRunner = (agent: SimpleAgent) => {
    return async (input: unknown) => {
      const result = await agent.run(input, agentCtx)
      if (!result.success) throw new Error(result.error ?? 'Agent execution failed')
      return result.output
    }
  }

  // Track all queries used across rounds to prevent duplicate searches
  const allQueriesUsedAcrossRounds = new Set<string>()

  const createSearcherRunner = () => {
    return async (input: unknown) => {
      const data = input as {
        searchQueries?: string[]
        dblpQueries?: string[] | null
        searchStrategy?: { suggestedSources?: string[] }
        additionalQueries?: string[] | null
        queries?: string[]
        sources?: string[]
        queryBatches?: QueryBatch[]
        // From reviewer output
        coverage?: { missingTopics?: string[]; gaps?: string[] }
      }

      // v2: Use queryBatches if available
      if (data.queryBatches && data.queryBatches.length > 0) {
        // Dedup queries against previous rounds
        for (const batch of data.queryBatches) {
          batch.queries = batch.queries.filter(q => {
            const normalized = q.toLowerCase().trim()
            if (allQueriesUsedAcrossRounds.has(normalized)) {
              console.log(`  [Searcher] Skipping duplicate query: "${q.slice(0, 50)}..."`)
              return false
            }
            return true
          })
        }
        // Remove empty batches
        const nonEmptyBatches = data.queryBatches.filter(b => b.queries.length > 0)
        if (nonEmptyBatches.length === 0) {
          console.log('  [Searcher] All queries were duplicates, skipping search round')
          return { papers: [], totalFound: 0, queriesUsed: [], metadata: {
            sourcesTried: [], sourcesSucceeded: [], sourcesFailed: [],
            totalDurationMs: 0, allSourcesSucceeded: true, hasResults: false,
            localPapersFound: 0, externalPapersFound: 0, apiCallCount: 0, apiFailureCount: 0
          }}
        }
        const result = await searcherAgent.run({ queryBatches: nonEmptyBatches })
        // Track used queries
        for (const q of result.output.queriesUsed) {
          allQueriesUsedAcrossRounds.add(q.toLowerCase().trim())
        }
        return result.output
      }

      // v1 compat / reviewer refinement: wrap flat queries in a proper batch
      const queries = data.additionalQueries ?? data.searchQueries ?? data.queries ?? []
      const dblpQueries = data.dblpQueries ?? undefined
      let queryList = Array.isArray(queries) ? queries : []
      const sources = data.searchStrategy?.suggestedSources ?? data.sources ?? ['semantic_scholar', 'arxiv', 'openalex', 'dblp']

      // Mechanical dedup: filter out queries already used in previous rounds
      queryList = queryList.filter(q => {
        const normalized = q.toLowerCase().trim()
        if (allQueriesUsedAcrossRounds.has(normalized)) {
          console.log(`  [Searcher] Skipping duplicate query: "${q.slice(0, 50)}..."`)
          return false
        }
        return true
      })

      if (queryList.length === 0) {
        console.log('  [Searcher] All refinement queries were duplicates, skipping search round')
        return { papers: [], totalFound: 0, queriesUsed: [], metadata: {
          sourcesTried: [], sourcesSucceeded: [], sourcesFailed: [],
          totalDurationMs: 0, allSourcesSucceeded: true, hasResults: false,
          localPapersFound: 0, externalPapersFound: 0, apiCallCount: 0, apiFailureCount: 0
        }}
      }

      // Build a meaningful sub-topic name from coverage gaps or first query
      const gaps = data.coverage?.missingTopics ?? data.coverage?.gaps ?? []
      const subTopicName = gaps.length > 0
        ? `Refinement: ${gaps.slice(0, 2).join(', ').slice(0, 60)}`
        : queryList.length > 0
          ? `Refinement: ${queryList[0].slice(0, 60)}${queryList[0].length > 60 ? '...' : ''}`
          : 'Refinement search'

      const batch: QueryBatch = {
        subTopic: subTopicName,
        queries: queryList,
        dblpQueries: Array.isArray(dblpQueries) ? dblpQueries : undefined,
        sources,
        priority: 1
      }

      const result = await searcherAgent.run({ queryBatches: [batch] })
      // Track used queries
      for (const q of result.output.queriesUsed) {
        allQueriesUsedAcrossRounds.add(q.toLowerCase().trim())
      }
      return result.output
    }
  }

  const team = defineTeam({
    id: 'literature-research',
    name: 'Literature Research Team v2',
    agents: {
      planner: agentHandle('planner', planner, { runner: createLLMRunner(planner) }),
      searcher: agentHandle('searcher', searcherAgent, { runner: createSearcherRunner() }),
      reviewer: agentHandle('reviewer', reviewer, { runner: createLLMRunner(reviewer) }),
      summarizer: agentHandle('summarizer', summarizer, { runner: createLLMRunner(summarizer) })
    },
    state: stateConfig.memory('literature'),
    flow: seq(
      simpleStep('planner').from('initial').to('plan'),
      simpleStep('searcher').from('plan').to('search'),
      loop(
        seq(
          simpleStep('reviewer').from((s: Record<string, unknown>) => {
            const search = s.search as Record<string, unknown> | undefined
            return { ...search, userRequest: (s.userRequest as string) ?? '' }
          }).to('review'),
          simpleBranch({
            if: (s: unknown) => {
              const state = s as { review?: { approved?: boolean; additionalQueries?: string[] } }
              return state?.review?.approved === false &&
                     (state?.review?.additionalQueries?.length ?? 0) > 0
            },
            then: simpleStep('searcher').from('review').to('search'),
            else: { kind: 'noop' }
          })
        ),
        { type: 'field-eq', path: 'review.approved', value: true },
        { maxIters: maxReviewIterations }
      ),
      simpleStep('summarizer').from((s: Record<string, unknown>) => {
        const review = s.review as Record<string, unknown> | undefined
        return { ...review, userRequest: (s.userRequest as string) ?? '' }
      }).to('summary')
    ),
    defaults: {
      concurrency: 1,
      timeouts: { agentSec: 120, flowSec: 600 }
    }
  })

  const runtime = createAutoTeamRuntime({ team, context: agentCtx })

  return {
    runtime,

    async research(request: string): Promise<{
      success: boolean
      summary?: unknown
      result?: LiteratureSearchResult
      error?: string
      steps: number
      durationMs: number
      savedPapers?: number
      localPapersUsed?: number
      externalPapersUsed?: number
    }> {
      const sessionStartTime = Date.now()

      // Build planner context with filtered conversation and local library
      const plannerContext: PlannerContext = {
        request,
        conversationHistory: coordinatorMessages
          ? filterConversationForPlanner(coordinatorMessages)
          : [],
        localLibrary: projectPath
          ? scanLocalLibrary(projectPath)
          : { totalPapers: 0, topicClusters: [] }
      }

      // Pre-seed state
      const state = runtime.getState()
      state.put('userRequest', request, undefined, 'system')
      state.put('plannerContext', plannerContext, undefined, 'system')

      // Override initial input to include plannerContext
      const result = await runtime.run({ userRequest: request, plannerContext })

      if (result.success && result.finalState) {
        const stateData = result.finalState['literature'] as Record<string, unknown> | undefined
        const summary = stateData?.summary
        const review = stateData?.review as {
          relevantPapers?: Array<{
            id: string
            title: string
            authors: string[]
            abstract: string
            year: number
            url?: string
            source: string
            relevanceScore: number
            relevanceJustification?: string
            doi?: string | null
            venue?: string | null
            citationCount?: number | null
          }>
          coverage?: { score?: number; coveredTopics?: string[]; missingTopics?: string[]; gaps?: string[] }
        } | undefined
        const plan = stateData?.plan as SearchPlan | undefined
        const searchMeta = (stateData?.search as { metadata?: SearchMetadata })?.metadata

        // Auto-save high-relevance papers (score >= 8, up from 7)
        let savedPapers = 0
        let localPapersUsed = 0
        let externalPapersUsed = 0

        const relevantPapers = review?.relevantPapers || []

        for (const paper of relevantPapers) {
          if (paper.source === 'local') {
            localPapersUsed++
          } else {
            externalPapersUsed++
          }
        }

        if (projectPath && relevantPapers.length > 0) {
          const searchKeywords = request
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2)
            .slice(0, 10)

          const cliContext: CLIContext = {
            sessionId,
            projectPath,
            debug: false
          }

          for (const paper of relevantPapers) {
            if (paper.source === 'local') continue
            if (paper.relevanceScore < 8) continue // v2: threshold raised from 7 to 8

            const existing = findExistingPaper(
              { doi: paper.doi, title: paper.title },
              projectPath
            )
            if (existing) {
              // Update existing paper with any enriched metadata that's missing
              const updateResult = updatePaperMetadata(
                existing,
                {
                  authors: paper.authors,
                  year: paper.year,
                  abstract: paper.abstract,
                  venue: paper.venue || undefined,
                  url: paper.url,
                  citationCount: paper.citationCount ?? undefined,
                  doi: paper.doi || undefined,
                  bibtex: undefined // will be fetched below only for new papers
                },
                cliContext
              )
              if (updateResult.filePath) {
                console.log(`  [Auto-save] Updated metadata for "${paper.title.slice(0, 50)}..."`)
              }
              continue
            }

            let bibtex: string | undefined
            try {
              const paperMeta: PaperMetadata = {
                id: paper.id,
                title: paper.title,
                authors: paper.authors,
                year: paper.year,
                venue: paper.venue,
                url: paper.url,
                doi: paper.doi,
                source: paper.source
              }
              bibtex = await getBibtex(paperMeta)
            } catch (err) {
              console.log(`  [Auto-save] BibTeX generation failed for "${paper.title.slice(0, 40)}...": ${err instanceof Error ? err.message : String(err)}`)
            }

            const saveResult = savePaper(
              paper.title,
              {
                authors: paper.authors,
                year: paper.year,
                abstract: paper.abstract,
                venue: paper.venue || undefined,
                url: paper.url,
                tags: [],
                searchKeywords,
                externalSource: paper.source,
                relevanceScore: paper.relevanceScore,
                citationCount: paper.citationCount ?? undefined,
                doi: paper.doi || undefined,
                bibtex
              },
              cliContext
            )

            if (saveResult.success) {
              savedPapers++
              console.log(`  [Auto-save] Saved "${paper.title.slice(0, 50)}..." (score: ${paper.relevanceScore})`)
            }
          }

          if (savedPapers > 0) {
            console.log(`  [Auto-save] Saved ${savedPapers} papers to local library`)
          }
        }

        // Build coverage tracker
        const coverageData = review?.coverage
        const coverageSubTopics = (plan?.subTopics ?? []).map(st => {
          const papersInTopic = relevantPapers.filter(p =>
            p.title.toLowerCase().includes(st.name.toLowerCase()) ||
            (p.abstract && p.abstract.toLowerCase().includes(st.name.toLowerCase()))
          )
          return {
            name: st.name,
            paperCount: papersInTopic.length,
            covered: papersInTopic.length >= (plan?.minimumCoveragePerSubTopic ?? 3),
            gaps: (coverageData?.gaps ?? []).filter(g =>
              g.toLowerCase().includes(st.name.toLowerCase())
            )
          }
        })

        const coverageScore = coverageData?.score ?? (
          coverageSubTopics.length > 0
            ? coverageSubTopics.filter(st => st.covered).length / coverageSubTopics.length
            : 0
        )

        // Save full review to disk
        let fullReviewPath = ''
        let paperListPath = ''
        if (projectPath) {
          const reviewId = `review-${Date.now()}`
          const paths = saveReviewToDisk(projectPath, reviewId, summary, relevantPapers, {
            score: coverageScore,
            subTopics: coverageSubTopics
          })
          fullReviewPath = paths.reviewPath
          paperListPath = paths.paperListPath
        }

        // Build compressed result
        const searchResult: LiteratureSearchResult = {
          success: true,
          data: {
            briefSummary: typeof (summary as any)?.overview === 'string'
              ? (summary as any).overview.slice(0, 500)
              : `Found ${relevantPapers.length} relevant papers across ${coverageSubTopics.length} sub-topics.`,
            coverage: {
              score: coverageScore,
              subTopics: coverageSubTopics,
              queriesExecuted: (stateData?.search as { queriesUsed?: string[] })?.queriesUsed ?? []
            },
            totalPapersFound: relevantPapers.length,
            papersAutoSaved: savedPapers,
            fullReviewPath,
            paperListPath,
            durationMs: Date.now() - sessionStartTime,
            llmCallCount: result.steps, // approximate: each step is roughly one LLM call
            apiCallCount: searchMeta?.apiCallCount ?? 0,
            apiFailureCount: searchMeta?.apiFailureCount ?? 0
          }
        }

        return {
          success: true,
          summary,
          result: searchResult,
          steps: result.steps,
          durationMs: result.durationMs,
          savedPapers,
          localPapersUsed,
          externalPapersUsed
        }
      }

      return { success: false, error: result.error, steps: result.steps, durationMs: result.durationMs }
    }
  }
}
