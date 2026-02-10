/**
 * Provider Types - LLM Provider type definitions
 *
 * Unified abstraction layer types based on Vercel AI SDK
 */

/**
 * Supported Provider IDs
 */
export type ProviderID = 'openai' | 'anthropic' | 'google' | 'deepseek'

/**
 * Model API type
 */
export type ModelAPI = 'chat' | 'completion'

/**
 * Model capabilities definition
 */
export interface ModelCapabilities {
  /** Whether temperature adjustment is supported */
  temperature: boolean
  /** Whether reasoning mode (thinking/reasoning) is supported */
  reasoning: boolean
  /** Whether tool calling is supported */
  toolcall: boolean
  /** Supported input types */
  input: ('text' | 'image')[]
  /** Supported output types */
  output: ('text')[]
}

/**
 * Model cost definition (per million tokens)
 */
export interface ModelCost {
  /** Input token cost (USD per million tokens) */
  input: number
  /** Cached input token cost (USD per million tokens, optional) */
  cachedInput?: number
  /** Output token cost (USD per million tokens) */
  output: number
}

/**
 * Model limits
 */
export interface ModelLimit {
  /** Maximum context length */
  maxContext: number
  /** Maximum output length */
  maxOutput: number
}

/**
 * Model definition
 */
export interface ModelConfig {
  /** Unique model identifier */
  id: string
  /** Display name */
  name: string
  /** Provider ID */
  providerID: ProviderID
  /** API type */
  api: ModelAPI
  /** Model capabilities */
  capabilities: ModelCapabilities
  /** Cost information */
  cost?: ModelCost
  /** Model limits */
  limit: ModelLimit
}

/**
 * Provider SDK configuration
 */
export interface ProviderSDKConfig {
  /** API key (falls back to provider-specific env var if not set) */
  apiKey?: string
  /** Base URL (optional) */
  baseURL?: string
}

/**
 * Provider options
 */
export interface ProviderOptions {
  /** Provider ID */
  provider: ProviderID
  /** Model ID */
  model: string
  /** SDK configuration */
  config: ProviderSDKConfig
}

/**
 * Message role
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * Text content block
 */
export interface TextContent {
  type: 'text'
  text: string
}

/**
 * Tool call content block
 */
export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/**
 * Tool result content block
 */
export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

/**
 * Content block type
 */
export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

/**
 * Message
 */
export interface Message {
  role: MessageRole
  content: string | ContentBlock[]
}

/**
 * Stream event type
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
 * Stream event
 */
export interface StreamEvent {
  type: StreamEventType
  data: unknown
}

/**
 * Text delta event
 */
export interface TextDeltaEvent extends StreamEvent {
  type: 'text-delta'
  data: {
    text: string
  }
}

/**
 * Tool call event
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
 * Tool result event
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
 * Step start event
 */
export interface StepStartEvent extends StreamEvent {
  type: 'step-start'
  data: {
    stepIndex: number
  }
}

/**
 * Step finish event
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
 * Finish event
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
 * Error event
 */
export interface ErrorEvent extends StreamEvent {
  type: 'error'
  data: {
    error: Error
  }
}

/**
 * Token usage
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
 * LLM tool definition (Vercel AI SDK format)
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
 * Stream request options
 */
export interface StreamOptions {
  /** System prompt */
  system?: string
  /** Message history */
  messages: Message[]
  /** Available tools */
  tools?: LLMToolDefinition[]
  /** Maximum number of tokens */
  maxTokens?: number
  /** Temperature (0-1) */
  temperature?: number
  /** Stop sequences */
  stopSequences?: string[]
  /** Whether to enable reasoning mode */
  reasoning?: boolean
  /** Reasoning effort for reasoning models (low, medium, high, max). Default: medium */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
}

/**
 * Generate request options
 */
export interface GenerateOptions extends StreamOptions {
  /** Whether to include tool results */
  includeToolResults?: boolean
}

/**
 * Completion response
 */
export interface CompletionResponse {
  /** Response ID */
  id: string
  /** Generated text */
  text: string
  /** Tool calls */
  toolCalls: ToolUseContent[]
  /** Finish reason */
  finishReason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error'
  /** Token usage (with cache info when available) */
  usage: DetailedTokenUsage
}
