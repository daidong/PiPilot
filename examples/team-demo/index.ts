/**
 * Multi-Agent Team Demo
 *
 * A simple example demonstrating the multi-agent team system
 * using mock agents that show clear data flow.
 *
 * Flow: Planner → Executor → loop(Reviewer → Executor) → Final Output
 *
 * Usage:
 *   npx tsx examples/team-demo/index.ts
 */

import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  createAutoTeamRuntime,
  type TeamRunResult
} from '../../src/team/index.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// ============================================================================
// AST Helpers (for mock agents without Zod schemas)
// ============================================================================

/**
 * Build an invoke spec for mock agents (without Zod schemas).
 * For real LLM agents, use step().in().out() instead.
 */
function buildInvoke(
  agent: string,
  inputRef: InputRef,
  options?: { outputAs?: { path: string }; name?: string }
): InvokeSpec {
  return {
    kind: 'invoke',
    agent,
    input: inputRef,
    outputAs: options?.outputAs,
    name: options?.name
  }
}

const inputRef = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

// ============================================================================
// Mock Agent Type
// ============================================================================

interface MockAgent {
  id: string
  run: (input: string) => Promise<{ success: boolean; output: string }>
  destroy: () => Promise<void>
}

// ============================================================================
// Mock Agents - Simple functions that transform data
// ============================================================================

/**
 * Planner Agent - Parses request and creates a plan
 */
function createPlannerAgent(): MockAgent {
  return {
    id: 'planner',
    async run(input: string) {
      console.log('  [Planner] Received:', input.substring(0, 50) + '...')

      // Parse the numbers from the request
      const numbers = input.match(/\d+/g)?.map(Number) || [1, 2, 3]

      const plan = {
        task: 'calculate_sum_and_average',
        numbers,
        steps: ['sum', 'average', 'format']
      }

      console.log('  [Planner] Created plan:', JSON.stringify(plan))
      return { success: true, output: JSON.stringify(plan) }
    },
    async destroy() {}
  }
}

/**
 * Executor Agent - Executes the plan and produces results
 */
function createExecutorAgent(): MockAgent {
  let executionCount = 0

  return {
    id: 'executor',
    async run(input: string) {
      executionCount++
      console.log(`  [Executor] Run #${executionCount}, received:`, input.substring(0, 80))

      try {
        const data = JSON.parse(input)

        // If this is feedback (from reviewer), refine the results
        if ('approved' in data) {
          if (data.approved === true) {
            // Approved - just return the previous results as final
            console.log('  [Executor] Results approved, returning final output')
            const finalResult = {
              ...data.previousResults,
              status: 'approved',
              reviewConfidence: data.confidence
            }
            return { success: true, output: JSON.stringify(finalResult) }
          } else {
            // Not approved - refine based on feedback
            console.log('  [Executor] Refining based on feedback...')
            const issues = data.issues || []

            let sum = data.previousResults?.sum || 0
            let avg = data.previousResults?.average || 0

            for (const issue of issues) {
              if (issue.includes('precision')) {
                avg = Math.round(avg * 100) / 100
              }
            }

            const result = {
              sum,
              average: avg,
              formatted: `Sum: ${sum}, Average: ${avg.toFixed(2)}`,
              refinementCount: executionCount - 1,
              numbers: data.previousResults?.numbers
            }

            console.log('  [Executor] Refined result:', JSON.stringify(result))
            return { success: true, output: JSON.stringify(result) }
          }
        }

        // Otherwise, execute the plan (initial calculation)
        if (data.numbers) {
          const numbers = data.numbers as number[]
          const sum = numbers.reduce((a, b) => a + b, 0)
          const avg = sum / numbers.length

          const result = {
            sum,
            average: avg,
            formatted: `Sum: ${sum}, Average: ${avg}`,
            numbers
          }

          console.log('  [Executor] Calculated result:', JSON.stringify(result))
          return { success: true, output: JSON.stringify(result) }
        }

        return { success: true, output: input }
      } catch {
        return { success: true, output: input }
      }
    },
    async destroy() {}
  }
}

/**
 * Reviewer Agent - Reviews results and provides feedback
 */
function createReviewerAgent(): MockAgent {
  let reviewCount = 0

  return {
    id: 'reviewer',
    async run(input: string) {
      reviewCount++
      console.log(`  [Reviewer] Review #${reviewCount}, checking:`, input.substring(0, 80))

      try {
        const results = JSON.parse(input)

        // Check for issues
        const issues: string[] = []

        // First review: always find an issue to demonstrate the loop
        if (reviewCount === 1 && results.average && !Number.isInteger(results.average * 100)) {
          issues.push('Average needs more precision (round to 2 decimal places)')
        }

        const approved = issues.length === 0
        const feedback = {
          approved,
          confidence: approved ? 0.95 : 0.6,
          issues,
          suggestions: approved ? ['Good job!'] : ['Please fix the precision issue'],
          previousResults: results
        }

        console.log(`  [Reviewer] ${approved ? 'APPROVED' : 'NEEDS REVISION'}:`, JSON.stringify(feedback))
        return { success: true, output: JSON.stringify(feedback) }
      } catch {
        return {
          success: true,
          output: JSON.stringify({ approved: true, confidence: 0.5, issues: [] })
        }
      }
    },
    async destroy() {}
  }
}

