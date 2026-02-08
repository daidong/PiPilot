/**
 * Agent Foundry - Agent Framework v2
 *
 * Three-axis orthogonal architecture:
 * - Tools (Tool axis): Operations agents can execute
 * - Policies (Policy axis): Determine whether operations are allowed
 * - Context Sources (Context axis): Provide necessary information for agents
 */

// ============================================================================
// Constants
// ============================================================================

export { FRAMEWORK_DIR } from './constants.js'

// ============================================================================
// Type exports
// ============================================================================

export type {
  // Tool related types
  Tool,
  ToolContext,
  ToolResult,
  ParameterSchema,
  ParameterDefinition,
  ActivitySummary,
  ToolActivityFormat,

  // Policy related types
  Policy,
  PolicyContext,
  Transform,
  GuardDecision,
  MutateDecision,
  ObserveDecision,
  PolicyDecision,
  BeforeResult,
  ApprovalHandler,
  AlertHandler,

  // Context related types
  ContextSource,
  ContextResult,
  Provenance,
  Coverage,

  // Pack related types
  Pack,

  // Provider related types
  ProviderPermissions,
  ProviderBudgets,
  ProviderPackDescriptor,
  ToolProviderManifest,
  ProviderCreateOptions,
  ToolProvider,
  ToolProviderConfig,

  // Agent related types
  AgentDefinition,
  AgentConfig,
  AgentRunOptions,
  Agent,
  AgentRunResult,
  SessionState,

  // Runtime related types
  Runtime,
  RuntimeIO as RuntimeIOType,
  IOResult,

  // Trace types
  TraceEvent,
  TraceEventType,
  FrameworkEvent,
  EventCorrelation
} from './types/index.js'

// ============================================================================
// Factory function exports
// ============================================================================

export {
  // Define tools
  defineTool,
  withErrorHandling,
  withTimeout,
  withRetry
} from './factories/define-tool.js'

export {
  // Define Provider
  defineProvider
} from './factories/define-provider.js'

export {
  // Define policies
  definePolicy,
  defineGuardPolicy,
  defineDenyPolicy,
  defineMutatePolicy,
  defineObservePolicy
} from './factories/define-policy.js'

export {
  // Define context sources
  defineContextSource
} from './factories/define-context-source.js'

export {
  // Define Pack
  definePack,
  mergePacks,
  extendPack,
  filterPack
} from './factories/define-pack.js'

// ============================================================================
// Skills exports
// ============================================================================

export {
  // Factory functions
  defineSkill,
  extendSkill,
  mergeSkills,

  // Core classes
  SkillManager,
  ExternalSkillLoader,
  SkillRegistry,
  globalSkillRegistry,

  // External SKILL.md helpers
  parseExternalSkill,
  renderExternalSkillMarkdown,
  updateFrontmatter,

  // Built-in skills
  llmComputeSkill,
  gitWorkflowSkill,
  contextRetrievalSkill,
  resourcefulPhilosophySkill,
  builtinSkills,
  skillsById,
  getBuiltinSkill
} from './skills/index.js'

export type {
  // Skill types (also exported from types/index.ts)
  // Phase 3.1: SkillScripts removed (dead code)
  Skill,
  SkillConfig,
  SkillInstructions,
  SkillTokenEstimates,
  SkillLoadingStrategy,
  SkillLoadingConfig,
  SkillState,
  LoadedSkillContent,
  SkillManagerEvents,
  SkillTelemetryConfig,
  SkillTelemetryMode,
  SkillTelemetrySink,
  SkillRegistrationOptions,
  SkillTokenSavings,

  // Manager types
  SkillManagerOptions,
  ExternalSkillLoaderOptions,
  LoadedExternalSkill,
  ExternalSkillFrontmatter,
  ParsedExternalSkill,
  SkillQuery,
  SkillMatch
} from './skills/index.js'

// ============================================================================
// Agent exports
// ============================================================================

export { createAgent } from './agent/create-agent.js'
export type { CreateAgentOptions } from './agent/create-agent.js'
export { defineAgent, validateAgentDefinition } from './agent/define-agent.js'
export { AgentLoop } from './agent/agent-loop.js'

