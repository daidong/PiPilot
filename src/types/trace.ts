/**
 * Trace Types - 追踪类型定义
 */

/**
 * 框架事件类型
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
 * Trace 事件类型
 */
export type TraceEventType =
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
 * Replay 选项
 */
export interface ReplayOptions {
  /** 事件处理器 */
  onEvent?: (event: TraceEvent) => Promise<void>
  /** Mock 工具 */
  mockTools?: Record<string, (input: unknown) => Promise<unknown>>
  /** 播放速度倍数 */
  speed?: number
}
