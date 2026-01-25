/**
 * Team Runtime Events - First-class Event System
 *
 * Provides a typed event system for observing team execution.
 * Users can subscribe to specific events without writing custom callbacks.
 *
 * @example
 * ```typescript
 * const runtime = createTeamRuntime(team, config)
 *
 * // Subscribe to events
 * runtime.on('agent.started', ({ agentId, input }) => {
 *   console.log(`Starting ${agentId}...`)
 * })
 *
 * runtime.on('agent.completed', ({ agentId, durationMs, tokens }) => {
 *   console.log(`${agentId} completed in ${durationMs}ms`)
 * })
 *
 * // Execute
 * const result = await runtime.run(input)
 * ```
 */

// ============================================================================
// Token Usage Type
// ============================================================================

/**
 * Token usage information from LLM calls
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// ============================================================================
// Base Event Interface (Correlation Fields)
// ============================================================================

/**
 * Base interface for all team runtime events.
 * Provides correlation fields for distributed tracing and observability.
 */
export interface BaseEvent {
  /** Unique ID for this team.run() invocation */
  runId: string
  /** Unique span ID for this specific operation (for distributed tracing) */
  spanId: string
  /** Parent span ID (for nested operations like loops, branches) */
  parentSpanId: string | null
  /** Nesting depth (0 = top level) */
  depth: number
  /** Timestamp (Date.now()) */
  ts: number
  /** Optional tags for filtering/grouping */
  tags?: Record<string, string | number | boolean>
}

/**
 * Generate a unique span ID
 */
