/**
 * Literature Research Team
 *
 * Self-contained reimplementation using the AgentFoundry Team module.
 * Flow: planner → [local lookup] → searcher → loop(reviewer → searcher) → summarizer
 *
 * Local Paper Caching:
 * - Pre-search: Checks local papers first before querying external APIs
 * - Post-review: Auto-saves high-relevance papers (score >= 7) to local library
 * - Attribution: Tracks papers from local vs external sources in summary
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

import { searchLocalPapers, findExistingPaper } from './local-paper-lookup.js'
import { getBibtex, type PaperMetadata } from './bibtex-utils.js'
import { savePaper } from '../commands/save-paper.js'
import type { CLIContext } from '../types.js'

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

DBLP-specific query syntax (use in dblpQueries only):
- author:LastName — filter by author (e.g. "author:Bengio deep learning")
- venue:CONF — filter by venue (e.g. "venue:NIPS attention mechanism")
- Combine freely: "author:Vaswani venue:NIPS transformer"
- These prefixes do NOT work on other sources, so keep searchQueries free of them.

When the user mentions specific researchers, conferences, or journals, generate 1-2 dblpQueries that leverage author:/venue: syntax alongside regular searchQueries for other sources.

Output JSON:
{
  "originalRequest": "the user's original question",
  "searchQueries": ["query1", "query2", "query3"],
  "dblpQueries": ["author:Name topic", "venue:CONF topic"] or null,
  "searchStrategy": {
    "focusAreas": ["area1", "area2"],
    "suggestedSources": ["semantic_scholar", "arxiv", "openalex", "dblp"],
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
You will receive both the original user research request and the search results.
Assess relevance against the user's actual intent (0-10 scale), analyze topic coverage, and decide if results are sufficient.
Approve if at least 3 relevant papers (score >= 7) AND coverage >= 0.7.
If not approved, suggest additionalQueries that better target the user's original request — refine terminology, try synonyms, or narrow/broaden scope based on gaps.

Papers may include source information indicating where they came from:
- "local": Previously saved papers from the project's literature library (may already have high relevance)
- Other sources: Newly discovered external papers

IMPORTANT: You MUST preserve ALL paper metadata in the relevantPapers output. Every paper MUST include ALL of these fields — copy them exactly from the input, using null for missing values:
- id, title, authors (full array), abstract (complete text — do NOT truncate), year, url
- source (e.g. "semantic_scholar", "arxiv", "openalex", "dblp", "local")
- relevanceScore (your 0-10 rating)
- doi (string or null), venue (string or null), citationCount (number or null)

Do NOT shorten abstracts. Do NOT omit authors. Do NOT drop any field.

Output JSON:
{
  "approved": boolean,
  "relevantPapers": [
    { "id": "...", "title": "...", "authors": ["author1", "author2", ...], "abstract": "full abstract text...", "year": number, "url": "...", "source": "...", "relevanceScore": number, "doi": "..." or null, "venue": "..." or null, "citationCount": number or null }
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
    const data = input as { papers?: Array<{ id: string; title: string; year: number; abstract: string; source?: string; doi?: string | null; venue?: string | null; citationCount?: number | null }>; queriesUsed?: string[]; userRequest?: string }
    const papers = data?.papers ?? []
    const queries = data?.queriesUsed ?? []
    const userRequest = data?.userRequest ?? ''

    // Count local vs external papers
    const localCount = papers.filter(p => p.source === 'local').length
    const sourceInfo = localCount > 0 ? ` (${localCount} from local library)` : ''

    const paperSummaries = papers
      .slice(0, 15)
      .map((p, i) => {
        const sourceTag = p.source ? ` [${p.source}]` : ''
        const doiTag = p.doi ? ` doi:${p.doi}` : ''
        const venueTag = p.venue ? ` venue:${p.venue}` : ''
        const citeTag = p.citationCount != null ? ` citations:${p.citationCount}` : ''
        const authorsList = Array.isArray((p as any).authors) ? ` authors:${(p as any).authors.join(', ')}` : ''
        return `Paper ${i + 1} (id: ${p.id})${sourceTag}${doiTag}${venueTag}${citeTag}${authorsList}: "${p.title}" (${p.year})\nAbstract: ${p.abstract ?? '(none)'}`
      })
      .join('\n')

    return `Original user research request:\n"${userRequest}"\n\nReview these ${papers.length} papers${sourceInfo} against the user's request:\n\n${paperSummaries}\n\nQueries used: ${queries.join(', ')}`
  }
})

const summarizer = defineSimpleAgent({
  id: 'summarizer',
  description: 'Research Synthesizer who creates comprehensive summaries',

  system: `You are a Research Synthesis Specialist who creates comprehensive literature review summaries.
You will receive the original user research request along with the reviewed papers.
Create an insightful, well-organized summary that directly addresses the user's research question.
Focus on overview, top papers, themes, key findings, and research gaps relevant to the user's intent.
Be objective and scholarly in tone.

Papers may come from different sources:
- "local": Previously saved papers from the project's literature library
- Other sources (semantic_scholar, arxiv, openalex, dblp): Newly discovered external papers

Include source attribution in the overview mentioning how many papers came from the local library vs external sources.

Output JSON:
{
  "title": "string",
  "overview": "string",
  "sourceAttribution": {
    "localPapers": number,
    "externalPapers": number,
    "totalPapers": number
  },
  "papers": [
    { "title": "...", "authors": "...", "year": number, "summary": "...", "url": "...", "source": "..." }
  ],
  "themes": [
    { "name": "...", "papers": ["paper1", "paper2"], "insight": "..." }
  ],
  "keyFindings": ["finding1", "finding2"],
  "researchGaps": ["gap1", "gap2"]
}`,

  prompt: (input) => {
    const data = input as {
      relevantPapers?: Array<{ title: string; authors: string[]; year: number; abstract: string; source?: string }>
      coverage?: { coveredTopics?: string[] }
      userRequest?: string
    }
    const papers = data?.relevantPapers ?? []
    const topics = data?.coverage?.coveredTopics ?? []
    const userRequest = data?.userRequest ?? ''

    // Count papers by source
    const localCount = papers.filter(p => p.source === 'local').length
    const externalCount = papers.length - localCount

    const paperDetails = papers
      .slice(0, 12)
      .map((p, i) => `Paper ${i + 1}: "${p.title}" by ${(p.authors ?? []).slice(0, 3).join(', ')} (${p.year}) [source: ${p.source ?? 'unknown'}]\nAbstract: ${p.abstract?.slice(0, 350) ?? ''}`)
      .join('\n\n')

    const sourceInfo = localCount > 0
      ? `\n\nSource breakdown: ${localCount} from local library, ${externalCount} from external sources.`
      : ''

    return `Original user research request:\n"${userRequest}"\n\nCreate a literature review summary from these papers that addresses the user's request:\n\n${paperDetails}\n\nCovered topics: ${topics.join(', ')}${sourceInfo}`
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
  // Local paper caching stats
  localPapersFound: number
  externalPapersFound: number
}

interface SearchResults {
  papers: Paper[]
  totalFound: number
  queriesUsed: string[]
  metadata: SearchMetadata
}

function createSearcherAgent(projectPath?: string) {
  return {
    id: 'searcher',
    kind: 'tool-agent' as const,

    async run(input: { queries: string[]; dblpQueries?: string[]; sources: string[] }): Promise<{ output: SearchResults }> {
      const { queries, dblpQueries, sources = ['semantic_scholar', 'arxiv', 'openalex', 'dblp'] } = input
      const startTime = Date.now()

      if (queries.length === 0 && (!dblpQueries || dblpQueries.length === 0)) {
        const metadata: SearchMetadata = {
          sourcesTried: [], sourcesSucceeded: [], sourcesFailed: [],
          totalDurationMs: 0, allSourcesSucceeded: true, hasResults: false,
          localPapersFound: 0, externalPapersFound: 0
        }
        return { output: { papers: [], totalFound: 0, queriesUsed: [], metadata } }
      }

      const allPapers: Paper[] = []
      const sourcesTried: string[] = []
      const sourcesSucceeded: string[] = []
      const sourcesFailed: string[] = []
      let localPapersFound = 0

      // Step 1: Search local papers first (if projectPath is provided)
      if (projectPath) {
        try {
          const localMatches = searchLocalPapers(queries, projectPath)
          localPapersFound = localMatches.length

          if (localMatches.length > 0) {
            console.log(`  [Searcher] Found ${localMatches.length} papers from local library`)

            // Convert local papers to Paper format
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

      // Step 2: Search external APIs
      for (const source of sources) {
        if (!sourcesTried.includes(source)) sourcesTried.push(source)
        // Use DBLP-specific queries for DBLP if available, otherwise generic queries
        const sourceQueries = (source === 'dblp' && dblpQueries && dblpQueries.length > 0)
          ? dblpQueries
          : queries
        for (const query of sourceQueries) {
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

      // Step 3: Deduplicate (keeps local papers, skips external duplicates)
      const uniquePapers = deduplicatePapersPreferLocal(allPapers)
      const externalPapersFound = uniquePapers.filter(p => p.source !== 'local').length

      const totalDurationMs = Date.now() - startTime
      const metadata: SearchMetadata = {
        sourcesTried, sourcesSucceeded, sourcesFailed,
        totalDurationMs,
        allSourcesSucceeded: sourcesFailed.length === 0,
        hasResults: uniquePapers.length > 0,
        localPapersFound,
        externalPapersFound
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
    // Authors can be a single object or an array
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

/**
 * Deduplicate papers, preferring local copies over external duplicates.
 * This ensures we keep cached metadata (relevance scores, etc.) from local papers.
 */
