/**
 * Literature Research Multi-Agent Team (LLM-Powered)
 *
 * A team of LLM-powered agents for academic literature research.
 * Uses direct LLM calls (via Vercel AI SDK) and real academic API searches.
 *
 * Team Structure:
 * - QueryPlanner (LLM): Analyzes requests and creates search strategies
 * - Searcher (APIs): Executes real Semantic Scholar, arXiv, OpenAlex searches
 * - Reviewer (LLM): Evaluates results and identifies gaps
 * - Summarizer (LLM): Synthesizes findings into comprehensive summary
 *
 * Flow: QueryPlanner → Searcher → loop(Reviewer → Searcher) → Summarizer
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-xxx
 *   npx tsx examples/literature-agent/team-llm.ts
 */

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  invoke,
  input,
  until,
  createTeamRuntime,
  type TeamRunResult
} from '../../src/team/index.js'

import {
  createLLMQueryPlannerAgent,
  createLLMSearcherAgent,
  createLLMReviewerAgent,
  createLLMSummarizerAgent
} from './agents/index.js'

import type { ResearchSummary } from './agents/llm-summarizer.js'

// State paths for blackboard
const STATE_PATHS = {
  PLAN: 'queryPlan',
  SEARCH_RESULTS: 'searchResults',
  REVIEW: 'review',
  SUMMARY: 'summary'
}

export interface LiteratureTeamLLMConfig {
  /** OpenAI API key (required) */
  apiKey: string
  /** Model to use (default: gpt-4o-mini) */
  model?: string
  /** Max review iterations (default: 2) */
  maxReviewIterations?: number
  /** Progress callback */
  onProgress?: (info: { agent: string; status: string; step?: number }) => void
}

/**
 * Create an LLM-Powered Literature Research Team
 *
 * Uses direct LLM calls for analysis and real academic API searches.
 */
