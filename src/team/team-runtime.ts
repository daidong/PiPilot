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
import {
  TeamEventEmitter,
  createEventEmitter,
  type TeamRuntimeEvents,
  type EventHandler,
  type Unsubscribe,
  type TokenUsage
} from './runtime/events.js'

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
  private eventEmitter: TeamEventEmitter

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

    // Create event emitter
    this.eventEmitter = createEventEmitter()
  }

  /**
   * Subscribe to runtime events
   *
   * @example
   * ```typescript
   * runtime.on('agent.started', ({ agentId }) => console.log(`Starting ${agentId}`))
   * runtime.on('agent.completed', ({ agentId, durationMs }) => console.log(`${agentId} done in ${durationMs}ms`))
   * ```
   */
  on<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe {
    return this.eventEmitter.on(event, handler)
  }

  /**
   * Subscribe to a runtime event (one-time handler)
   */
  once<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe {
    return this.eventEmitter.once(event, handler)
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

    // Emit team started event
    this.eventEmitter.emit('team.started', {
      teamId: this.team.id,
      runId,
      input,
      ts: Date.now()
    })

    // Record start (legacy trace)
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
          record: (event) => this.handleTraceEvent(event as TeamTraceEvent, runId)
        },
        invokeAgent: async (agentId, agentInput, execCtx) => {
          step++
          execCtx.step = step
          const agentStartTime = Date.now()

          // Emit agent started event
          this.eventEmitter.emit('agent.started', {
            agentId,
            runId,
            input: agentInput,
            step,
            ts: agentStartTime
          })

          this.onProgress?.({ step, agentId, status: 'invoking' })

          try {
            const result = await this.agentInvoker(agentId, agentInput, execCtx)
            const agentDurationMs = Date.now() - agentStartTime

            // Extract token usage if available
            const tokens = extractTokenUsage(result)

            // Emit agent completed event
            this.eventEmitter.emit('agent.completed', {
              agentId,
              runId,
              output: result,
              durationMs: agentDurationMs,
              tokens,
              step,
              ts: Date.now()
            })

            return result
          } catch (error) {
            const agentDurationMs = Date.now() - agentStartTime

            // Emit agent failed event
            this.eventEmitter.emit('agent.failed', {
              agentId,
              runId,
              error: error instanceof Error ? error : new Error(String(error)),
              durationMs: agentDurationMs,
              step,
              ts: Date.now()
            })

            throw error
          }
        },
        concurrency: this.team.defaults?.concurrency ?? 4
      }

      // Execute the flow
      const result = await executeFlow(this.team.flow, ctx)
      const durationMs = Date.now() - startTime

      // Emit team completed event
      if (result.success) {
        this.eventEmitter.emit('team.completed', {
          teamId: this.team.id,
          runId,
          output: result.output,
          durationMs,
          steps: step,
          ts: Date.now()
        })
      } else {
        this.eventEmitter.emit('team.failed', {
          teamId: this.team.id,
          runId,
          error: new Error(result.error ?? 'Unknown error'),
          durationMs,
          ts: Date.now()
        })
      }

      // Record completion (legacy trace)
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
        durationMs,
        trace: this.traceEvents,
        finalState: this.state.toObject()
      }
    } catch (error) {
      const durationMs = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Emit team failed event
      this.eventEmitter.emit('team.failed', {
        teamId: this.team.id,
        runId,
        error: error instanceof Error ? error : new Error(errorMessage),
        durationMs,
        ts: Date.now()
      })

      // Record failure (legacy trace)
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
        durationMs,
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

  /**
   * Get the event emitter for direct access
   */
  getEventEmitter(): TeamEventEmitter {
    return this.eventEmitter
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Handle trace events from the executor and emit corresponding runtime events
   */
  private handleTraceEvent(event: TeamTraceEvent, runId: string): void {
    this.recordTrace(event)

    // Emit corresponding runtime events based on trace event type
    if (event.type === 'flow.node.start') {
      this.eventEmitter.emit('step.started', {
        stepId: event.nodeId,
        kind: event.kind,
        runId,
        name: event.name,
        ts: event.ts
      })
    } else if (event.type === 'flow.node.end') {
      if (event.success) {
        this.eventEmitter.emit('step.completed', {
          stepId: event.nodeId,
          kind: event.kind,
          runId,
          output: undefined, // Output not available in trace event
          durationMs: 0, // Duration not available directly
          ts: event.ts
        })
      } else {
        this.eventEmitter.emit('step.failed', {
          stepId: event.nodeId,
          kind: event.kind,
          runId,
          error: new Error(event.error ?? 'Unknown error'),
          durationMs: 0,
          ts: event.ts
        })
      }
    } else if (event.type === 'loop.iteration') {
      this.eventEmitter.emit('loop.iteration', {
        loopId: event.nodeId,
        runId,
        iteration: event.iteration,
        maxIterations: 0, // Not available in current trace
        continuing: event.continuing,
        ts: event.ts
      })
    } else if (event.type === 'router.decision') {
      if (event.routerType === 'branch') {
        this.eventEmitter.emit('branch.decision', {
          branchId: event.nodeId,
          runId,
          taken: event.chosen as 'then' | 'else',
          ts: event.ts
        })
      } else if (event.routerType === 'select') {
        this.eventEmitter.emit('select.decision', {
          selectId: event.nodeId,
          runId,
          selected: event.chosen,
          usedDefault: false, // Not tracked currently
          ts: event.ts
        })
      }
    } else if (event.type === 'state.write') {
      this.eventEmitter.emit('state.updated', {
        path: event.path,
        value: undefined, // Value not available in trace
        runId,
        ts: event.ts
      })
    }
  }

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

/**
 * Extract token usage from agent result if available
 */
function extractTokenUsage(result: unknown): TokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined

  const r = result as Record<string, unknown>

  // Check for direct usage property
  if (r.usage && typeof r.usage === 'object') {
    const usage = r.usage as Record<string, unknown>
    if (
      typeof usage.promptTokens === 'number' &&
      typeof usage.completionTokens === 'number'
    ) {
      return {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens as number ?? (usage.promptTokens + usage.completionTokens)
      }
    }
  }

  // Check for tokens property (alternative format)
  if (r.tokens && typeof r.tokens === 'object') {
    const tokens = r.tokens as Record<string, unknown>
    if (
      typeof tokens.promptTokens === 'number' &&
      typeof tokens.completionTokens === 'number'
    ) {
      return {
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        totalTokens: tokens.totalTokens as number ?? (tokens.promptTokens + tokens.completionTokens)
      }
    }
  }

  return undefined
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