function deduplicatePapersPreferLocal(papers: Paper[]): Paper[] {
  const seen = new Map<string, Paper>()

  for (const paper of papers) {
    const key = paper.doi || paper.title.toLowerCase().replace(/\s+/g, ' ').trim()
    const existing = seen.get(key)

    if (!existing) {
      // First time seeing this paper
      seen.set(key, paper)
    } else if (paper.source === 'local' && existing.source !== 'local') {
      // Prefer local over external (keep local copy)
      seen.set(key, paper)
    } else if (paper.source !== 'local' && existing.source === 'local') {
      // Keep existing local copy, skip external duplicate
      // (do nothing)
    } else {
      // Both same type: prefer one with more citations
      if ((paper.citationCount || 0) > (existing.citationCount || 0)) {
        seen.set(key, paper)
      }
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
  projectPath?: string
  sessionId?: string
}) {
  const { apiKey, model = 'gpt-5.2', maxReviewIterations = 2, projectPath, sessionId = 'default' } = config
  if (!apiKey) throw new Error('API key is required')

  const languageModel = getLanguageModelByModelId(model, { apiKey })
  const searcherAgent = createSearcherAgent(projectPath)

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
        dblpQueries?: string[] | null
        searchStrategy?: { suggestedSources?: string[] }
        additionalQueries?: string[] | null
        queries?: string[]
        sources?: string[]
      }
      const queries = data.additionalQueries ?? data.searchQueries ?? data.queries ?? []
      const dblpQueries = data.dblpQueries ?? undefined
      const searcherInput = {
        queries: Array.isArray(queries) ? queries : [],
        dblpQueries: Array.isArray(dblpQueries) ? dblpQueries : undefined,
        sources: data.searchStrategy?.suggestedSources ?? data.sources ?? ['semantic_scholar', 'arxiv', 'openalex', 'dblp']
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
          // Inject userRequest from initial input so reviewer knows the original intent
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
      // Inject userRequest so summarizer can address the original question
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
      error?: string
      steps: number
      durationMs: number
      savedPapers?: number
      localPapersUsed?: number
      externalPapersUsed?: number
    }> {
      // Pre-seed userRequest into state so all agents can access it via from() transforms
      const state = runtime.getState()
      state.put('userRequest', request, undefined, 'system')

      const result = await runtime.run({ userRequest: request })

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
            doi?: string | null
            venue?: string | null
            citationCount?: number | null
          }>
        } | undefined

        // Auto-save high-relevance papers (score >= 7) to local library
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

        // Only save if projectPath is provided
        if (projectPath && relevantPapers.length > 0) {
          // Extract search keywords from the request (simple tokenization)
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
            // Only save high-relevance external papers (not already local)
            if (paper.source === 'local') continue
            if (paper.relevanceScore < 7) continue

            // Check if paper already exists locally
            const existing = findExistingPaper(
              { doi: paper.doi, title: paper.title },
              projectPath
            )
            if (existing) {
              console.log(`  [Auto-save] Skipping "${paper.title.slice(0, 50)}..." (already exists)`)
              continue
            }

            // Generate BibTeX for the paper
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

            // Save the paper
            const saveResult = savePaper(
              paper.title,
              {
                authors: paper.authors,
                year: paper.year,
                abstract: paper.abstract,
                venue: paper.venue || undefined,
                url: paper.url,
                tags: [],
                // New search metadata fields
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

        return {
          success: true,
          summary,
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