// Schema-free Agent (RFC-002) - Primary API
export {
  defineAgent as defineSimpleAgent,
  isAgent as isSchemaFreeAgent,
  createAgentContext as createSimpleAgentContext,
  createAgentContext,
  isAgent
} from './agent/define-simple-agent.js'
export type {
  // Primary exports (recommended)
  Agent as SchemaFreeAgent,
  AgentDefinition as SchemaFreeAgentDefinition,
  AgentContext as SchemaFreeAgentContext,
  AgentResult as SchemaFreeAgentResult,
  AgentTraceEvent as SchemaFreeAgentTraceEvent,
  // Legacy aliases (deprecated)
  SimpleAgentDefinition,
  SimpleAgent,
  SimpleAgentContext,
  SimpleAgentResult,
  SimpleAgentTraceEvent
} from './agent/define-simple-agent.js'

// ============================================================================
// Core component exports
// ============================================================================

// Error Feedback & Retry (RFC-005)
export {
  classifyError,
  createValidationError,
  createPythonError,
  sanitizeErrorContent,
  sanitizeDetails,
  parsePythonTraceback,
  inferSource,
  getSourceKind
} from './core/errors.js'
export type {
  ErrorCategory,
  ErrorSource,
  ErrorSourceKind,
  Recoverability,
  AgentError,
  ClassifyErrorContext
} from './core/errors.js'

export {
  buildFeedback,
  toolValidationFeedback,
  executionFailureFeedback,
  policyDenialFeedback,
  contextDropFeedback,
  formatFeedbackAsToolResult
} from './core/feedback.js'
export type {
  ErrorFeedback,
  ErrorFacts,
  FeedbackContext,
  FeedbackBuilder,
  ToolSchemaSummary
} from './core/feedback.js'

export {
  RetryBudget,
  DEFAULT_STRATEGIES,
  DEFAULT_BUDGET_CONFIG,
  getStrategy,
  withExecutorRetry,
  withRetry as withRetryExecutor,
  computeBackoff,
  defaultShouldRetry,
  RetryPresets
} from './core/retry.js'
export type {
  RetryMode,
  RetryStrategy,
  RetryBudgetConfig,
  BackoffStrategy,
  WithRetryOptions
} from './core/retry.js'

export { EventBus } from './core/event-bus.js'
export { TraceCollector } from './core/trace-collector.js'
export { TokenBudget } from './core/token-budget.js'
export { RuntimeIO } from './core/runtime-io.js'
export { ToolRegistry } from './core/tool-registry.js'
export { PolicyEngine } from './core/policy-engine.js'
export { ContextManager } from './core/context-manager.js'
export { PromptCompiler } from './core/prompt-compiler.js'
export { ProviderRegistry } from './core/provider-registry.js'
export { compressToolResult, enforceToolResultBudget, isAlreadyCompressed, TOOL_RESULT_CAPS, TOOL_RESULT_TOTAL_BUDGET_RATIO } from './core/tool-result-compressor.js'
export { ToolsetCompiler } from './core/toolset-compiler.js'
export {
  generateRuntimeSnapshot,
  createSnapshotData,
  renderSnapshot,
  validateSnapshot
} from './core/runtime-snapshot.js'
export {
  loadUsageTotals,
  updateUsageTotals,
  resetUsageTotals,
  getUsageTotalsPath,
  type UsageTotalsFile
} from './core/usage-totals.js'
// Token Tracking
export {
  TokenTracker,
  createTokenTracker
} from './core/token-tracker.js'
export type {
  TokenTrackerConfig,
  UsageEventType,
  UsageEvent,
  UsageEventHandler
} from './core/token-tracker.js'

// ============================================================================
// Utility exports
// ============================================================================

export { Cache } from './utils/cache.js'
export {
  SimpleTokenizer,
  countTokens,
  truncateToTokens,
  setCalibration,
  setModelFamily,
  getCalibration,
  configureForModel
} from './utils/tokenizer.js'
export { applyTransform, applyTransforms } from './utils/transform.js'

// ============================================================================
// Built-in tool exports
// ============================================================================

export {
  read,
  write,
  edit,
  bash,
  glob,
  grep,
  ctxGet,
  fetchTool,
  llmCall,
  llmExpand,
  llmFilter,
  skillCreateTool,
  skillApproveTool,
  builtinTools,
  safeTools,
  execTools,
  networkTools,
  computeTools,
  toolMeta,
  getToolsByRiskLevel,
  getToolsByCategory
} from './tools/index.js'