export function generateSpanId(): string {
  return `span-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Generate a unique run ID
 */
export function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ============================================================================
// Event Definitions
// ============================================================================

/**
 * All team runtime events with their payload types
 */
export interface TeamRuntimeEvents {
  // Team-level events
  'team.started': TeamStartedEvent
  'team.completed': TeamCompletedEvent
  'team.failed': TeamFailedEvent

  // Agent-level events
  'agent.started': AgentStartedEvent
  'agent.completed': AgentCompletedEvent
  'agent.failed': AgentFailedEvent

  // Flow step events
  'step.started': StepStartedEvent
  'step.completed': StepCompletedEvent
  'step.failed': StepFailedEvent

  // Loop events
  'loop.iteration': LoopIterationEvent
  'loop.completed': LoopCompletedEvent

  // State events
  'state.updated': StateUpdatedEvent

  // Branch/Select events
  'branch.decision': BranchDecisionEvent
  'select.decision': SelectDecisionEvent
}

// ============================================================================
// Event Payloads
// ============================================================================

/**
 * Team started event
 */
export interface TeamStartedEvent extends BaseEvent {
  /** Team ID */
  teamId: string
  /** Input provided to the team */
  input: unknown
}

/**
 * Team completed event
 */
export interface TeamCompletedEvent extends BaseEvent {
  /** Team ID */
  teamId: string
  /** Final output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
  /** Total steps executed */
  steps: number
  /** Cumulative token usage across all agents */
  totalTokens?: TokenUsage
}

/**
 * Team failed event
 */
export interface TeamFailedEvent extends BaseEvent {
  /** Team ID */
  teamId: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
}

/**
 * Agent started event
 */
export interface AgentStartedEvent extends BaseEvent {
  /** Agent ID */
  agentId: string
  /** Input provided to the agent */
  input: unknown
  /** Step number */
  step: number
}

/**
 * Agent completed event
 */
export interface AgentCompletedEvent extends BaseEvent {
  /** Agent ID */
  agentId: string
  /** Agent output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
  /** Token usage (if available) */
  tokens?: TokenUsage
  /** Number of LLM call attempts (for retries) */
  attempts?: number
  /** Step number */
  step: number
}

/**
 * Agent failed event
 */
export interface AgentFailedEvent extends BaseEvent {
  /** Agent ID */
  agentId: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
  /** Number of LLM call attempts before failure */
  attempts?: number
  /** Step number */
  step: number
}

/**
 * Flow step started event
 */
export interface StepStartedEvent extends BaseEvent {
  /** Step ID */
  stepId: string
  /** Step kind (invoke, seq, par, etc.) */
  kind: string
  /** Optional step name */
  name?: string
}

/**
 * Flow step completed event
 */
export interface StepCompletedEvent extends BaseEvent {
  /** Step ID */
  stepId: string
  /** Step kind */
  kind: string
  /** Step output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
}

/**
 * Flow step failed event
 */
export interface StepFailedEvent extends BaseEvent {
  /** Step ID */
  stepId: string
  /** Step kind */
  kind: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
}

/**
 * Loop iteration event
 */
export interface LoopIterationEvent extends BaseEvent {
  /** Loop ID */
  loopId: string
  /** Current iteration (1-based) */
  iteration: number
  /** Maximum iterations allowed */
  maxIterations: number
  /** Whether loop will continue */
  continuing: boolean
}

/**
 * Loop completed event
 */
export interface LoopCompletedEvent extends BaseEvent {
  /** Loop ID */
  loopId: string
  /** Total iterations executed */
  totalIterations: number
  /** Reason for stopping */
  reason: 'condition-met' | 'max-iterations' | 'error' | 'no-actionable-refinement'
  /** Duration in milliseconds */
  durationMs: number
}

/**
 * State updated event
 */
export interface StateUpdatedEvent extends BaseEvent {
  /** Path that was updated */
  path: string
  /** New value */
  value: unknown
  /** Previous value (if available) */
  previousValue?: unknown
  /** Agent that made the update */
  updatedBy?: string
}

/**
 * Branch decision event
 */
export interface BranchDecisionEvent extends BaseEvent {
  /** Branch step ID */
  branchId: string
  /** Which branch was taken */
  taken: 'then' | 'else'
  /** Condition evaluation result */
  conditionValue?: unknown
}

/**
 * Select decision event
 */
export interface SelectDecisionEvent extends BaseEvent {
  /** Select step ID */
  selectId: string
  /** Branch key that was selected */
  selected: string
  /** Whether default branch was used */
  usedDefault: boolean
}

// ============================================================================
// Event Handler Types
// ============================================================================

/**
 * Event handler function type
 */
export type EventHandler<T> = (event: T) => void

/**
 * Unsubscribe function returned by on()
 */
export type Unsubscribe = () => void

// ============================================================================
// Typed Event Emitter
// ============================================================================

/**
 * Typed event emitter for team runtime events
 */
export class TeamEventEmitter {
  private handlers: Map<string, Set<EventHandler<unknown>>> = new Map()

  /**
   * Subscribe to an event
   *
   * @param event Event name to subscribe to
   * @param handler Handler function to call when event is emitted
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = emitter.on('agent.started', (event) => {
   *   console.log(`Agent ${event.agentId} started`)
   * })
   *
   * // Later, to unsubscribe:
   * unsubscribe()
   * ```
   */
  on<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>)

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>)
    }
  }

  /**
   * Subscribe to an event (one-time handler)
   * Handler is automatically removed after first invocation
   *
   * @param event Event name to subscribe to
   * @param handler Handler function to call once
   */
  once<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe {
    const wrapper = (data: TeamRuntimeEvents[E]) => {
      unsubscribe()
      handler(data)
    }
    const unsubscribe = this.on(event, wrapper)
    return unsubscribe
  }

  /**
   * Emit an event to all subscribers
   *
   * @param event Event name
   * @param data Event payload
   */
  emit<E extends keyof TeamRuntimeEvents>(
    event: E,
    data: TeamRuntimeEvents[E]
  ): void {
    const handlers = this.handlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data)
        } catch (error) {
          // Log but don't throw - don't let one handler break others
          console.error(`Error in event handler for ${event}:`, error)
        }
      }
    }
  }

  /**
   * Remove all handlers for an event
   *
   * @param event Event name
   */
  off<E extends keyof TeamRuntimeEvents>(event: E): void {
    this.handlers.delete(event)
  }

  /**
   * Remove all handlers for all events
   */
  offAll(): void {
    this.handlers.clear()
  }

  /**
   * Get the number of handlers for an event
   *
   * @param event Event name
   * @returns Number of handlers
   */
  listenerCount<E extends keyof TeamRuntimeEvents>(event: E): number {
    return this.handlers.get(event)?.size ?? 0
  }

  /**
   * Get all registered event names
   *
   * @returns Array of event names with handlers
   */
  eventNames(): Array<keyof TeamRuntimeEvents> {
    return Array.from(this.handlers.keys()) as Array<keyof TeamRuntimeEvents>
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new team event emitter
 */
export function createEventEmitter(): TeamEventEmitter {
  return new TeamEventEmitter()
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract the payload type for a given event
 */
export type EventPayload<E extends keyof TeamRuntimeEvents> = TeamRuntimeEvents[E]

/**
 * Event emitter interface (for implementations)
 */
export interface ITeamEventEmitter {
  on<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe

  once<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: EventHandler<TeamRuntimeEvents[E]>
  ): Unsubscribe

  emit<E extends keyof TeamRuntimeEvents>(
    event: E,
    data: TeamRuntimeEvents[E]
  ): void

  off<E extends keyof TeamRuntimeEvents>(event: E): void

  offAll(): void
}
