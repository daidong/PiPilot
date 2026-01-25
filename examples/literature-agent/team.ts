/**
 * Literature Research Multi-Agent Team
 *
 * A team-based approach to academic literature research using the
 * AgentFoundry multi-agent team system.
 *
 * Team Structure:
 * - QueryPlanner: Creates optimized search strategies
 * - Searcher: Executes multi-source searches
 * - Reviewer: Evaluates results and identifies gaps
 * - Summarizer: Synthesizes final findings
 *
 * Flow: QueryPlanner → Searcher → loop(Reviewer → Searcher) → Summarizer
 *
 * Usage:
 *   npx tsx examples/literature-agent/team.ts
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
  createQueryPlannerAgent,
  createSearcherAgent,
  createReviewerAgent,
  createSummarizerAgent
} from './agents/index.js'

import type { ResearchSummary } from './agents/summarizer.js'

// State paths for blackboard
const STATE_PATHS = {
  PLAN: 'queryPlan',
  SEARCH_RESULTS: 'searchResults',
  REVIEW: 'review',
  SUMMARY: 'summary'
}

export interface LiteratureTeamConfig {
  maxReviewIterations?: number
  onProgress?: (info: { agent: string; status: string; step?: number }) => void
}

/**
 * Create a Literature Research Team
 *
 * Returns a team runtime configured for literature research with
 * the plan-search-review-summarize workflow.
 */
export function createLiteratureTeam(config: LiteratureTeamConfig = {}) {
  const { maxReviewIterations = 2, onProgress } = config

  // Create agent instances
  const queryPlannerAgent = createQueryPlannerAgent()
  const searcherAgent = createSearcherAgent()
  const reviewerAgent = createReviewerAgent()
  const summarizerAgent = createSummarizerAgent()

  // Define the team
  const team = defineTeam({
    id: 'literature-research-team',
    name: 'Literature Research Team',
    description: 'A multi-agent team for comprehensive academic literature research',

    agents: {
      queryPlanner: agentHandle('queryPlanner', queryPlannerAgent, {
        role: 'Query Strategist',
        capabilities: ['query-expansion', 'search-strategy', 'topic-analysis']
      }),
      searcher: agentHandle('searcher', searcherAgent, {
        role: 'Literature Searcher',
        capabilities: ['api-search', 'multi-source', 'deduplication']
      }),
      reviewer: agentHandle('reviewer', reviewerAgent, {
        role: 'Quality Reviewer',
        capabilities: ['relevance-scoring', 'coverage-analysis', 'gap-detection']
      }),
      summarizer: agentHandle('summarizer', summarizerAgent, {
        role: 'Research Synthesizer',
        capabilities: ['summarization', 'theme-extraction', 'insight-generation']
      })
    },

    state: stateConfig.memory('literature'),

    flow: seq(
      // Step 1: QueryPlanner creates search strategy from user request
      invoke('queryPlanner', input.initial(), {
        outputAs: { path: STATE_PATHS.PLAN },
        name: 'Create search strategy'
      }),

      // Step 2: Searcher executes initial search
      invoke('searcher', input.state(STATE_PATHS.PLAN), {
        outputAs: { path: STATE_PATHS.SEARCH_RESULTS },
        name: 'Execute search'
      }),

      // Step 3: Review-refine loop
      loop(
        seq(
          // Reviewer evaluates results
          invoke('reviewer', input.state(STATE_PATHS.SEARCH_RESULTS), {
            outputAs: { path: STATE_PATHS.REVIEW },
            name: 'Review results'
          }),
          // Searcher refines based on feedback (if needed)
          invoke('searcher', input.state(STATE_PATHS.REVIEW), {
            outputAs: { path: STATE_PATHS.SEARCH_RESULTS },
            name: 'Refine search'
          })
        ),
        until.noCriticalIssues(STATE_PATHS.REVIEW),
        { maxIters: maxReviewIterations }
      ),

      // Step 4: Summarizer creates final synthesis
      invoke('summarizer', input.state(STATE_PATHS.REVIEW), {
        outputAs: { path: STATE_PATHS.SUMMARY },
        name: 'Synthesize findings'
      })
    ),

    defaults: {
      concurrency: 1,
      timeouts: {
        agentSec: 60,
        flowSec: 300
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

    /** Individual agent instances for direct access */
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
        const stateData = result.finalState['literature'] as Record<string, unknown> | undefined
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
export type LiteratureTeam = ReturnType<typeof createLiteratureTeam>

// ============================================================================
// Main (Example Usage)
// ============================================================================

async function main() {
  console.log('='.repeat(60))
  console.log('Literature Research Multi-Agent Team Demo')
  console.log('='.repeat(60))
  console.log('')
  console.log('Team Structure:')
  console.log('  1. QueryPlanner: Creates optimized search strategies')
  console.log('  2. Searcher: Executes multi-source academic searches')
  console.log('  3. Reviewer: Evaluates results, identifies gaps (loop)')
  console.log('  4. Summarizer: Synthesizes final research summary')
  console.log('')
  console.log('Flow: QueryPlanner → Searcher → loop(Reviewer → Searcher) → Summarizer')
  console.log('')
  console.log('-'.repeat(60))
  console.log('')

  const team = createLiteratureTeam({
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
      console.log('Title:', result.summary.title)
      console.log('')
      console.log('Overview:', result.summary.overview)
      console.log('')
      console.log('Papers Found:', result.summary.papers.length)

      console.log('')
      console.log('Top Papers:')
      for (const paper of result.summary.papers.slice(0, 5)) {
        console.log(`  • ${paper.title}`)
        console.log(`    Authors: ${paper.authors}`)
        console.log(`    Year: ${paper.year}${paper.venue ? `, ${paper.venue}` : ''}${paper.citations ? `, Citations: ${paper.citations.toLocaleString()}` : ''}`)
        console.log('')
      }

      console.log('Themes:')
      for (const theme of result.summary.themes) {
        console.log(`  • ${theme.name}`)
        console.log(`    Insight: ${theme.insight}`)
        console.log(`    Papers: ${theme.papers.length}`)
        console.log('')
      }

      if (result.summary.suggestedFollowUp.length > 0) {
        console.log('Suggested Follow-up:')
        for (const suggestion of result.summary.suggestedFollowUp) {
          console.log(`  • ${suggestion}`)
        }
      }
    }

    console.log('')
    console.log('-'.repeat(60))
    console.log('Final State Keys:', Object.keys(team.getState()))

  } finally {
    await team.destroy()
    console.log('\nTeam destroyed.')
  }
}

// Run if executed directly
if (process.argv[1]?.includes('literature-agent/team')) {
  main().catch(console.error)
}

export default createLiteratureTeam