export type {
  FetchInput,
  FetchOutput,
  LLMCallInput,
  LLMCallOutput,
  LLMExpandInput,
  LLMExpandOutput,
  LLMFilterInput,
  LLMFilterOutput,
  SkillCreateInput,
  SkillCreateOutput,
  SkillApproveInput,
  SkillApproveOutput
} from './tools/index.js'

// ============================================================================
// Built-in policy exports
// ============================================================================

export {
  noDestructive,
  noSecretFiles,
  noSecretFilesRead,
  noSecretFilesWrite,
  autoLimitGrep,
  autoLimitGlob,
  autoLimitRead,
  autoLimitSql,
  normalizeReadPaths,
  normalizeWritePaths,
  normalizePathsPolicies,
  auditAllCalls,
  alertOnDenied,
  alertOnErrors,
  defaultSecurityPolicies,
  autoLimitPolicies,
  builtinPolicies
} from './policies/index.js'

// ============================================================================
// Built-in context source exports
// ============================================================================

export {
  sessionTrace,
  sessionContextSources,
  metaContextSources,
  memoryContextSources,
  docsContextSources,
  todoContextSources,
  builtinContextSources
} from './context-sources/index.js'

// ============================================================================
// Packs exports
// ============================================================================

export {
  // Layered core
  safe,
  safePack,
  exec,
  execPack,
  execStrict,
  execDev,
  network,
  networkPack,
  networkStrict,
  networkApi,
  networkGitHub,
  compute,
  computePack,
  computeEconomy,
  computeStandard,
  computePremium,
  computeWithApproval,
  getSessionTokenUsage,
  resetSessionTokenUsage,
  // Domain Packs
  git,
  exploration,
  python,
  todo,
  web,
  // Composite factories
  minimal,
  standard,
  full,
  strict,
  // Namespace
  packs,
  packMeta
} from './packs/index.js'

export type {
  ExecPackOptions,
  NetworkPackOptions,
  ComputePackOptions,
  WebPackOptions,
  PackRiskLevel,
  PackMeta
} from './packs/index.js'

// ============================================================================
// LLM exports (based on Vercel AI SDK)
// ============================================================================

// Type exports
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

  // Streaming event types
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
  CompletionResponse,

  // Provider info
  ProviderInfo,

  // Client types
  LLMClientConfig,
  StreamCallbacks
} from './llm/index.js'

// Model registry
export {
  builtinModels,
  modelRegistry,
  getModel,
  getAllModels,
  registerModel
} from './llm/index.js'

// Provider management
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
  supportsVision
} from './llm/index.js'

// Streaming API
export {
  createLLMClient,
  createLLMClientFromModelId,
  streamWithCallbacks
} from './llm/index.js'

// Cost Calculator
export {
  calculateCost,
  aggregateCosts,
  aggregateUsage,
  calculateCacheHitRate,
  formatCost,
  formatTokens
} from './llm/index.js'

// Structured Output (contract-first LLM calls)
export {
  generateStructured,
  defaultRepairStrategy,
  createConsoleTracer,
  combineTracers,
  StructuredOutputError,
  NoObjectGeneratedError
} from './llm/index.js'
export type {
  GenerateStructuredOptions,
  GenerateStructuredResult,
  StructuredTraceEvent,
  RepairStrategy
} from './llm/index.js'

// Schema Utilities (OpenAI Structured Outputs compatibility)
export {
  boundedArray,
  analyzeSchema,
  assertSchemaCompatible,
  warnSchemaIssues,
  nullable,
  withDefault,
  stringEnum
} from './llm/index.js'
export type {
  SchemaIssue,
  SchemaAnalysisResult
} from './llm/index.js'

// AgentLoop related
export type { LLMClient, AgentLoopConfig } from './agent/agent-loop.js'
export { runAgent } from './agent/agent-loop.js'

// ============================================================================
// Python bridge exports
// ============================================================================

export { PythonBridge } from './python/bridge.js'
export type { PythonBridgeConfig, CallResult } from './python/bridge.js'
export {
  definePythonTool,
  PythonToolFactory,
  createPythonToolFactory
} from './python/define-python-tool.js'
export type { PythonToolConfig } from './python/define-python-tool.js'

// ============================================================================
// MCP adapter exports
// ============================================================================
//
// MCP is used to connect to external tool servers. Usage guide:
// - General capabilities (files, GitHub, databases, etc.) -> Use existing MCP servers
// - Your own business logic -> Use defineTool() to create local tools
//
// See docs/MCP-GUIDE.md for details
// ============================================================================

