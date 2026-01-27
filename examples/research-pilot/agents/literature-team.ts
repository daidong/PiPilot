/**
 * Literature Research Team
 *
 * Self-contained reimplementation using the AgentFoundry Team module.
 * Flow: planner → searcher → loop(reviewer → searcher) → summarizer
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

// ============================================================================
// Agent Definitions
// ============================================================================

const planner = defineSimpleAgent({
  id: 'planner',
  description: 'Query Planning Specialist for academic literature research',

  system: `You are a Query Planning Specialist for academic literature research.
Analyze research requests and create optimized search strategies.
Generate 2-3 diverse search queries covering different aspects.
Use academic terminology and consider synonyms, acronyms, and related concepts.

Output JSON:
{
  "originalRequest": "the user's original question",
  "searchQueries": ["query1", "query2", "query3"],
  "searchStrategy": {
    "focusAreas": ["area1", "area2"],
    "suggestedSources": ["semantic_scholar", "arxiv", "openalex"],
    "timeRange": { "start": 2020, "end": 2024 } or null
  },
  "expectedTopics": ["topic1", "topic2"]
}`,

  prompt: (input) => {
    const data = input as { userRequest?: string } | string
    const request = typeof data === 'string' ? data : data?.userRequest ?? ''
    return `Analyze this research request and create a search strategy:\n\n"${request}"`
  }
})

const reviewer = defineSimpleAgent({
  id: 'reviewer',
  description: 'Research Quality Reviewer who evaluates search results',

  system: `You are a Research Quality Reviewer who evaluates academic paper search results.
Assess relevance (0-10 scale), analyze topic coverage, and decide if results are sufficient.
Approve if at least 3 relevant papers (score >= 7) AND coverage >= 0.7.
Only suggest additionalQueries if not approved.

Output JSON:
{
  "approved": boolean,
  "relevantPapers": [
    { "id": "...", "title": "...", "authors": [...], "abstract": "...", "year": number, "url": "...", "source": "...", "relevanceScore": number }
  ],
  "confidence": number,
  "coverage": {
    "score": number,
    "coveredTopics": ["topic1", "topic2"],
    "missingTopics": ["topic3"]
  },
  "issues": ["issue1", "issue2"],
  "additionalQueries": ["query1"] or null
}`,

  prompt: (input) => {
    const results = input as { papers?: Array<{ title: string; year: number; abstract: string }>; queriesUsed?: string[] }
    const papers = results?.papers ?? []
    const queries = results?.queriesUsed ?? []

    const paperSummaries = papers
      .slice(0, 15)
      .map((p, i) => `Paper ${i + 1}: "${p.title}" (${p.year}) - ${p.abstract?.slice(0, 200) ?? ''}...`)
      .join('\n')

    return `Review these ${papers.length} papers:\n\n${paperSummaries}\n\nQueries used: ${queries.join(', ')}`
  }
})

const summarizer = defineSimpleAgent({
  id: 'summarizer',
  description: 'Research Synthesizer who creates comprehensive summaries',

  system: `You are a Research Synthesis Specialist who creates comprehensive literature review summaries.
Create an insightful, well-organized summary with overview, top papers, themes, key findings, and research gaps.
Be objective and scholarly in tone.

Output JSON:
{
  "title": "string",
  "overview": "string",
  "papers": [
    { "title": "...", "authors": "...", "year": number, "summary": "...", "url": "..." }
  ],
  "themes": [
    { "name": "...", "papers": ["paper1", "paper2"], "insight": "..." }
  ],
  "keyFindings": ["finding1", "finding2"],
  "researchGaps": ["gap1", "gap2"]
}`,

  prompt: (input) => {
    const review = input as {
      relevantPapers?: Array<{ title: string; authors: string[]; year: number; abstract: string }>
      coverage?: { coveredTopics?: string[] }
    }
    const papers = review?.relevantPapers ?? []
    const topics = review?.coverage?.coveredTopics ?? []

    const paperDetails = papers
      .slice(0, 12)
      .map((p, i) => `Paper ${i + 1}: "${p.title}" by ${(p.authors ?? []).slice(0, 3).join(', ')} (${p.year})\nAbstract: ${p.abstract?.slice(0, 350) ?? ''}`)
      .join('\n\n')

    return `Create a literature review summary from these papers:\n\n${paperDetails}\n\nCovered topics: ${topics.join(', ')}`
  }
})

// ============================================================================
// Searcher Agent (Tool-based, no LLM)
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
}

interface SearchResults {
  papers: Paper[]
  totalFound: number
  queriesUsed: string[]
  metadata: SearchMetadata
}

function createSearcherAgent() {
  return {
    id: 'searcher',
    kind: 'tool-agent' as const,

    async run(input: { queries: string[]; sources: string[] }): Promise<{ output: SearchResults }> {
      const { queries, sources = ['semantic_scholar', 'arxiv', 'openalex'] } = input
      const startTime = Date.now()

      if (queries.length === 0) {
        const metadata: SearchMetadata = {
          sourcesTried: [], sourcesSucceeded: [], sourcesFailed: [],
          totalDurationMs: 0, allSourcesSucceeded: true, hasResults: false
        }
        return { output: { papers: [], totalFound: 0, queriesUsed: [], metadata } }
      }

      const allPapers: Paper[] = []
      const sourcesTried: string[] = []
      const sourcesSucceeded: string[] = []
      const sourcesFailed: string[] = []

      for (const query of queries) {
        for (const source of sources) {
          if (!sourcesTried.includes(source)) sourcesTried.push(source)
          try {
            const papers = await searchSource(source, query, 8)
            allPapers.push(...papers)
            if (!sourcesSucceeded.includes(source)) sourcesSucceeded.push(source)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.log(`  [Searcher] ${source} failed: ${msg}`)
            if (!sourcesFailed.includes(source)) sourcesFailed.push(source)
          }
        }
      }

      const uniquePapers = deduplicatePapers(allPapers)
      const totalDurationMs = Date.now() - startTime
      const metadata: SearchMetadata = {
        sourcesTried, sourcesSucceeded, sourcesFailed,
        totalDurationMs,
        allSourcesSucceeded: sourcesFailed.length === 0,
        hasResults: uniquePapers.length > 0
      }

      return {
        output: { papers: uniquePapers, totalFound: uniquePapers.length, queriesUsed: queries, metadata }
      }
    }
  }
}

// ============================================================================
// Search Utilities
// ============================================================================

async function searchSource(source: string, query: string, limit: number): Promise<Paper[]> {
  const encodedQuery = encodeURIComponent(query)
  const timeoutMs = source === 'arxiv' ? 60000 : 15000
  let url: string

  switch (source) {
    case 'semantic_scholar':
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${limit}&fields=paperId,title,abstract,year,venue,citationCount,url,authors`
      break
    case 'arxiv':
      url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&max_results=${limit}`
      break
    case 'openalex':
      url = `https://api.openalex.org/works?search=${encodedQuery}&per-page=${limit}`
      break
    default:
      return []
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) return []

  if (source === 'arxiv') return parseArxiv(await response.text())
  const data = await response.json()
  return source === 'semantic_scholar' ? parseSemanticScholar(data) : parseOpenAlex(data)
}

function parseSemanticScholar(data: { data?: Array<Record<string, unknown>> }): Paper[] {
  return (data.data || []).map((p): Paper => ({
    id: String(p.paperId || ''),
    title: String(p.title || 'Unknown'),
    authors: ((p.authors as Array<{ name: string }>) || []).slice(0, 20).map(a => a.name),
    abstract: String(p.abstract || ''),
    year: Number(p.year) || 0,
    venue: (p.venue as string) ?? null,
    citationCount: (p.citationCount as number) ?? null,
    url: String(p.url || `https://www.semanticscholar.org/paper/${p.paperId}`),
    source: 'semantic_scholar',
    doi: null, pdfUrl: null, relevanceScore: null
  }))
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
      doi: null, pdfUrl: null, relevanceScore: null
    }
  })
}

function deduplicatePapers(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>()
  for (const paper of papers) {
    const key = paper.doi || paper.title.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!seen.has(key) || (paper.citationCount || 0) > (seen.get(key)!.citationCount || 0)) {
      seen.set(key, paper)
    }
  }
  return Array.from(seen.values())
}

// ============================================================================
// Team Definition & Factory
// ============================================================================

export function createLiteratureTeam(config: {
  apiKey: string
  model?: string
  maxReviewIterations?: number
}) {
  const { apiKey, model = 'gpt-4o', maxReviewIterations = 2 } = config
  if (!apiKey) throw new Error('API key is required')

  const languageModel = getLanguageModelByModelId(model, { apiKey })
  const searcherAgent = createSearcherAgent()

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

  const createSearcherRunner = () => {
    return async (input: unknown) => {
      const data = input as {
        searchQueries?: string[]
        searchStrategy?: { suggestedSources?: string[] }
        additionalQueries?: string[] | null
        queries?: string[]
        sources?: string[]
      }
      const queries = data.additionalQueries ?? data.searchQueries ?? data.queries ?? []
      const searcherInput = {
        queries: Array.isArray(queries) ? queries : [],
        sources: data.searchStrategy?.suggestedSources ?? data.sources ?? ['semantic_scholar', 'arxiv', 'openalex']
      }
      const result = await searcherAgent.run(searcherInput)
      return result.output
    }
  }

  const team = defineTeam({
    id: 'literature-research',
    name: 'Literature Research Team',
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
          simpleStep('reviewer').from('search').to('review'),
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
      simpleStep('summarizer').from('review').to('summary')
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
      error?: string
      steps: number
      durationMs: number
    }> {
      const result = await runtime.run({ userRequest: request })

      if (result.success && result.finalState) {
        const stateData = result.finalState['literature'] as Record<string, unknown> | undefined
        const summary = stateData?.summary
        return { success: true, summary, steps: result.steps, durationMs: result.durationMs }
      }

      return { success: false, error: result.error, steps: result.steps, durationMs: result.durationMs }
    }
  }
}
