/**
 * Literature Search Tool
 *
 * Searches academic papers using a multi-agent pipeline:
 * planner -> searcher -> reviewer -> summarizer.
 *
 * Uses Semantic Scholar, arXiv, OpenAlex, and DBLP APIs.
 * Requires ctx.callLlm for the planning, reviewing, and summarizing steps.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError, toolSuccess, type ToolResult } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'
import { loadPrompt } from '../agents/prompts/index.js'

import fs from 'node:fs'
import path from 'node:path'
import { upsertPaperArtifact } from '../commands/paper-artifact.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchPlan {
  topic: string
  subTopics: Array<{ name: string; description: string; priority: string; expectedPaperCount: number }>
  queryBatches: Array<{
    subTopic: string
    queries: string[]
    dblpQueries?: string[] | null
    sources: string[]
    priority: number
  }>
  targetPaperCount: number
  minimumCoveragePerSubTopic: number
}

interface PaperResult {
  id: string
  title: string
  authors: string[]
  abstract: string
  year: number | null
  url: string
  source: string
  doi?: string | null
  venue?: string | null
  citationCount?: number | null
}

interface ReviewedPaper extends PaperResult {
  relevanceScore: number
  relevanceJustification: string
}

interface ReviewResult {
  approved: boolean
  relevantPapers: ReviewedPaper[]
  confidence: number
  coverage: {
    score: number
    coveredTopics: string[]
    missingTopics: string[]
    gaps: string[]
  }
  issues: string[]
  additionalQueries: string[] | null
}

interface LiteratureSummary {
  title: string
  overview: string
  sourceAttribution: { localPapers: number; externalPapers: number; totalPapers: number }
  coverage: { score: number; subTopics: Array<{ name: string; paperCount: number; covered: boolean; gaps: string[] }> }
  papers: Array<{ title: string; authors: string; year: number | null; summary: string; url: string; source: string }>
  themes: Array<{ name: string; papers: string[]; insight: string }>
  keyFindings: string[]
  researchGaps: string[]
}

// ---------------------------------------------------------------------------
// API search helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Result from a single source search — always returns papers + optional error context */
interface SourceSearchResult {
  papers: PaperResult[]
  error?: string
  statusCode?: number
}