// Public API: Create MCP Provider (recommended)
export {
  createStdioMCPProvider,   // Local MCP server
  createHttpMCPProvider,    // Remote MCP server
  createMCPProvider,        // Full config (multi-server)
  MCPProvider               // Provider class
} from './mcp/index.js'

// Public types: MCP configuration (needed by TypeScript users)
export type {
  MCPServerConfig,
  MCPProviderConfig,
  MCPStdioConfig,
  MCPHttpConfig,
  MCPTransportConfig
} from './mcp/index.js'

// Error handling
export { MCPError, MCPErrorCode } from './mcp/index.js'

// Advanced API: Direct MCP client operations (special scenarios)
export { MCPClient, createMCPClient } from './mcp/index.js'
export type { MCPClientConfig } from './mcp/index.js'

// Internal implementation: Transport layer and adapters (generally not needed directly)
// If needed, import from 'agent-foundry/mcp'
export { MCPTransport, StdioTransport, HttpTransport } from './mcp/index.js'
export { createStdioTransport, createHttpTransport } from './mcp/index.js'
export {
  adaptMCPTool,
  adaptMCPTools,
  convertJsonSchemaToParameters,
  validateToolInput
} from './mcp/index.js'
export type {
  ToolAdapterOptions,
  MCPToolResultData,
  MCPToolDefinition,
  MCPToolResult,
  MCPContent,
  MCPClientState,
  MCPInputSchema,
  MCPPropertySchema
} from './mcp/index.js'

// ============================================================================
// Permission-to-Policy bridge exports
// ============================================================================

export {
  generateProviderPolicies,
  generatePoliciesFromPermissions,
  generatePoliciesFromBudgets,
  PermissionPolicyBridge,
  validatePermissions,
  validateBudgets
} from './bridges/index.js'
export type { PolicyGenerationOptions } from './bridges/index.js'

// File policies
export { createFileReadPolicy, createFileWritePolicy, createFileAccessPolicies } from './bridges/index.js'
export type { FileAccessPolicyConfig } from './bridges/index.js'

// Network policies
export { createNetworkPolicy, createNetworkAccessPolicies, extractDomain, matchesDomain } from './bridges/index.js'
export type { NetworkPolicyConfig } from './bridges/index.js'

// Execution policies
export { createExecPolicy, createExecAccessPolicies } from './bridges/index.js'
export type { ExecPolicyConfig } from './bridges/index.js'

// Budget policies
export {
  createTimeoutPolicy,
  createOutputLimitPolicy,
  createRequestLimitPolicy,
  createBudgetPolicies
} from './bridges/index.js'
export type {
  TimeoutPolicyConfig,
  OutputLimitPolicyConfig,
  RequestLimitPolicyConfig
} from './bridges/index.js'

// ============================================================================
// Provider auto-discovery exports
// ============================================================================

export {
  ProviderDiscovery,
  autoDiscoverProviders,
  scanProviders,
  createDiscovery
} from './discovery/index.js'
export type { DiscoveryConfig, DiscoveryResult } from './discovery/index.js'

export { scanForManifests, extractPackageInfo } from './discovery/index.js'
export type { ScanOptions } from './discovery/index.js'

// ============================================================================
// Configuration file exports
// ============================================================================

export {
  loadConfig,
  saveConfig,
  tryLoadConfig,
  findConfigFile,
  mergeConfigs,
  normalizePackConfigs,
  normalizeMCPConfigs,
  generateEnvExample,
  validateConfig,
  DEFAULT_CONFIG_FILENAMES
} from './config/index.js'
export type {
  AgentYAMLConfig,
  PackConfigEntry,
  MCPConfigEntry
} from './config/index.js'

// ============================================================================
// CLI exports
// ============================================================================

export { runIndexDocs, parseIndexDocsArgs, printIndexDocsHelp } from './cli/index.js'
export type { IndexDocsOptions } from './cli/index.js'

// ============================================================================
// Multi-Agent Team exports
// ============================================================================