// ============================================================================
// Team Definition & Runtime
// ============================================================================

const STATE_PATHS = {
  PLAN: 'plan',
  RESULTS: 'results',
  FEEDBACK: 'feedback'
}

/**
 * Create the demo team
 */
export function createDemoTeam() {
  // Create mock agents
  const plannerAgent = createPlannerAgent()
  const executorAgent = createExecutorAgent()
  const reviewerAgent = createReviewerAgent()

  // Helper to create a runner for mock agents
  const createMockRunner = (agent: MockAgent) => {
    return async (input: unknown) => {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      const result = await agent.run(inputStr)
      return result.output
    }
  }

  // Define team using AST-level flow spec (for mock agents)
  // For real LLM agents with Zod schemas, use step().in().out() instead
  const team = defineTeam({
    id: 'demo-team',
    name: 'Demo Multi-Agent Team',
    description: 'Demonstrates plan-execute-review workflow',

    agents: {
      planner: agentHandle('planner', plannerAgent, { runner: createMockRunner(plannerAgent) }),
      executor: agentHandle('executor', executorAgent, { runner: createMockRunner(executorAgent) }),
      reviewer: agentHandle('reviewer', reviewerAgent, { runner: createMockRunner(reviewerAgent) })
    },

    state: stateConfig.memory('demo'),

    flow: seq(
      // Step 1: Planner creates a plan
      buildInvoke('planner', inputRef.initial(), {
        outputAs: { path: STATE_PATHS.PLAN },
        name: 'Create plan'
      }),

      // Step 2: Executor runs initial analysis
      buildInvoke('executor', inputRef.state(STATE_PATHS.PLAN), {
        outputAs: { path: STATE_PATHS.RESULTS },
        name: 'Execute plan'
      }),

      // Step 3: Review-refine loop
      loop(
        seq(
          buildInvoke('reviewer', inputRef.state(STATE_PATHS.RESULTS), {
            outputAs: { path: STATE_PATHS.FEEDBACK },
            name: 'Review results'
          }),
          buildInvoke('executor', inputRef.state(STATE_PATHS.FEEDBACK), {
            outputAs: { path: STATE_PATHS.RESULTS },
            name: 'Refine results'
          })
        ),
        // Until condition: approved field equals true
        { type: 'field-eq', path: `${STATE_PATHS.FEEDBACK}.approved`, value: true },
        { maxIters: 3 }
      )
    )
  })

  // Agent instances for cleanup
  const agents: Record<string, MockAgent> = {
    planner: plannerAgent,
    executor: executorAgent,
    reviewer: reviewerAgent
  }

  // Create runtime - no manual agentInvoker switch needed!
  // Custom runners are provided via agentHandle() above
  const runtime = createAutoTeamRuntime({ team, context: {} })

  return {
    runtime,
    agents,

    async run(request: string): Promise<TeamRunResult> {
      const result = await runtime.run(request)

      // Extract results from state
      if (result.success && result.finalState) {
        const stateData = result.finalState['demo'] as Record<string, unknown> | undefined
        const analysisResults = stateData?.[STATE_PATHS.RESULTS]
        if (analysisResults) {
          return { ...result, output: analysisResults }
        }
      }

      return result
    },

    getState() {
      return runtime.getState().toObject()
    },

    async destroy() {
      await Promise.all(Object.values(agents).map(a => a.destroy()))
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('=' .repeat(60))
  console.log('Multi-Agent Team Demo')
  console.log('=' .repeat(60))
  console.log('')
  console.log('This demo shows a plan-execute-review workflow:')
  console.log('  1. Planner: Creates a calculation plan')
  console.log('  2. Executor: Performs the calculation')
  console.log('  3. Reviewer: Checks results (will find issue on first review)')
  console.log('  4. Executor: Refines based on feedback')
  console.log('  5. Reviewer: Approves the refined results')
  console.log('')
  console.log('-'.repeat(60))
  console.log('')

  const team = createDemoTeam()

  try {
    console.log('[Team] Starting analysis...\n')

    // Use numbers that produce a non-integer average to trigger the review loop
    // 10 + 20 + 31 = 61, average = 20.333... (will trigger precision issue)
    const result = await team.run('Calculate the sum and average of: 10, 20, 31')

    console.log('')
    console.log('=' .repeat(60))
    console.log('FINAL RESULT')
    console.log('=' .repeat(60))
    console.log('')
    console.log('Success:', result.success)
    console.log('Steps:', result.steps)
    console.log('Duration:', result.durationMs, 'ms')
    console.log('')
    console.log('Output:')

    if (typeof result.output === 'string') {
      try {
        console.log(JSON.stringify(JSON.parse(result.output), null, 2))
      } catch {
        console.log(result.output)
      }
    } else {
      console.log(JSON.stringify(result.output, null, 2))
    }

    console.log('')
    console.log('-'.repeat(60))
    console.log('Final State:')
    const state = team.getState()
    console.log(JSON.stringify(state, null, 2))

  } finally {
    await team.destroy()
  }
}

// Run if executed directly
main().catch(console.error)
