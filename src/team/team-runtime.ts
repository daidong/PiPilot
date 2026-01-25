/**
 * Team Runtime - Execute multi-agent teams
 *
 * The TeamRuntime coordinates agent execution, state management,
 * and flow execution for a defined team.
 */

import { randomUUID } from 'node:crypto'
import type { TeamDefinition } from './define-team.js'
import { AgentRegistry, createAgentRegistry } from './agent-registry.js'
import { createReducerRegistry, type ReducerRegistry } from './flow/reducers.js'
import { createBlackboard, type Blackboard } from './state/blackboard.js'
import { executeFlow, type ExecutionContext, type FlowTraceEvent, type AgentInvoker } from './flow/executor.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Team run result
 */
export interface TeamRunResult {
  /** Whether the run succeeded */
  success: boolean
  /** Final output */
  output: unknown
  /** Error message if failed */
  error?: string
  /** Run ID for tracing */
  runId: string
  /** Total steps executed */
  steps: number
  /** Duration in milliseconds */
  durationMs: number
  /** Trace events */
  trace: TeamTraceEvent[]
  /** Final state snapshot */
  finalState?: Record<string, unknown>
}

/**
 * Team trace event (union of all event types)
 */
export type TeamTraceEvent =
  | { type: 'team.start'; runId: string; teamId: string; ts: number; inputSummary?: string }
  | { type: 'team.complete'; runId: string; teamId: string; ts: number; success: boolean; error?: string }
  | FlowTraceEvent
  | { type: 'state.write'; runId: string; ts: number; path: string; version?: number; bytes?: number; op?: string }
  | { type: 'state.read'; runId: string; ts: number; path: string; version?: number; bytes?: number }
  | { type: 'reducer.apply'; runId: string; nodeId: string; reducerId: string; ts: number; args?: Record<string, unknown>; inputDigests: string[]; outputDigest: string }

/**
 * Team runtime configuration
 */
export interface TeamRuntimeConfig {
  /** The team definition */
  team: TeamDefinition
  /** Agent invoker function */
  agentInvoker: AgentInvoker
  /** Optional custom reducer registry */
  reducerRegistry?: ReducerRegistry
  /** Trace event handler */
  onTrace?: (event: TeamTraceEvent) => void
  /** Progress callback */
  onProgress?: (info: { step: number; agentId?: string; status: string }) => void
}

// ============================================================================
// Team Runtime
// ============================================================================

/**
 * Runtime for executing multi-agent teams
 */
export class TeamRuntime {
  private team: TeamDefinition
  private agentRegistry: AgentRegistry
  private reducerRegistry: ReducerRegistry
  private state: Blackboard
  private agentInvoker: AgentInvoker
  private onTrace?: (event: TeamTraceEvent) => void
  private onProgress?: (info: { step: number; agentId?: string; status: string }) => void
  private traceEvents: TeamTraceEvent[] = []

  constructor(config: TeamRuntimeConfig) {
    this.team = config.team
    this.agentInvoker = config.agentInvoker
    this.onTrace = config.onTrace
    this.onProgress = config.onProgress

    // Create agent registry
    this.agentRegistry = createAgentRegistry(this.team)

    // Create reducer registry with built-ins + custom
    this.reducerRegistry = config.reducerRegistry ?? createReducerRegistry()
    if (this.team.reducers) {
      for (const reducer of this.team.reducers) {
        this.reducerRegistry.register(reducer)
      }
    }

    // Create shared state
    this.state = createBlackboard(
      this.team.state ?? { storage: 'memory', namespace: this.team.id }
    )
  }

  /**
   * Run the team with given input
   */
  async run(input: unknown): Promise<TeamRunResult> {
    const runId = randomUUID()
    const startTime = Date.now()
    let step = 0

    // Clear trace for this run
    this.traceEvents = []

    // Record start
    this.recordTrace({
      type: 'team.start',
      runId,
      teamId: this.team.id,
      ts: Date.now(),
      inputSummary: summarizeInput(input)
    })

    try {
      // Create execution context
      const ctx: ExecutionContext = {
        runId,
        step,
        agentRegistry: this.agentRegistry,
        reducerRegistry: this.reducerRegistry,
        state: this.state,
        initialInput: input,
        prevOutput: input,
        trace: {
          record: (event) => this.recordTrace(event as TeamTraceEvent)
        },
        invokeAgent: async (agentId, agentInput, execCtx) => {
          step++
          execCtx.step = step
          this.onProgress?.({ step, agentId, status: 'invoking' })
          return this.agentInvoker(agentId, agentInput, execCtx)
        },
        concurrency: this.team.defaults?.concurrency ?? 4
      }

      // Execute the flow
      const result = await executeFlow(this.team.flow, ctx)

      // Record completion
      this.recordTrace({
        type: 'team.complete',
        runId,
        teamId: this.team.id,
        ts: Date.now(),
        success: result.success,
        error: result.error
      })

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        runId,
        steps: step,
        durationMs: Date.now() - startTime,
        trace: this.traceEvents,
        finalState: this.state.toObject()
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Record failure
      this.recordTrace({
        type: 'team.complete',
        runId,
        teamId: this.team.id,
        ts: Date.now(),
        success: false,
        error: errorMessage
      })

      return {
        success: false,
        output: undefined,
        error: errorMessage,
        runId,
        steps: step,
        durationMs: Date.now() - startTime,
        trace: this.traceEvents,
        finalState: this.state.toObject()
      }
    }
  }

  /**
   * Get the agent registry
   */
  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry
  }

  /**
   * Get the reducer registry
   */
  getReducerRegistry(): ReducerRegistry {
    return this.reducerRegistry
  }

  /**
   * Get the shared state
   */
  getState(): Blackboard {
    return this.state
  }

  /**
   * Get the team definition
   */
  getTeam(): TeamDefinition {
    return this.team
  }

  /**
   * Reset the runtime state
   */
  reset(): void {
    this.state.clear()
    this.traceEvents = []
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private recordTrace(event: TeamTraceEvent): void {
    this.traceEvents.push(event)
    this.onTrace?.(event)
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a team runtime
 */
export function createTeamRuntime(config: TeamRuntimeConfig): TeamRuntime {
  return new TeamRuntime(config)
}

// ============================================================================
// Helpers
// ============================================================================

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return 'null'
  if (typeof input === 'string') {
    return input.length > 100 ? input.slice(0, 100) + '...' : input
  }
  if (typeof input === 'object') {
    const json = JSON.stringify(input)
    return json.length > 100 ? json.slice(0, 100) + '...' : json
  }
  return String(input)
}

// ============================================================================
// Simple Agent Invoker (for testing)
// ============================================================================

/**
 * Create a simple agent invoker that just passes through input
 * (useful for testing flows without real agents)
 */
export function createPassthroughInvoker(): AgentInvoker {
  return async (_agentId, input) => input
}

/**
 * Create a mock agent invoker with predefined responses
 */
export function createMockInvoker(
  responses: Record<string, unknown | ((input: unknown) => unknown | Promise<unknown>)>
): AgentInvoker {
  return async (agentId, input) => {
    const response = responses[agentId]
    if (response === undefined) {
      throw new Error(`No mock response for agent: ${agentId}`)
    }
    if (typeof response === 'function') {
      return response(input)
    }
    return response
  }
}