export function createLiteratureTeamLLM(config: LiteratureTeamLLMConfig) {
  const {
    apiKey,
    model = 'gpt-4o-mini',
    maxReviewIterations = 2,
    onProgress
  } = config

  if (!apiKey) {
    throw new Error('API key is required for LLM-powered agents')
  }

  // Create LLM-powered agent instances
  const queryPlannerAgent = createLLMQueryPlannerAgent({ apiKey, model })
  const searcherAgent = createLLMSearcherAgent({ apiKey, model })
  const reviewerAgent = createLLMReviewerAgent({ apiKey, model })
  const summarizerAgent = createLLMSummarizerAgent({ apiKey, model })

  // Define the team
  const team = defineTeam({
    id: 'literature-research-team-llm',
    name: 'Literature Research Team (LLM-Powered)',
    description: 'A multi-agent team using LLM for comprehensive academic literature research',

    agents: {
      queryPlanner: agentHandle('queryPlanner', queryPlannerAgent, {
        role: 'Query Strategist (LLM)',
        capabilities: ['query-expansion', 'search-strategy', 'topic-analysis']
      }),
      searcher: agentHandle('searcher', searcherAgent, {
        role: 'Literature Searcher (APIs)',
        capabilities: ['api-search', 'multi-source', 'deduplication']
      }),
      reviewer: agentHandle('reviewer', reviewerAgent, {
        role: 'Quality Reviewer (LLM)',
        capabilities: ['relevance-scoring', 'coverage-analysis', 'gap-detection']
      }),
      summarizer: agentHandle('summarizer', summarizerAgent, {
        role: 'Research Synthesizer (LLM)',
        capabilities: ['summarization', 'theme-extraction', 'insight-generation']
      })
    },

    state: stateConfig.memory('literature-llm'),

    flow: seq(
      // Step 1: QueryPlanner analyzes request and creates search strategy
      invoke('queryPlanner', input.initial(), {
        outputAs: { path: STATE_PATHS.PLAN },
        name: 'Create search strategy'
      }),

      // Step 2: Searcher executes real academic database searches
      invoke('searcher', input.state(STATE_PATHS.PLAN), {
        outputAs: { path: STATE_PATHS.SEARCH_RESULTS },
        name: 'Execute search'
      }),

      // Step 3: Review-refine loop
      loop(
        seq(
          // Reviewer evaluates results with LLM
          invoke('reviewer', input.state(STATE_PATHS.SEARCH_RESULTS), {
            outputAs: { path: STATE_PATHS.REVIEW },
            name: 'Review results'
          }),
          // Searcher refines based on feedback (if additional queries suggested)
          invoke('searcher', input.state(STATE_PATHS.REVIEW), {
            outputAs: { path: STATE_PATHS.SEARCH_RESULTS },
            name: 'Refine search'
          })
        ),
        until.noCriticalIssues(STATE_PATHS.REVIEW),
        { maxIters: maxReviewIterations }
      ),

      // Step 4: Summarizer creates comprehensive research synthesis
      invoke('summarizer', input.state(STATE_PATHS.REVIEW), {
        outputAs: { path: STATE_PATHS.SUMMARY },
        name: 'Synthesize findings'
      })
    ),

    defaults: {
      concurrency: 1,
      timeouts: {
        agentSec: 120,
        flowSec: 600
      }
    }
  })

  // Create agent invoker
  const agents: Record<string, { run: (input: string) => Promise<{ success: boolean; output: string }> }> = {
    queryPlanner: queryPlannerAgent,
    searcher: searcherAgent,
    reviewer: reviewerAgent,
    summarizer: summarizerAgent
  }

  const agentInvoker = async (agentId: string, agentInput: unknown): Promise<string> => {
    const agent = agents[agentId]
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)

    onProgress?.({ agent: agentId, status: 'started' })

    const inputStr = typeof agentInput === 'string'
      ? agentInput
      : JSON.stringify(agentInput)

    const result = await agent.run(inputStr)

    onProgress?.({ agent: agentId, status: result.success ? 'completed' : 'failed' })

    if (!result.success) {
      throw new Error(`Agent ${agentId} failed: ${result.output}`)
    }

    return result.output
  }

  // Create runtime
  const runtime = createTeamRuntime({
    team,
    agentInvoker
  })

  return {
    /** The underlying team runtime */
    runtime,

    /** Individual agent instances */
    agents: {
      queryPlanner: queryPlannerAgent,
      searcher: searcherAgent,
      reviewer: reviewerAgent,
      summarizer: summarizerAgent
    },

    /**
     * Run a literature research request
     *
     * @param request - Natural language research request
     * @returns Research summary with papers and insights
     */
    async research(request: string): Promise<{
      success: boolean
      summary?: ResearchSummary
      error?: string
      steps: number
      durationMs: number
    }> {
      const result = await runtime.run({ userRequest: request })

      if (result.success && result.finalState) {
        const stateData = result.finalState['literature-llm'] as Record<string, unknown> | undefined
        const summary = stateData?.[STATE_PATHS.SUMMARY]

        if (summary) {
          let parsedSummary: ResearchSummary
          try {
            parsedSummary = typeof summary === 'string' ? JSON.parse(summary) : summary as ResearchSummary
          } catch {
            parsedSummary = summary as ResearchSummary
          }

          return {
            success: true,
            summary: parsedSummary,
            steps: result.steps,
            durationMs: result.durationMs
          }
        }
      }

      return {
        success: result.success,
        error: result.error,
        steps: result.steps,
        durationMs: result.durationMs
      }
    },

    /**
     * Get current team state
     */
    getState() {
      return runtime.getState().toObject()
    },

    /**
     * Clean up all agent resources
     */
    async destroy(): Promise<void> {
      await Promise.all([
        queryPlannerAgent.destroy(),
        searcherAgent.destroy(),
        reviewerAgent.destroy(),
        summarizerAgent.destroy()
      ])
    }
  }
}

