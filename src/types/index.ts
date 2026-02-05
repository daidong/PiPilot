/**
 * Types - 导出所有类型定义
 */

// Tool types
export type {
  ParameterDefinition,
  ParameterSchema,
  ToolContext,
  Attachment,
  ToolResult,
  Tool,
  ToolConfig,
  BuiltinToolName,
  ActivitySummary,
  ToolActivityFormat
} from './tool.js'

// Policy types
export type {
  PolicyContext,
  Transform,
  GuardDecision,
  MutateDecision,
  ObserveDecision,
  PolicyDecision,
  PolicyPhase,
  Policy,
  PolicyConfig,
  BeforeResult,
  ApprovalHandler,
  AlertHandler
} from './policy.js'

// Context types
export type {
  Provenance,
  Coverage,
  ContextResult,
  CacheConfig,
  RenderConfig,
  CostTier,
  ContextSource,
  ContextSourceConfig,
  BuiltinContextSourceId
} from './context.js'

// Pack types
export type {
  Pack,
  PackConfig,
  BuiltinPackName
} from './pack.js'

// Provider types
export type {
  ProviderPermissions,
  ProviderBudgets,
  ProviderPackDescriptor,
  ToolProviderManifest,
  ProviderCreateOptions,
  ToolProvider,
  ToolProviderConfig
} from './provider.js'

// Agent types
export type {
  ModelConfig,
  AgentDefinition,
  LLMProvider,
  AgentConfig,
  AgentRunOptions,
  AgentRunResult,
  Agent,
  SessionState
} from './agent.js'

// Runtime types
export type {
  IOResult,
  ReadOptions,
  DirEntry,
  ReaddirOptions,
  ExecOptions,
  ExecOutput,
  GlobOptions,
  GrepOptions,
  GrepMatch,
  RuntimeIO,
  Runtime,
  RuntimeConfig,
  LLMClient
} from './runtime.js'

// Trace types
export type {
  FrameworkEvent,
  TraceEventType,
  TraceEvent,
  TraceFilter,
  ReplayOptions,
  EventCorrelation
} from './trace.js'

// Memory types
export type {
  MemorySensitivity,
  MemoryStatus,
  MemoryNamespace,
  MemoryProvenance,
  MemoryItem,
  MemoryData,
  MemoryIndex,
  MemoryHistoryEntry,
  MemoryPutOptions,
  MemoryUpdateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryListOptions,
  MemoryStorage
} from './memory.js'

export {
  MEMORY_KEY_PATTERN,
  MEMORY_MAX_VALUE_SIZE,
  isValidMemoryKey,
  buildFullKey,
  parseFullKey
} from './memory.js'

// Session types
export type {
  MessageRole,
  MessageToolCall,
  Message,
  SessionMeta,
  SessionsIndex,
  MessageStore,
  SessionIndex,
  SessionSearchOptions,
  SessionSearchResult
} from './session.js'

export {
  generateMessageId,
  generateSessionId
} from './session.js'

// Todo types
export type {
  TodoStatus,
  TodoPriority,
  TodoItem
} from './todo.js'

// Context Pipeline types
export type {
  PhaseBudgetType,
  PhaseBudget,
  ContextFragment,
  ContextSelectionType,
  ContextSelection,
  HistorySegment,
  CompressedHistory,
  HistoryCompressor,
  AssemblyContext,
  ContextPhase,
  PhaseResult,
  AssembledContext,
  CompressionConfig,
  PhaseConfig,
  PipelineConfig,
  ContextPipeline,
  RuntimeWithCompressor
} from './context-pipeline.js'

// Memory Entity types (RFC-009)
export type {
  EntityProvenance,
  EntityLink,
  SummaryCardMethod,
  SummaryCardConfig,
  MemoryEntityType,
  MemoryEntity,
  CreateEntityOptions,
  UpdateEntityOptions,
  WorkingSetSource,
  EntityShape,
  WorkingSetItem,
  WorkingSetPlan,
  EntityIndex,
  WorkingSetResolvedEntity,
  LegacyEntityFields
} from './memory-entity.js'

export {
  DEFAULT_SUMMARY_CARD_CONFIG,
  MAX_SUMMARY_CARD_TOKENS,
  hasLegacyFields,
  migrateLegacyFields,
  isValidSummaryCard,
  isValidEntityType
} from './memory-entity.js'
