/**
 * Provider Types - LLM Provider 类型定义
 *
 * 基于 Vercel AI SDK 的统一抽象层类型
 */

/**
 * 支持的 Provider ID
 */
export type ProviderID = 'openai' | 'anthropic' | 'google' | 'deepseek'

/**
 * 模型 API 类型
 */
export type ModelAPI = 'chat' | 'completion'

/**
 * 模型能力定义
 */
export interface ModelCapabilities {
  /** 是否支持温度调节 */
  temperature: boolean
  /** 是否支持推理模式 (thinking/reasoning) */
  reasoning: boolean
  /** 是否支持工具调用 */
  toolcall: boolean
  /** 支持的输入类型 */
  input: ('text' | 'image')[]
  /** 支持的输出类型 */
  output: ('text')[]
}

/**
 * 模型成本定义 (每百万 token)
 */
export interface ModelCost {
  /** 输入 token 成本 (美元/百万 token) */
  input: number
  /** 缓存命中输入 token 成本 (美元/百万 token，可选) */
  cachedInput?: number
  /** 输出 token 成本 (美元/百万 token) */
  output: number
}

/**
 * 模型限制
 */
export interface ModelLimit {
  /** 最大上下文长度 */
  maxContext: number
  /** 最大输出长度 */
  maxOutput: number
}

/**
 * 模型定义
 */
export interface ModelConfig {
  /** 模型唯一标识符 */
  id: string
  /** 显示名称 */
  name: string
  /** Provider ID */
  providerID: ProviderID
  /** API 类型 */
  api: ModelAPI
  /** 模型能力 */
  capabilities: ModelCapabilities
  /** 成本信息 */
  cost?: ModelCost
  /** 模型限制 */
  limit: ModelLimit
}

/**
 * Provider SDK 配置
 */
export interface ProviderSDKConfig {
  /** API 密钥 */
  apiKey: string
  /** 基础 URL (可选) */
  baseURL?: string
}

/**
 * Provider 选项
 */
export interface ProviderOptions {
  /** Provider ID */
  provider: ProviderID
  /** 模型 ID */
  model: string
  /** SDK 配置 */
  config: ProviderSDKConfig
}

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * 文本内容块
 */
export interface TextContent {
  type: 'text'
  text: string
}

/**
 * 工具调用内容块
 */
export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/**
 * 工具结果内容块
 */
export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

/**
 * 内容块类型
 */
export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

/**
 * 消息
 */
export interface Message {
  role: MessageRole
  content: string | ContentBlock[]
}

/**
 * 流式事件类型
 */
export type StreamEventType =
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'step-start'
  | 'step-finish'
  | 'finish'
  | 'error'

/**
 * 流式事件
 */
export interface StreamEvent {
  type: StreamEventType
  data: unknown
}

/**
 * 文本增量事件
 */
export interface TextDeltaEvent extends StreamEvent {
  type: 'text-delta'
  data: {
    text: string
  }
}

/**
 * 工具调用事件
 */
export interface ToolCallEvent extends StreamEvent {
  type: 'tool-call'
  data: {
    toolCallId: string
    toolName: string
    args: unknown
  }
}

/**
 * 工具结果事件
 */
export interface ToolResultEvent extends StreamEvent {
  type: 'tool-result'
  data: {
    toolCallId: string
    result: string
    isError?: boolean
  }
}

/**
 * 步骤开始事件
 */
export interface StepStartEvent extends StreamEvent {
  type: 'step-start'
  data: {
    stepIndex: number
  }
}

/**
 * 步骤完成事件
 */
export interface StepFinishEvent extends StreamEvent {
  type: 'step-finish'
  data: {
    stepIndex: number
    finishReason: string
    usage: DetailedTokenUsage
  }
}

/**
 * 完成事件
 */
export interface FinishEvent extends StreamEvent {
  type: 'finish'
  data: {
    finishReason: string
    usage: DetailedTokenUsage
    text: string
    toolCalls: ToolUseContent[]
  }
}

/**
 * 错误事件
 */
export interface ErrorEvent extends StreamEvent {
  type: 'error'
  data: {
    error: Error
  }
}

/**
 * Token 使用情况
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Detailed token usage including cache information
 */
export interface DetailedTokenUsage extends TokenUsage {
  /** Tokens written to cache (cache creation) */
  cacheCreationInputTokens?: number
  /** Tokens read from cache (discounted) */
  cacheReadInputTokens?: number
  /** Reasoning/thinking tokens (for reasoning models) */
  reasoningTokens?: number
}

/**
 * Cost breakdown for token usage
 */
export interface TokenCost {
  /** Cost for prompt tokens (USD) */
  promptCost: number
  /** Cost for completion tokens (USD) */
  completionCost: number
  /** Cost for cached read tokens (discounted) */
  cachedReadCost: number
  /** Cost for cache creation tokens */
  cacheCreationCost: number
  /** Total cost (USD) */
  totalCost: number
  /** Model ID used for calculation */
  modelId: string
}

/**
 * Aggregated usage summary for a run
 */
export interface UsageSummary {
  /** Detailed token usage */
  tokens: DetailedTokenUsage
  /** Cost breakdown */
  cost: TokenCost
  /** Number of LLM calls */
  callCount: number
  /** Cache hit rate (0-1) */
  cacheHitRate: number
  /** Run duration in milliseconds */
  durationMs: number
}

/**
 * LLM 工具定义 (Vercel AI SDK 格式)
 */
export interface LLMToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/**
 * 流式请求选项
 */
export interface StreamOptions {
  /** 系统提示 */
  system?: string
  /** 消息历史 */
  messages: Message[]
  /** 可用工具 */
  tools?: LLMToolDefinition[]
  /** 最大 token 数 */
  maxTokens?: number
  /** 温度 (0-1) */
  temperature?: number
  /** 停止序列 */
  stopSequences?: string[]
  /** 是否启用推理模式 */
  reasoning?: boolean
  /** Reasoning effort for reasoning models (low, medium, high). Default: medium */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/**
 * 生成请求选项
 */
export interface GenerateOptions extends StreamOptions {
  /** 是否包含工具结果 */
  includeToolResults?: boolean
}

/**
 * 完成响应
 */
export interface CompletionResponse {
  /** 响应 ID */
  id: string
  /** 生成的文本 */
  text: string
  /** 工具调用 */
  toolCalls: ToolUseContent[]
  /** 完成原因 */
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error'
  /** Token 使用情况 (with cache info when available) */
  usage: DetailedTokenUsage
}