// Type export
export type LiteratureTeamLLM = ReturnType<typeof createLiteratureTeamLLM>

// ============================================================================
// Main (Example Usage)
// ============================================================================

async function main() {
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    console.error('  export OPENAI_API_KEY=sk-xxx')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('Literature Research Multi-Agent Team (LLM-Powered)')
  console.log('='.repeat(60))
  console.log('')
  console.log('This version uses:')
  console.log('  - QueryPlanner (LLM): Creates optimized search strategies')
  console.log('  - Searcher (APIs): Real Semantic Scholar, arXiv, OpenAlex searches')
  console.log('  - Reviewer (LLM): Evaluates relevance, identifies gaps')
  console.log('  - Summarizer (LLM): Creates comprehensive synthesis')
  console.log('')
  console.log('Flow: QueryPlanner → Searcher → loop(Reviewer → Searcher) → Summarizer')
  console.log('')
  console.log('-'.repeat(60))
  console.log('')

  const team = createLiteratureTeamLLM({
    apiKey,
    model: 'gpt-4o-mini',
    maxReviewIterations: 2,
    onProgress: (info) => {
      console.log(`[Progress] ${info.agent}: ${info.status}`)
    }
  })

  try {
    console.log('[Team] Starting literature research...\n')

    const result = await team.research(`
      Find recent papers about retrieval augmented generation (RAG) for large language models.
      Focus on:
      1. Techniques for improving retrieval quality
      2. Integration with LLMs
      3. Evaluation methods

      Looking for papers from 2023-2024.
    `)

    console.log('')
    console.log('='.repeat(60))
    console.log('RESEARCH RESULTS')
    console.log('='.repeat(60))
    console.log('')
    console.log('Success:', result.success)
    console.log('Steps:', result.steps)
    console.log('Duration:', (result.durationMs / 1000).toFixed(1), 'seconds')

    if (result.summary) {
      console.log('')
      console.log('-'.repeat(60))
      console.log('SUMMARY')
      console.log('-'.repeat(60))
      console.log('')
      console.log('Title:', result.summary.title)
      console.log('')
      console.log('Overview:', result.summary.overview)
      console.log('')

      if (result.summary.papers?.length > 0) {
        console.log('Top Papers:')
        for (const paper of result.summary.papers.slice(0, 5)) {
          console.log(`  • ${paper.title}`)
          console.log(`    ${paper.authors}, ${paper.year}${paper.venue ? `, ${paper.venue}` : ''}`)
          if (paper.summary) console.log(`    → ${paper.summary}`)
          console.log('')
        }
      }

      if (result.summary.themes?.length > 0) {
        console.log('Themes:')
        for (const theme of result.summary.themes) {
          console.log(`  • ${theme.name}`)
          console.log(`    Insight: ${theme.insight}`)
          console.log('')
        }
      }

      if (result.summary.keyFindings?.length > 0) {
        console.log('Key Findings:')
        for (const finding of result.summary.keyFindings) {
          console.log(`  • ${finding}`)
        }
        console.log('')
      }

      if (result.summary.researchGaps?.length > 0) {
        console.log('Research Gaps:')
        for (const gap of result.summary.researchGaps) {
          console.log(`  • ${gap}`)
        }
        console.log('')
      }

      if (result.summary.suggestedFollowUp?.length > 0) {
        console.log('Suggested Follow-up:')
        for (const suggestion of result.summary.suggestedFollowUp) {
          console.log(`  • ${suggestion}`)
        }
      }
    }

    if (result.error) {
      console.log('')
      console.log('Error:', result.error)
    }

  } catch (error) {
    console.error('Research failed:', error)
  } finally {
    await team.destroy()
    console.log('\nTeam destroyed.')
  }
}

// Run if executed directly
if (process.argv[1]?.includes('literature-agent/team-llm')) {
  main().catch(console.error)
}

export default createLiteratureTeamLLM
