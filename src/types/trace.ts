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

/**
 * Trace 事件
 */
export interface TraceEvent {
  /** 事件 ID */
  id: string
  /** 事件类型 */
  type: TraceEventType
  /** 时间戳 */
  timestamp: number
  /** 会话 ID */
  sessionId: string
  /** 步骤号 */
  step: number
  /** 事件数据 */
  data: Record<string, unknown>
  /** 父事件 ID */
  parentId?: string
  /** 持续时间（毫秒） */
  durationMs?: number
}

/**
 * Trace 过滤器
 */
export interface TraceFilter {
  type?: TraceEventType | TraceEventType[]
  minTimestamp?: number
  maxTimestamp?: number
  step?: number
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
