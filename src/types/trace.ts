/**
 * Trace Types - Tracing type definitions
 */

/**
 * Framework event type
 */
export type FrameworkEvent =
  | 'file:read'
  | 'file:write'
  | 'file:delete'
  | 'file:create'
  | 'tool:call'
  | 'tool:complete'
  | 'tool:error'
  | 'session:start'
  | 'session:end'
  | 'policy:deny'
  | 'policy:approval_requested'

/**
 * Trace event type
 */
export type TraceEventType =
  | 'agent.run'
  | 'agent.start'
  | 'agent.step'
  | 'agent.complete'
  | 'tool.call'
  | 'tool.result'
  | 'tool.validation_error'
  | 'io.readFile'
  | 'io.writeFile'
  | 'io.readdir'
  | 'io.exec'
  | 'io.grep'
  | 'io.glob'
  | 'policy.guard'
  | 'policy.mutate'
  | 'policy.observe'
  | 'ctx.cache_hit'
  | 'ctx.fetch_start'
  | 'ctx.fetch_complete'
  | 'prompt.compiled'
  | 'llm.request'
  | 'llm.response'
  | 'budget.degradation'
  | 'budget.retry'
  | 'budget.profile'
  | 'agent.toolLoopNudge'
  | 'agent.toolLoopHardStop'
  | 'error.budget_summary'
  | 'error.classified'
  | 'error.retrying'
  | 'error.recovered'
  | 'error.exhausted'
  | 'usage.call'
  | 'usage.step'
  | 'usage.run'
  | 'usage.warning'

/**
 * Event correlation context for tracing
 */
export interface EventCorrelation {
  /** Unique ID for this execution run */
  runId: string
  /** Current step number within the run */
  stepId: number
  /** Agent ID that generated this event */
  agentId: string
  /** Session ID for multi-turn conversations */
  sessionId: string
}

/**
 * Trace event
 */
export interface TraceEvent {
  /** Event ID */
  id: string
  /** Event type */
  type: TraceEventType
  /** Timestamp */
  timestamp: number
  /** Session ID */
  sessionId: string
  /** Step number */
  step: number
  /** Event data */
  data: Record<string, unknown>
  /** Parent event ID */
  parentId?: string
  /** Duration in milliseconds */
  durationMs?: number
  /** Run ID for correlation */
  runId?: string
  /** Agent ID for correlation */
  agentId?: string
}

/**
 * Trace filter
 */
export interface TraceFilter {
  type?: TraceEventType | TraceEventType[]
  minTimestamp?: number
  maxTimestamp?: number
  step?: number
  runId?: string
  agentId?: string
}

/**
 * Replay options
 */
export interface ReplayOptions {
  /** Event handler */
  onEvent?: (event: TraceEvent) => Promise<void>
  /** Mock tools */
  mockTools?: Record<string, (input: unknown) => Promise<unknown>>
  /** Playback speed multiplier */
  speed?: number
}
