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
export interface TeamStartedEvent {
  /** Team ID */
  teamId: string
  /** Run ID for correlation */
  runId: string
  /** Input provided to the team */
  input: unknown
  /** Timestamp */
  ts: number
}

/**
 * Team completed event
 */
export interface TeamCompletedEvent {
  /** Team ID */
  teamId: string
  /** Run ID for correlation */
  runId: string
  /** Final output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
  /** Total steps executed */
  steps: number
  /** Timestamp */
  ts: number
}

/**
 * Team failed event
 */
export interface TeamFailedEvent {
  /** Team ID */
  teamId: string
  /** Run ID for correlation */
  runId: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
  /** Timestamp */
  ts: number
}

/**
 * Agent started event
 */
export interface AgentStartedEvent {
  /** Agent ID */
  agentId: string
  /** Run ID for correlation */
  runId: string
  /** Input provided to the agent */
  input: unknown
  /** Step number */
  step: number
  /** Timestamp */
  ts: number
}

/**
 * Agent completed event
 */
export interface AgentCompletedEvent {
  /** Agent ID */
  agentId: string
  /** Run ID for correlation */
  runId: string
  /** Agent output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
  /** Token usage (if available) */
  tokens?: TokenUsage
  /** Step number */
  step: number
  /** Timestamp */
  ts: number
}

/**
 * Agent failed event
 */
export interface AgentFailedEvent {
  /** Agent ID */
  agentId: string
  /** Run ID for correlation */
  runId: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
  /** Step number */
  step: number
  /** Timestamp */
  ts: number
}

/**
 * Flow step started event
 */
export interface StepStartedEvent {
  /** Step ID */
  stepId: string
  /** Step kind (invoke, seq, par, etc.) */
  kind: string
  /** Run ID for correlation */
  runId: string
  /** Optional step name */
  name?: string
  /** Timestamp */
  ts: number
}

/**
 * Flow step completed event
 */
export interface StepCompletedEvent {
  /** Step ID */
  stepId: string
  /** Step kind */
  kind: string
  /** Run ID for correlation */
  runId: string
  /** Step output */
  output: unknown
  /** Duration in milliseconds */
  durationMs: number
  /** Timestamp */
  ts: number
}

/**
 * Flow step failed event
 */
export interface StepFailedEvent {
  /** Step ID */
  stepId: string
  /** Step kind */
  kind: string
  /** Run ID for correlation */
  runId: string
  /** Error that caused failure */
  error: Error
  /** Duration before failure */
  durationMs: number
  /** Timestamp */
  ts: number
}

/**
 * Loop iteration event
 */
export interface LoopIterationEvent {
  /** Loop ID */
  loopId: string
  /** Run ID for correlation */
  runId: string
  /** Current iteration (1-based) */
  iteration: number
  /** Maximum iterations allowed */
  maxIterations: number
  /** Whether loop will continue */
  continuing: boolean
  /** Timestamp */
  ts: number
}

/**
 * Loop completed event
 */
export interface LoopCompletedEvent {
  /** Loop ID */
  loopId: string
  /** Run ID for correlation */
  runId: string
  /** Total iterations executed */
  totalIterations: number
  /** Reason for stopping */
  reason: 'condition-met' | 'max-iterations' | 'error'
  /** Timestamp */
  ts: number
}

/**
 * State updated event
 */
export interface StateUpdatedEvent {
  /** Path that was updated */
  path: string
  /** New value */
  value: unknown
  /** Previous value (if available) */
  previousValue?: unknown
  /** Run ID for correlation */
  runId: string
  /** Agent that made the update */
  updatedBy?: string
  /** Timestamp */
  ts: number
}

/**
 * Branch decision event
 */
export interface BranchDecisionEvent {
  /** Branch step ID */
  branchId: string
  /** Run ID for correlation */
  runId: string
  /** Which branch was taken */
  taken: 'then' | 'else'
  /** Timestamp */
  ts: number
}

/**
 * Select decision event
 */
export interface SelectDecisionEvent {
  /** Select step ID */
  selectId: string
  /** Run ID for correlation */
  runId: string
  /** Branch key that was selected */
  selected: string
  /** Whether default branch was used */
  usedDefault: boolean
  /** Timestamp */
  ts: number
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
