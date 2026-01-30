/**
 * Agent Types - Agent 类型定义
 */

import type { Pack } from './pack.js'
import type { Policy } from './policy.js'
import type { TraceEvent } from './trace.js'
import type { ContextSelection } from './context-pipeline.js'
import type { Runtime } from './runtime.js'

/**
 * 模型配置
 */
export interface ModelConfig {
  /** 默认模型 */
  default: string
  /** 备用模型 */
  fallback?: string
  /** 最大 token 数 */
  maxTokens?: number
}

/**
 * Agent 定义
 */
export interface AgentDefinition {
  /** Agent ID */
  id: string
  /** Agent 名称 */
  name: string
  /** 核心人设（永不裁剪） */
  identity: string
  /** 使用的 Packs */
  packs: Pack[]
  /** 额外的策略 */
  policies?: Policy[]
  /** 约束规则（永不裁剪） */
  constraints: string[]
  /** 上下文使用指南 */
  contextGuide?: string
  /** 模型配置 */
  model?: ModelConfig
  /** 最大步骤数 */
  maxSteps?: number
}

/**
 * LLM 提供商类型
 */
export type LLMProvider = 'openai' | 'anthropic'

/**
 * Agent 配置（用于 createAgent）
 */
export interface AgentConfig {
  /** API 密钥 */
  apiKey?: string
  /** LLM 提供商 */
  provider?: LLMProvider
  /** 模型名称 */
  model?: string
  /** 工作目录 */
  projectPath?: string
  /** 使用的 Packs */
  packs?: Pack[]
  /** 额外的策略 */
  policies?: Policy[]
  /** 最大步骤数 */
  maxSteps?: number
  /** 最大 token 数 */
  maxTokens?: number
  /** Reasoning effort for reasoning models (low, medium, high) */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 审批处理器 */
  onApprovalRequired?: (message: string, timeout?: number) => Promise<boolean>
  /** 流式输出处理器 */
  onStream?: (chunk: string) => void
  /** 工具调用处理器 */
  onToolCall?: (tool: string, input: unknown) => void
  /** 工具结果处理器 */
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void
  /** Persistent session ID (reuse across restarts for history continuity) */
  sessionId?: string
}

/**
 * Agent 运行结果
 */
export interface AgentRunResult {
  /** 是否成功 */
  success: boolean
  /** 最终输出 */
  output: string
  /** 错误信息 */
  error?: string
  /** 执行步骤数 */
  steps: number
  /** Trace 事件 */
  trace: TraceEvent[]
  /** 总耗时（毫秒） */
  durationMs: number
}

/**
 * Options for agent.run()
 */
export interface AgentRunOptions {
  /** User-selected context to include */
  selectedContext?: ContextSelection[]
  /** Override token budget for this run */
  tokenBudget?: number
}

/**
 * Agent 实例
 */
export interface Agent {
  /** Agent ID */
  id: string
  /** Runtime instance (for advanced use: memory sync, session state, etc.) */
  runtime: Runtime
  /** Ensure packs are initialized (idempotent, called automatically by run()) */
  ensureInit: () => Promise<void>
  /** 运行 Agent */
  run: (prompt: string, options?: AgentRunOptions) => Promise<AgentRunResult>
  /** 停止运行 */
  stop: () => void
  /** 销毁 Agent */
  destroy: () => Promise<void>
}

/**
 * 会话状态
 */
export interface SessionState {
  /** 获取状态值 */
  get: <T>(key: string) => T | undefined
  /** 设置状态值 */
  set: <T>(key: string, value: T) => void
  /** 删除状态值 */
  delete: (key: string) => void
  /** 检查是否存在 */
  has: (key: string) => boolean
}
