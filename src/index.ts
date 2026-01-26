/**
 * Agent Foundry - Agent Framework v2
 *
 * 三轴正交架构：
 * - Tools（工具轴）: Agent 能执行的操作
 * - Policies（策略轴）: 决定操作是否被允许
 * - Context Sources（上下文轴）: Agent 获取必要信息
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // Tool 相关类型
  Tool,
  ToolContext,
  ToolResult,
  ParameterSchema,
  ParameterDefinition,

  // Policy 相关类型
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

  // Context 相关类型
  ContextSource,
  ContextResult,
  Provenance,
  Coverage,

  // Pack 相关类型
  Pack,

  // Provider 相关类型
  ProviderPermissions,
  ProviderBudgets,
  ProviderPackDescriptor,
  ToolProviderManifest,
  ProviderCreateOptions,
  ToolProvider,
  ToolProviderConfig,

  // Agent 相关类型
  AgentDefinition,
  AgentConfig,
  Agent,
  AgentRunResult,
  SessionState,

  // Runtime 相关类型
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
// 工厂函数导出
// ============================================================================

export {
  // 定义工具
  defineTool,
  withErrorHandling,
  withTimeout,
  withRetry
} from './factories/define-tool.js'

export {
  // 定义 Provider
  defineProvider
} from './factories/define-provider.js'

export {
  // 定义策略
  definePolicy,
  defineGuardPolicy,
  defineDenyPolicy,
  defineMutatePolicy,
  defineObservePolicy
} from './factories/define-policy.js'

export {
  // 定义上下文源
  defineContextSource
} from './factories/define-context-source.js'

export {
  // 定义 Pack
  definePack,
  mergePacks,
  extendPack,
  filterPack
} from './factories/define-pack.js'

// ============================================================================
// Agent 导出
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
// 核心组件导出
// ============================================================================

export { EventBus } from './core/event-bus.js'
export { TraceCollector } from './core/trace-collector.js'
export { TokenBudget } from './core/token-budget.js'
export { RuntimeIO } from './core/runtime-io.js'
export { ToolRegistry } from './core/tool-registry.js'
export { PolicyEngine } from './core/policy-engine.js'
export { ContextManager } from './core/context-manager.js'
export { PromptCompiler } from './core/prompt-compiler.js'
export { ProviderRegistry } from './core/provider-registry.js'
export { FileMemoryStorage } from './core/memory-storage.js'
export { FileMessageStore } from './core/message-store.js'
export { UnifiedBudgeter, createBudgeterForModel } from './core/unified-budgeter.js'
export { ToolsetCompiler } from './core/toolset-compiler.js'
export {
  generateRuntimeSnapshot,
  createSnapshotData,
  renderSnapshot,
  validateSnapshot
} from './core/runtime-snapshot.js'
export {
  AdaptiveMessageSelector,
  createMessageSelector,
  InsufficientBudgetError
} from './core/adaptive-message-selector.js'
export {
  TokenEstimator,
  createTokenEstimator
} from './core/token-estimator.js'

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
// 内置工具导出
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
  browser,
  browse,
  builtinTools,
  safeTools,
  execTools,
  networkTools,
  computeTools,
  browserTools,
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
  BrowserInput,
  BrowserOutput,
  BrowseInput,
  BrowseOutput,
  SnapshotElement
} from './tools/index.js'

// ============================================================================
// 内置策略导出
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
// 内置上下文源导出
// ============================================================================

export {
  sessionTrace,
  sessionMessages,
  sessionSearch,
  sessionThread,
  sessionContextSources,
  metaContextSources,
  memoryContextSources,
  docsContextSources,
  builtinContextSources
} from './context-sources/index.js'

// ============================================================================
// Packs 导出
// ============================================================================

export {
  // 分层核心
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
  browserPack,
  // 组合工厂
  minimal,
  standard,
  full,
  strict,
  // 命名空间
  packs,
  packMeta
} from './packs/index.js'

export type {
  ExecPackOptions,
  NetworkPackOptions,
  ComputePackOptions,
  PackRiskLevel,
  PackMeta
} from './packs/index.js'

// ============================================================================
// LLM 导出 (基于 Vercel AI SDK)
// ============================================================================

// 类型导出
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
  LLMToolDefinition,
  StreamOptions,
  GenerateOptions,
  CompletionResponse,

  // Provider 信息
  ProviderInfo,

  // 客户端类型
  LLMClientConfig,
  StreamCallbacks
} from './llm/index.js'

// 模型注册表
export {
  builtinModels,
  modelRegistry,
  getModel,
  getAllModels,
  registerModel
} from './llm/index.js'

// Provider 管理
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

// 流式 API
export {
  createLLMClient,
  createLLMClientFromModelId,
  streamWithCallbacks
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

// AgentLoop 相关
export type { LLMClient, AgentLoopConfig } from './agent/agent-loop.js'
export { runAgent } from './agent/agent-loop.js'

// ============================================================================
// Python 桥接导出
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
// MCP 适配器导出
// ============================================================================
//
// MCP 用于连接外部工具服务器。使用指南：
// - 通用能力（文件、GitHub、数据库等）→ 使用现有 MCP server
// - 自己的业务逻辑 → 使用 defineTool() 创建本地工具
//
// 详见 docs/MCP-GUIDE.md
// ============================================================================

// 公共 API：创建 MCP Provider（推荐使用）
export {
  createStdioMCPProvider,   // 本地 MCP server
  createHttpMCPProvider,    // 远程 MCP server
  createMCPProvider,        // 完整配置（多 server）
  MCPProvider               // Provider 类
} from './mcp/index.js'

// 公共类型：配置 MCP（TypeScript 用户需要）
export type {
  MCPServerConfig,
  MCPProviderConfig,
  MCPStdioConfig,
  MCPHttpConfig,
  MCPTransportConfig
} from './mcp/index.js'

// 错误处理
export { MCPError, MCPErrorCode } from './mcp/index.js'

// 高级 API：直接操作 MCP 客户端（特殊场景）
export { MCPClient, createMCPClient } from './mcp/index.js'
export type { MCPClientConfig } from './mcp/index.js'

// 内部实现：传输层和适配器（一般不需要直接使用）
// 如需使用，请从 'agent-foundry/mcp' 导入
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
// 权限→策略桥接导出
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

// 文件策略
export { createFileReadPolicy, createFileWritePolicy, createFileAccessPolicies } from './bridges/index.js'
export type { FileAccessPolicyConfig } from './bridges/index.js'

// 网络策略
export { createNetworkPolicy, createNetworkAccessPolicies, extractDomain, matchesDomain } from './bridges/index.js'
export type { NetworkPolicyConfig } from './bridges/index.js'

// 执行策略
export { createExecPolicy, createExecAccessPolicies } from './bridges/index.js'
export type { ExecPolicyConfig } from './bridges/index.js'

// 预算策略
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
// Provider 自动发现导出
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
// 配置文件导出
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
// 工具推荐导出
// ============================================================================

export {
  ToolRecommender,
  createRecommender,
  // Catalog access
  getToolCatalog,
  getPackCatalog,
  getMCPCatalog,
  // Scoring API (new)
  scoreMCPByQuery,
  scoreToolsByQuery,
  scorePacksByQuery,
  scoreMCPServers,
  scoreTools,
  scorePacks,
  // Category and filter functions
  getMCPByCategory,
  getPopularMCP,
  getPackTools,
  // Formatting
  formatToolCatalogForLLM,
  formatMCPCatalogForLLM,
  collectEnvVars,
  // Template resolution
  resolveTemplate,
  getRequiredParameters,
  getAllParameters
} from './recommendation/index.js'
export type {
  ToolRecommendation,
  MCPRecommendation,
  PackRecommendation,
  RecommendationResult,
  RecommenderConfig,
  ToolCatalogEntry,
  PackCatalogEntry,
  MCPServerEntry,
  ScoredRecommendation,
  MatchSignal
} from './recommendation/index.js'

// ============================================================================
// CLI 导出
// ============================================================================

export { InitWizard, runInitWizard } from './cli/index.js'

// ============================================================================
// Multi-Agent Team 导出
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
