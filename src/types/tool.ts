/**
 * Tool Types - 工具轴类型定义
 * Tools 定义 Agent 能执行的操作
 */

import type { Runtime } from './runtime.js'

/**
 * 参数类型定义
 */
export interface ParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  required?: boolean
  default?: unknown
  enum?: unknown[]
  items?: ParameterDefinition
  properties?: Record<string, ParameterDefinition>
}

export type ParameterSchema = Record<string, ParameterDefinition>

/**
 * 工具执行上下文
 */
export interface ToolContext {
  /** Runtime instance */
  runtime: Runtime
  /** Session ID */
  sessionId: string
  /** Current step number */
  step: number
  /** Agent ID */
  agentId: string
  /** Current conversation messages (optional, for tools that need conversation context) */
  messages?: unknown[]
}

/**
 * 附件类型
 */
export interface Attachment {
  type: 'image' | 'file' | 'code'
  name: string
  content: string | Buffer
  mimeType?: string
}

/**
 * 工具执行结果
 */
export interface ToolResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  attachments?: Attachment[]
}

/**
 * 工具定义
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** 工具名称（唯一标识） */
  name: string

  /** 工具描述（给 LLM 看的） */
  description: string

  /** 参数定义 */
  parameters: ParameterSchema

  /** 执行函数 */
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>

  /** Optional activity label formatters for UI display */
  activity?: ToolActivityFormat
}

/**
 * 工具配置（用于 defineTool）
 */
export interface ToolConfig<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  parameters: ParameterSchema
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>
  /** Optional activity label formatters for UI display */
  activity?: ToolActivityFormat
}

/**
 * 内置工具名称
 */
export type BuiltinToolName =
  // 安全核心
  | 'ctx-get'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  // 执行能力
  | 'bash'
  // 网络能力
  | 'fetch'
  // 计算能力
  | 'llm-call'
  | 'llm-expand'
  | 'llm-filter'

/**
 * Activity summary for UI display when a tool is called or returns
 */
export interface ActivitySummary {
  label: string
  icon?: 'search' | 'file' | 'network' | 'memory' | 'task' | 'run' | 'edit' | 'default'
}

/**
 * Optional activity label formatters for UI display
 */
export interface ToolActivityFormat {
  /** Format a human-readable label when the tool is called */
  formatCall?: (args: Record<string, unknown>) => ActivitySummary
  /** Format a human-readable label when the tool returns */
  formatResult?: (result: Record<string, unknown>, args?: Record<string, unknown>) => ActivitySummary
}

/**
 * 工具风险等级
 */
export type ToolRiskLevel = 'safe' | 'elevated' | 'high'

/**
 * 工具类别
 */
export type ToolCategory = 'safe' | 'exec' | 'network' | 'compute'
