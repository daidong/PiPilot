/**
 * Literature Research Multi-Agent Team (LLM-Powered)
 *
 * A team of real LLM-powered agents for academic literature research.
 * Each agent uses actual LLM calls with specialized prompts.
 *
 * Team Structure:
 * - QueryPlanner (LLM): Analyzes requests and creates search strategies
 * - Searcher (LLM + Tools): Executes real academic database searches
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
  /** Project path (default: cwd) */
  projectPath?: string
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
 * All agents use real LLM calls with specialized prompts.
 * The Searcher agent also calls real academic APIs (Semantic Scholar, arXiv, OpenAlex).
 */
export function createLiteratureTeamLLM(config: LiteratureTeamLLMConfig) {
  const {
    apiKey,
    projectPath = process.cwd(),
    model = 'gpt-4o-mini',
    maxReviewIterations = 2,
    onProgress
  } = config

  if (!apiKey) {
    throw new Error('API key is required for LLM-powered agents')
  }

  // Create LLM-powered agent instances
  const queryPlannerAgent = createLLMQueryPlannerAgent({ apiKey, projectPath, model })
  const searcherAgent = createLLMSearcherAgent({ apiKey, projectPath, model })
  const reviewerAgent = createLLMReviewerAgent({ apiKey, projectPath, model })
  const summarizerAgent = createLLMSummarizerAgent({ apiKey, projectPath, model })

  // Define the team
  const team = defineTeam({
    id: 'literature-research-team-llm',
    name: 'Literature Research Team (LLM-Powered)',
    description: 'A multi-agent team using real LLM agents for comprehensive academic literature research',

    agents: {
      queryPlanner: agentHandle('queryPlanner', queryPlannerAgent, {
        role: 'Query Strategist (LLM)',
        capabilities: ['query-expansion', 'search-strategy', 'topic-analysis']
      }),
      searcher: agentHandle('searcher', searcherAgent, {
        role: 'Literature Searcher (LLM + APIs)',
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
        agentSec: 120, // Longer timeout for LLM calls
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
      summary?: unknown
      error?: string
      steps: number
      durationMs: number
    }> {
      const result = await runtime.run({ userRequest: request })

      if (result.success && result.finalState) {
        const stateData = result.finalState['literature-llm'] as Record<string, unknown> | undefined
        const summary = stateData?.[STATE_PATHS.SUMMARY]

        if (summary) {
          let parsedSummary: unknown
          try {
            parsedSummary = typeof summary === 'string' ? JSON.parse(summary) : summary
          } catch {
            parsedSummary = summary
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
  console.log('This version uses REAL LLM agents with actual API calls:')
  console.log('  1. QueryPlanner (LLM): Analyzes request, creates search strategy')
  console.log('  2. Searcher (LLM + APIs): Searches Semantic Scholar, arXiv, OpenAlex')
  console.log('  3. Reviewer (LLM): Evaluates relevance, identifies gaps')
  console.log('  4. Summarizer (LLM): Creates comprehensive research synthesis')
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
    console.log('[Team] Starting literature research with LLM agents...\n')

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
    console.log('Duration:', result.durationMs, 'ms')

    if (result.summary) {
      console.log('')
      console.log('-'.repeat(60))
      console.log('SUMMARY')
      console.log('-'.repeat(60))
      console.log('')
      console.log(JSON.stringify(result.summary, null, 2))
    }

    if (result.error) {
      console.log('')
      console.log('Error:', result.error)
    }

    console.log('')
    console.log('-'.repeat(60))
    console.log('Final State Keys:', Object.keys(team.getState()))

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