export {
  // Team definition
  defineTeam,
  agentHandle,
  stateConfig,
  isTeamDefinition,

  // Agent registry
  AgentRegistry,
  createAgentRegistry,

  // Team runtime
  TeamRuntime,
  createTeamRuntime,
  createAutoTeamRuntime,
  createPassthroughInvoker,
  createMockInvoker,
  canUseAutoRuntime,
  getMissingRunners,

  // Flow combinators
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  race,
  supervise,
  join,
  transfer,
  retry,
  fallback,
  until,

  // Flow execution
  executeFlow,

  // Handoff
  isHandoffResult,
  createHandoff,
  parseHandoff,
  executeHandoffChain,

  // Reducers
  ReducerRegistry,
  createReducerRegistry,
  concatReducer,
  mergeReducer,
  deepMergeReducer,
  firstReducer,
  lastReducer,
  collectReducer,
  voteReducer,

  // State
  Blackboard,
  createBlackboard,

  // Channels
  ChannelHub,
  createChannelHub,

  // Protocols
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline,
  builtinProtocols,
  ProtocolRegistry,
  createProtocolRegistry,

  // Agent Bridge
  AgentBridge,
  createAgentBridge,
  createMapBasedResolver,
  createFactoryResolver,
  createBridgedTeamRuntime,

  // Schema-free Step API (RFC-002)
  simpleStep,
  simpleBranch,
  simpleSeq,
  simpleLoop,
  simpleSelect,
  simplePar,

  // Format utilities
  format,
  formatJson,
  formatList,
  formatBullets,
  formatKeyValue,
  formatTable,
  formatTruncated
} from './team/index.js'

export type {
  // Team types
  TeamId,
  TeamDefinition,
  AgentHandle,
  ChannelConfig,
  ValidatorRegistration,
  TeamDefaults,
  TeamRunResult,
  TeamTraceEvent,
  TeamRuntimeConfig,

  // Agent catalog types
  AgentCatalogEntry,
  AgentCatalogData,
  AgentCatalogParams,

  // Flow types
  FlowSpec,
  InvokeSpec,
  SeqSpec,
  ParSpec,
  MapSpec,
  ChooseSpec,
  LoopSpec,
  GateSpec,
  RaceSpec,
  SuperviseSpec,
  RetrySpec,
  FallbackSpec,
  InputRef,
  StateRef,
  TransferSpec,
  JoinSpec,
  RouterSpec,
  PredicateSpec,
  UntilSpec,

  // Execution types
  ExecutionContext,
  ExecutionResult,
  AgentInvoker,
  FlowTraceEvent,

  // Handoff types
  HandoffSpec,
  HandoffResult,
  AgentResult,
  HandoffTraceEvent,
  HandoffChainConfig,
  HandoffChainState,

  // Reducer types
  ReducerSpec,
  ReducerContext,

  // State types
  BlackboardConfig,
  StateEntry,

  // Channel types
  ChannelMessage,
  ChannelSubscription,
  ChannelTraceEvent,
  ChannelHubConfig,

  // Protocol types
  ProtocolTemplate,
  ProtocolConfig,

  // Agent Bridge types
  ResolvedAgent,
  AgentResolver,
  AgentBridgeConfig,
  BridgeTraceEvent,

  // Schema-free Step types (RFC-002)
  SimpleInvokeSpec,
  SimpleStepBuilder,
  SimpleStepBuilderWithFrom,
  SimpleBranchConfig,
  SimpleLoopConfig,
  SimpleSelectConfig,
  SimpleParConfig,

  // Format utility types
  FormatOptions
} from './team/index.js'

// ============================================================================
// Activity Formatter exports
// ============================================================================

export { createActivityFormatter } from './trace/activity-formatter.js'
export type { ToolActivityRule, ActivityFormatterOptions } from './trace/activity-formatter.js'

// ============================================================================
// Context Types (shared with Kernel V2)
// ============================================================================

export type {
  ContextFragment,
  ContextSelectionType,
  ContextSelection
} from './types/index.js'

// ============================================================================
// Kernel V2 (RFC-011) exports
// ============================================================================

export {
  createKernelV2,
  KernelV2Impl,
  BudgetPlannerV2,
  ContextAssemblerV2,
  MemoryWriteGateV2,
  CompactionEngineV2,
  TaskStateCoordinator,
  KernelV2Storage,
  KernelV2MemoryStorageAdapter
} from './kernel-v2/index.js'
export type {
  KernelV2,
  KernelV2Config,
  KernelV2ResolvedConfig,
  V2TaskState,
  V2MemoryFact,
  V2CompactSegment,
  V2TaskAnchor,
  V2ContextAssemblyResult,
  KernelV2IntegrityReport,
  KernelV2ReplayPayload,
  KernelV2ReplayRef,
  KernelV2TurnInput,
  KernelV2TurnCompletionInput
} from './kernel-v2/index.js'
