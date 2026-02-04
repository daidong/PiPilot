/**
 * LLM - 统一 LLM 抽象层
 *
 * 基于 Vercel AI SDK 的统一 LLM 接口
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // Provider 类型
  ProviderID,
  ModelAPI,
  ModelCapabilities,
  ModelCost,
  ModelLimit,
  ModelConfig,
  ProviderSDKConfig,
  ProviderOptions,

  // 消息类型
  MessageRole,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ContentBlock,
  Message,

  // 流式事件类型
  StreamEventType,
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  StepStartEvent,
  StepFinishEvent,
  FinishEvent,
  ErrorEvent,

  // 请求/响应类型
  TokenUsage,
  DetailedTokenUsage,
  TokenCost,
  UsageSummary,
  LLMToolDefinition,
  StreamOptions,
  GenerateOptions,
  CompletionResponse
} from './provider.types.js'

// ============================================================================
// 模型注册表
// ============================================================================

export {
  builtinModels,
  modelRegistry,
  getModel,
  getAllModels,
  registerModel
} from './models.js'

// ============================================================================
// Provider 管理
// ============================================================================

export {
  getLanguageModel,
  getLanguageModelByModelId,
  clearSDKCache,
  getSDKCacheSize,
  getProviderInfo,
  getAllProviders,
  detectProviderFromApiKey,
  validateModelProvider,
  getModelDefaults,
  supportsTools,
  supportsReasoning,
  supportsVision,
  type ProviderInfo
} from './provider.js'

// ============================================================================
// 流式 API
// ============================================================================

export {
  createLLMClient,
  createLLMClientFromModelId,
  streamWithCallbacks,
  type LLMClientConfig,
  type StreamCallbacks
} from './stream.js'

// ============================================================================
// Structured Output
// ============================================================================

export {
  generateStructured,
  defaultRepairStrategy,
  createConsoleTracer,
  combineTracers,
  StructuredOutputError,
  NoObjectGeneratedError,
  type GenerateStructuredOptions,
  type GenerateStructuredResult,
  type StructuredTraceEvent,
  type RepairStrategy
} from './structured.js'

// ============================================================================
// Schema Utilities
// ============================================================================

export {
  // Bounded array helper
  boundedArray,
  // Schema analysis
  analyzeSchema,
  assertSchemaCompatible,
  warnSchemaIssues,
  // Compatibility helpers
  nullable,
  withDefault,
  stringEnum,
  // Search metadata schemas
  SearchMetadataSchema,
  SourceStatsSchema,
  SourceQueryResultSchema,
  createEmptySearchMetadata,
  buildSearchMetadata,
  // Types
  type SchemaIssue,
  type SchemaAnalysisResult,
  type SearchMetadata,
  type SourceStats,
  type SourceQueryResult
} from './schema-utils.js'

// ============================================================================
// Cost Calculator
// ============================================================================

export {
  calculateCost,
  aggregateCosts,
  aggregateUsage,
  calculateCacheHitRate,
  formatCost,
  formatTokens
} from './cost-calculator.js'