async function searchSemanticScholar(query: string, limit = 10): Promise<SourceSearchResult> {
  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search')
  url.searchParams.set('query', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('fields', 'paperId,title,authors,abstract,year,url,externalIds,venue,citationCount')

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'research-pilot/0.1' }
    })
    if (!res.ok) {
      return { papers: [], error: `Semantic Scholar API returned HTTP ${res.status}`, statusCode: res.status }
    }
    const json = await res.json() as any
    const papers = (json.data ?? []).map((p: any) => ({
      id: p.paperId ?? '',
      title: p.title ?? '',
      authors: (p.authors ?? []).map((a: any) => a.name ?? ''),
      abstract: p.abstract ?? '',
      year: p.year ?? null,
      url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
      source: 'semantic_scholar',
      doi: p.externalIds?.DOI ?? null,
      venue: p.venue ?? null,
      citationCount: p.citationCount ?? null
    }))
    return { papers }
  } catch (err) {
    return { papers: [], error: `Semantic Scholar request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function searchArxiv(query: string, limit = 10): Promise<SourceSearchResult> {
  const url = new URL('http://export.arxiv.org/api/query')
  url.searchParams.set('search_query', `all:${query}`)
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', String(limit))
  url.searchParams.set('sortBy', 'relevance')

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/atom+xml' }
    })
    if (!res.ok) {
      return { papers: [], error: `arXiv API returned HTTP ${res.status}`, statusCode: res.status }
    }
    const xml = await res.text()
    const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) ?? []
    const papers = entries.slice(0, limit).map(entry => {
      const tag = (name: string) => {
        const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
        return m ? m[1].trim() : ''
      }
      const authors = (entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi) ?? [])
        .map(a => { const m = a.match(/<name>([\s\S]*?)<\/name>/i); return m ? m[1].trim() : '' })
        .filter(Boolean)
      return {
        id: tag('id'),
        title: tag('title').replace(/\s+/g, ' '),
        authors,
        abstract: tag('summary').replace(/\s+/g, ' '),
        year: (() => { const d = tag('published'); return d ? parseInt(d.slice(0, 4), 10) : null })(),
        url: tag('id'),
        source: 'arxiv' as const,
        doi: null,
        venue: 'arXiv',
        citationCount: null
      }
    })
    return { papers }
  } catch (err) {
    return { papers: [], error: `arXiv request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function searchOpenAlex(query: string, limit = 10): Promise<SourceSearchResult> {
  const url = new URL('https://api.openalex.org/works')
  url.searchParams.set('search', query)
  url.searchParams.set('per_page', String(limit))
  url.searchParams.set('mailto', 'research-pilot@example.com')

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      return { papers: [], error: `OpenAlex API returned HTTP ${res.status}`, statusCode: res.status }
    }
    const json = await res.json() as any
    const papers = (json.results ?? []).map((w: any) => ({
      id: w.id ?? '',
      title: w.title ?? '',
      authors: (w.authorships ?? []).map((a: any) => a.author?.display_name ?? '').filter(Boolean),
      abstract: w.abstract_inverted_index
        ? Object.entries(w.abstract_inverted_index as Record<string, number[]>)
            .flatMap(([word, positions]) => (positions as number[]).map(p => ({ word, p })))
            .sort((a, b) => a.p - b.p)
            .map(x => x.word)
            .join(' ')
        : '',
      year: w.publication_year ?? null,
      url: w.primary_location?.landing_page_url ?? w.id ?? '',
      source: 'openalex',
      doi: w.doi ?? null,
      venue: w.primary_location?.source?.display_name ?? null,
      citationCount: w.cited_by_count ?? null
    }))
    return { papers }
  } catch (err) {
    return { papers: [], error: `OpenAlex request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function searchDblp(query: string, limit = 10): Promise<SourceSearchResult> {
  const url = new URL('https://dblp.org/search/publ/api')
  url.searchParams.set('q', query)
  url.searchParams.set('h', String(limit))
  url.searchParams.set('format', 'json')

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      return { papers: [], error: `DBLP API returned HTTP ${res.status}`, statusCode: res.status }
    }
    const json = await res.json() as any
    const hits = json.result?.hits?.hit ?? []
    const papers = hits.map((h: any) => {
      const info = h.info ?? {}
      const authorsRaw = info.authors?.author
      const authors = Array.isArray(authorsRaw)
        ? authorsRaw.map((a: any) => (typeof a === 'string' ? a : a.text ?? '')).filter(Boolean)
        : (authorsRaw?.text ? [authorsRaw.text] : [])
      return {
        id: info.key ?? '',
        title: info.title ?? '',
        authors,
        abstract: '',
        year: info.year ? parseInt(info.year, 10) : null,
        url: info.ee ?? info.url ?? '',
        source: 'dblp',
        doi: info.doi ?? null,
        venue: info.venue ?? null,
        citationCount: null
      }
    })
    return { papers }
  } catch (err) {
    return { papers: [], error: `DBLP request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const SOURCE_DISPATCH: Record<string, (query: string, limit: number) => Promise<SourceSearchResult>> = {
  semantic_scholar: searchSemanticScholar,
  arxiv: searchArxiv,
  openalex: searchOpenAlex,
  dblp: searchDblp
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicatePapers(papers: PaperResult[]): PaperResult[] {
  const seen = new Map<string, PaperResult>()
  for (const p of papers) {
    const key = p.doi ?? p.title.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!seen.has(key)) {
      seen.set(key, p)
    }
  }
  return Array.from(seen.values())
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

function safeJsonParse<T>(text: string): T | null {
  // Try to extract JSON from markdown code block first
  const blockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/)
  const candidate = blockMatch ? blockMatch[1] : text
  try {
    return JSON.parse(candidate.trim()) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createLiteratureSearchTool(ctx: ResearchToolContext): AgentTool {
  const PLANNER_SYSTEM = loadPrompt('literature-planner-system')
  const REVIEWER_SYSTEM = loadPrompt('literature-reviewer-system')
  const SUMMARIZER_SYSTEM = loadPrompt('literature-summarizer-system')

  return {
    name: 'literature-search',
    label: 'Literature Search',
    description:
      'Search academic papers on a topic using a multi-agent literature research pipeline. ' +
      'Internally plans sub-topics, searches multiple sources (Semantic Scholar, arXiv, OpenAlex, DBLP), ' +
      'reviews/scores papers, and synthesizes a summary -- all in a SINGLE call. ' +
      'Returns a compressed result with coverage state, paper counts, and disk paths to full review.\n' +
      'Usage guidelines: (1) Call at most ONCE per user request for the same topic — re-run only if the user explicitly asks or the topic changes. ' +
      '(2) Always pass context when available (research goals, researcher names, paper titles). ' +
      '(3) After receiving results, read fullReviewPath and synthesize — do not dump raw results. ' +
      '(4) If full-text PDF is required but unavailable (paywall/auth), ask the user to upload instead of fabricating details.',
    parameters: Type.Object({
      query: Type.String({ description: 'The research topic or question to search for' }),
      context: Type.Optional(
        Type.String({ description: 'Additional context (researcher names, specific fields, paper titles, etc.)' })
      )
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      if (!query) {
        return toAgentResult('literature-search', toolError('MISSING_PARAMETER', 'Missing query.', {
          suggestions: ['Provide a non-empty research topic or question as the query parameter.']
        }))
      }
      const extraContext = typeof params.context === 'string' ? params.context.trim() : ''

      if (!ctx.callLlm) {
        return toAgentResult('literature-search', toolError('LLM_UNAVAILABLE', 'LLM not available for literature search pipeline.', {
          suggestions: ['Ensure the agent runtime has an LLM provider configured (callLlm in ResearchToolContext).']
        }))
      }

      // ── Step 1: Plan ──────────────────────────────────────────────
      const planUserPrompt = extraContext
        ? `Research request: ${query}\n\nAdditional context: ${extraContext}`
        : `Research request: ${query}`

      let plan: SearchPlan
      try {
        const planText = await ctx.callLlm(PLANNER_SYSTEM, planUserPrompt)
        const parsed = safeJsonParse<SearchPlan>(planText)
        if (!parsed || !Array.isArray(parsed.queryBatches)) {
          return toAgentResult('literature-search', toolError('PARSE_FAILED', 'Failed to parse search plan from LLM.', {
            retryable: true,
            suggestions: ['Retry the search — LLM may produce valid JSON on a subsequent attempt.', 'Try simplifying the query.'],
          }))
        }
        plan = parsed
      } catch (err: any) {
        return toAgentResult('literature-search', toolError('EXECUTION_FAILED', `Planning step failed: ${err.message}`, {
          retryable: true,
          suggestions: ['Retry the search.', 'Check if the LLM provider is available.'],
        }))
      }

      // ── Step 2: Search ────────────────────────────────────────────
      const allPapers: PaperResult[] = []
      const queriesUsed: string[] = []
      const sourceErrors: Record<string, string[]> = {}

      const perSourceLimit = ctx.settings?.researchIntensity?.perSourceLimit ?? 20
      const sleepMs = ctx.settings?.researchIntensity?.sleepMs ?? 500

      for (const batch of plan.queryBatches.sort((a, b) => a.priority - b.priority)) {
        for (const q of batch.queries) {
          queriesUsed.push(q)
          for (const src of batch.sources) {
            const searchFn = SOURCE_DISPATCH[src]
            if (!searchFn) continue
            const result = await searchFn(q, perSourceLimit)
            allPapers.push(...result.papers)
            if (result.error) {
              if (!sourceErrors[src]) sourceErrors[src] = []
              sourceErrors[src].push(result.error)
            }
            await sleep(sleepMs)
          }
        }
        // DBLP-specific queries
        if (batch.dblpQueries) {
          for (const dq of batch.dblpQueries) {
            queriesUsed.push(`[dblp] ${dq}`)
            const result = await searchDblp(dq, Math.min(perSourceLimit, 10))
            allPapers.push(...result.papers)
            if (result.error) {
              if (!sourceErrors['dblp']) sourceErrors['dblp'] = []
              sourceErrors['dblp'].push(result.error)
            }
            await sleep(sleepMs)
          }
        }
      }

      const deduplicated = deduplicatePapers(allPapers)
      const failedSourceNames = Object.keys(sourceErrors)
      const hasSourceFailures = failedSourceNames.length > 0

      if (deduplicated.length === 0) {
        // Distinguish "no papers exist" from "all APIs failed"
        const failedDetails = failedSourceNames
          .map(src => `${src}: ${sourceErrors[src][0]}`)

        return toAgentResult('literature-search', toolError(
          hasSourceFailures ? 'API_ERROR' : 'NOT_FOUND',
          hasSourceFailures
            ? `No papers found. ${failedSourceNames.length} source(s) failed: ${failedSourceNames.join(', ')}.`
            : 'No papers found matching the query across all sources.',
          {
            retryable: hasSourceFailures,
            context: {
              queriesUsed,
              failedSources: failedDetails,
              subTopics: plan.subTopics.map(s => s.name),
            },
            suggestions: hasSourceFailures
              ? [
                  'Some academic APIs may be temporarily unavailable. Retry in a few minutes.',
                  'Try different or broader search terms.',
                ]
              : [
                  'Try broader or alternative search terms.',
                  'Check if the topic uses different terminology in academic literature.',
                  'Consider searching for related sub-topics individually.',
                ],
          }
        ))
      }

      // ── Step 3: Review ────────────────────────────────────────────
      const reviewInput = [
        `Research request: ${query}`,
        '',
        `Sub-topics: ${plan.subTopics.map(s => s.name).join(', ')}`,
        '',
        `Papers found (${deduplicated.length}):`,
        ...deduplicated.map((p, i) =>
          `${i + 1}. [${p.source}] "${p.title}" by ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ' et al.' : ''} (${p.year ?? 'n.d.'})\n   Abstract: ${(p.abstract || 'N/A').slice(0, 400)}`
        ),
        '',
        `Queries used: ${queriesUsed.join('; ')}`
      ].join('\n')

      let review: ReviewResult
      const pipelineWarnings: string[] = []

      // Propagate source failure warnings
      if (hasSourceFailures) {
        pipelineWarnings.push(
          `${failedSourceNames.length} source(s) had errors: ${failedSourceNames.join(', ')}. Results may be incomplete.`
        )
      }

      try {
        const reviewText = await ctx.callLlm(REVIEWER_SYSTEM, reviewInput)
        const parsed = safeJsonParse<ReviewResult>(reviewText)
        if (!parsed) {
          // If review parsing fails, include all papers with a default score — but warn the agent
          review = {
            approved: true,
            relevantPapers: deduplicated.slice(0, ctx.settings?.researchIntensity?.reviewCap ?? 25).map(p => ({ ...p, relevanceScore: 5, relevanceJustification: 'Review parsing failed; included by default.' })),
            confidence: 0.5,
            coverage: { score: 0.5, coveredTopics: [], missingTopics: [], gaps: ['Review parsing failed'] },
            issues: ['Review parsing failed'],
            additionalQueries: null
          }
          pipelineWarnings.push(
            'LLM review parsing failed — papers included with default relevance score of 5. '
            + 'Relevance scores may not be accurate. Consider re-reviewing the top papers manually.'
          )
        } else {
          review = parsed
        }
      } catch (err: any) {
        return toAgentResult('literature-search', toolError('EXECUTION_FAILED', `Review step failed: ${err.message}`, {
          retryable: true,
          suggestions: ['The LLM review step failed. Retry the search, or process the raw papers without review.'],
          context: { papersFound: deduplicated.length, queriesUsed },
        }))
      }

      // ── Step 4: Summarize ─────────────────────────────────────────
      const summaryInput = [
        `Research request: ${query}`,
        '',
        `Reviewed papers (${review.relevantPapers.length}):`,
        ...review.relevantPapers.map((p, i) =>
          `${i + 1}. "${p.title}" by ${p.authors.slice(0, 3).join(', ')} (${p.year ?? 'n.d.'}) [score=${p.relevanceScore}]\n   ${p.relevanceJustification}\n   Abstract: ${(p.abstract || 'N/A').slice(0, 300)}`
        ),
        '',
        `Coverage: ${JSON.stringify(review.coverage)}`
      ].join('\n')

      let summary: LiteratureSummary | null = null
      try {
        const summaryText = await ctx.callLlm(SUMMARIZER_SYSTEM, summaryInput)
        summary = safeJsonParse<LiteratureSummary>(summaryText)
      } catch {
        // summary is optional
      }

      // ── Step 5: Auto-save relevant papers as artifacts ──────────
      const AUTO_SAVE_THRESHOLD = ctx.settings?.autoSaveThreshold ?? 7
      let papersAutoSaved = 0
      const runId = Date.now().toString(36)
      const roundLabel = `R-${runId}`

      for (const paper of review.relevantPapers) {
        if (paper.relevanceScore >= AUTO_SAVE_THRESHOLD) {
          try {
            // Find matching sub-topic from the plan
            const matchedSubTopic = plan.subTopics.find(st =>
              paper.relevanceJustification?.toLowerCase().includes(st.name.toLowerCase())
            )?.name

            const result = upsertPaperArtifact(paper.title, {
              authors: paper.authors,
              year: paper.year ?? undefined,
              abstract: paper.abstract,
              venue: paper.venue ?? undefined,
              url: paper.url,
              doi: paper.doi ?? undefined,
              externalSource: paper.source,
              relevanceScore: paper.relevanceScore,
              citationCount: paper.citationCount ?? undefined,
              relevanceJustification: paper.relevanceJustification,
              subTopic: matchedSubTopic,
              addedInRound: roundLabel,
              addedByTask: 'deep_literature_study',
              identityConfidence: paper.doi ? 'high' : 'medium',
              semanticScholarId: paper.source === 'semantic_scholar' ? paper.id : undefined,
              arxivId: paper.source === 'arxiv' ? paper.id : undefined,
            }, {
              sessionId: ctx.sessionId ?? 'unknown',
              projectPath: ctx.projectPath
            })

            if (result.success) papersAutoSaved++
          } catch {
            // Don't fail the whole search if one paper fails to save
          }
        }
      }

      // ── Step 6: Persist full review to disk ─────────────────────
      const reviewDir = path.join(ctx.projectPath, '.research-pilot', 'literature-runs', runId)
      fs.mkdirSync(reviewDir, { recursive: true })

      const fullReviewPath = path.join(reviewDir, 'review.json')
      fs.writeFileSync(fullReviewPath, JSON.stringify({
        plan,
        allPapersCount: deduplicated.length,
        review,
        summary,
        queriesUsed,
        timestamp: new Date().toISOString()
      }, null, 2), 'utf-8')

      const relReviewPath = path.relative(ctx.projectPath, fullReviewPath)

      // ── Return compact result ─────────────────────────────────────
      const payload = {
        totalFound: deduplicated.length,
        reviewedCount: review.relevantPapers.length,
        papersAutoSaved,
        approved: review.approved,
        confidence: review.confidence,
        coverage: review.coverage,
        topPapers: review.relevantPapers
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, 5)
          .map(p => ({
            title: p.title,
            authors: p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : ''),
            year: p.year,
            score: p.relevanceScore,
            url: p.url,
            source: p.source
          })),
        summaryTitle: summary?.title,
        keyFindings: summary?.keyFindings?.slice(0, 5),
        researchGaps: summary?.researchGaps?.slice(0, 3),
        fullReviewPath: relReviewPath,
        runId,
        queriesUsed: queriesUsed.slice(0, 10)
      }

      return toAgentResult('literature-search', toolSuccess(payload, pipelineWarnings.length > 0 ? pipelineWarnings : undefined))
    }
  }
}
