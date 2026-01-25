/**
 * Data Analysis Multi-Agent Team
 *
 * A three-agent team for data analysis:
 * - Planner: Creates analysis plans from user requests
 * - Executor: Runs SQL, Python, file operations
 * - Reviewer: Reviews results, drives refinement loop
 *
 * Flow: User Request → Planner → Executor → loop(Reviewer → Executor) → Output
 *
 * @example
 * ```typescript
 * import { createDataAnalysisTeam } from './index.js'
 *
 * const team = createDataAnalysisTeam({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   databases: { sales: { type: 'sqlite', path: './data/sales.db' } }
 * })
 *
 * const result = await team.analyze('What were the top products by revenue?')
 * console.log(result.output)
 * ```
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
  createBridgedTeamRuntime,
  createMapBasedResolver,
  type TeamRunResult
} from '../../src/team/index.js'

import { plannerAgentDefinition } from './agents/planner.js'
import { executorAgentDefinition } from './agents/executor.js'
import { reviewerAgentDefinition } from './agents/reviewer.js'
import type {
  DataAnalysisTeamConfig,
  AnalysisState
} from './types.js'
import { DEFAULTS, STATE_PATHS } from './types.js'

// ============================================================================
// Team Factory
// ============================================================================

/**
 * Create a Data Analysis Team instance
 *
 * @param config - Team configuration including API key and optional databases
 * @returns Team runtime with analyze method
 */
export function createDataAnalysisTeam(config: DataAnalysisTeamConfig) {
  const {
    apiKey,
    projectPath,
    databases = {},
    maxReviewIterations = DEFAULTS.MAX_REVIEW_ITERATIONS,
    onProgress
  } = config

  // Create agent instances first
  const plannerAgent = plannerAgentDefinition({ apiKey, projectPath })
  const executorAgent = executorAgentDefinition({ apiKey, projectPath })
  const reviewerAgent = reviewerAgentDefinition({ apiKey, projectPath })

  // Define team with the actual agent instances
  const teamDef = defineTeam({
    id: 'data-analysis-team',
    name: 'Data Analysis Team',
    description: 'A team that plans, executes, and reviews data analysis tasks',

    agents: {
      planner: agentHandle('planner', plannerAgent, {
        role: 'Analysis Planner',
        capabilities: ['planning', 'task-decomposition', 'user-communication']
      }),
      executor: agentHandle('executor', executorAgent, {
        role: 'Analysis Executor',
        capabilities: ['sql', 'python', 'file-io', 'data-transformation']
      }),
      reviewer: agentHandle('reviewer', reviewerAgent, {
        role: 'Quality Reviewer',
        capabilities: ['validation', 'quality-check', 'feedback']
      })
    },

    state: stateConfig.memory('data-analysis'),

    flow: seq(
      // Step 1: Planner creates analysis plan from user request
      invoke('planner', input.initial(), {
        outputAs: { path: STATE_PATHS.PLAN },
        name: 'Create analysis plan'
      }),

      // Step 2: Executor runs the initial analysis
      invoke('executor', input.state(STATE_PATHS.PLAN), {
        outputAs: { path: STATE_PATHS.RESULTS },
        name: 'Execute analysis'
      }),

      // Step 3: Review-refine loop
      // Loop: reviewer checks → if issues, executor refines → repeat
      // Results are extracted from state after the loop completes
      loop(
        seq(
          // Reviewer evaluates current results
          invoke('reviewer', input.state(STATE_PATHS.RESULTS), {
            outputAs: { path: STATE_PATHS.FEEDBACK },
            name: 'Review results'
          }),
          // Executor refines based on feedback (writes back to RESULTS)
          invoke('executor', input.state(STATE_PATHS.FEEDBACK), {
            outputAs: { path: STATE_PATHS.RESULTS },
            name: 'Refine based on feedback'
          })
        ),
        until.noCriticalIssues(STATE_PATHS.FEEDBACK),
        { maxIters: maxReviewIterations }
      )
      // Note: Final output is extracted from state in analyze() method
    ),

    defaults: {
      concurrency: 1, // Sequential execution for this workflow
      timeouts: {
        agentSec: 120,
        flowSec: 600
      }
    }
  })

  // Create bridged runtime
  const { runtime, bridge } = createBridgedTeamRuntime(
    {
      team: teamDef,
      agentResolver: createMapBasedResolver({
        planner: plannerAgent,
        executor: executorAgent,
        reviewer: reviewerAgent
      }),
      inputTransform: (agentInput, agentId) => {
        // Augment input with database info for executor
        if (agentId === 'executor' && Object.keys(databases).length > 0) {
          const inputObj = typeof agentInput === 'object' && agentInput !== null
            ? agentInput as Record<string, unknown>
            : { message: agentInput }
          return {
            ...inputObj,
            availableDatabases: databases
          }
        }
        return agentInput
      },
      onError: (error, agentId) => {
        console.error(`[${agentId}] Error:`, error.message)
      }
    }
  )

  return {
    /** The underlying team runtime */
    runtime,

    /** The agent bridge */
    bridge,

    /** Individual agent instances */
    agents: {
      planner: plannerAgent,
      executor: executorAgent,
      reviewer: reviewerAgent
    },

    /**
     * Run a data analysis request
     *
     * @param request - Natural language analysis request
     * @returns Team execution result with analysis in output
     */
    async analyze(request: string): Promise<TeamRunResult> {
      const result = await runtime.run({
        userRequest: request,
        availableDatabases: Object.keys(databases)
      })

      // Extract the actual analysis results from final state
      // The flow writes results to STATE_PATHS.RESULTS
      if (result.success && result.finalState) {
        const stateData = result.finalState['data-analysis'] as Record<string, unknown> | undefined
        const analysisResults = stateData?.[STATE_PATHS.RESULTS]
        if (analysisResults) {
          return {
            ...result,
            output: analysisResults
          }
        }
      }

      return result
    },

    /**
     * Get the current analysis state from the blackboard
     */
    getState(): AnalysisState {
      const state = runtime.getState()
      return state.toObject() as AnalysisState
    },

    /**
     * Clean up all agent resources
     */
    async destroy(): Promise<void> {
      await Promise.all([
        plannerAgent.destroy(),
        executorAgent.destroy(),
        reviewerAgent.destroy()
      ])
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

// Types
export type {
  DataAnalysisTeamConfig,
  AnalysisState,
  AnalysisPlan,
  AnalysisStep,
  AnalysisResults,
  ReviewFeedback,
  ReviewIssue,
  DatabaseConfig,
  ProgressInfo
} from './types.js'

// Constants
export { DEFAULTS, STATE_PATHS, SESSION_KEYS } from './types.js'

// Agent definitions (for customization)
export { plannerAgentDefinition } from './agents/planner.js'
export { executorAgentDefinition } from './agents/executor.js'
export { reviewerAgentDefinition } from './agents/reviewer.js'

// Return type helper
export type DataAnalysisTeam = ReturnType<typeof createDataAnalysisTeam>
