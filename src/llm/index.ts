/**
 * LLM - Unified LLM abstraction layer
 *
 * Unified LLM interface based on Vercel AI SDK
 */

// ============================================================================
// Type exports
// ============================================================================

export type {
  // Provider types
  ProviderID,
  ModelAPI,
  ModelCapabilities,
  ModelCost,
  ModelLimit,
  ModelConfig,
  ProviderSDKConfig,
  ProviderOptions,

  // Message types
  MessageRole,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  ContentBlock,
  Message,

  // Stream event types
  StreamEventType,
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  StepStartEvent,
  StepFinishEvent,
  FinishEvent,
  ErrorEvent,

  // Request/response types
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
// Model registry
// ============================================================================

export {
  builtinModels,
  modelRegistry,
  getModel,
  getAllModels,
  registerModel
} from './models.js'

// ============================================================================
// Provider management
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
// Streaming API
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
// Compat & Provider Definitions
// ============================================================================

export type {
  ApiProtocol,
  OpenAICompat,
  ResolvedCompat
} from './compat.js'

export {
  resolveCompat
} from './compat.js'

export type {
  ModelDefinition,
  ProviderDefinition
} from './provider-definitions.js'

export {
  BUILTIN_PROVIDERS,
  registerProvider,
  getProviderDefinition,
  getAllProviderDefinitions,
  findProviderForModel,
  findModelDefinition
} from './provider-definitions.js'

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
