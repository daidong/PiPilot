/**
 * Recommendation Module - Tool Recommendation System
 *
 * Provides multi-signal scoring, parameterized templates, and
 * YAML-based catalog management.
 */

// ============================================================================
// Recommender
// ============================================================================

export {
  ToolRecommender,
  createRecommender,
  type ToolRecommendation,
  type MCPRecommendation,
  type PackRecommendation,
  type RecommendationResult,
  type RecommenderConfig
} from './recommender.js'

// ============================================================================
// Tool & Pack Catalog
// ============================================================================

export {
  getToolCatalog,
  getPackCatalog,
  scoreToolsByQuery,
  scorePacksByQuery,
  getPackTools,
  formatToolCatalogForLLM,
  getToolsByRiskLevel,
  getPacksByRiskLevel,
  getToolsRequiringApproval,
  isHighRiskPack,
  type ToolCatalogEntry,
  type PackCatalogEntry
} from './tool-catalog.js'

// ============================================================================
// MCP Catalog
// ============================================================================

export {
  getMCPCatalog,
  scoreMCPByQuery,
  getMCPByCategory,
  getPopularMCP,
  getMCPServerByName,
  formatMCPCatalogForLLM,
  collectEnvVars,
  hasParameterizedConfig,
  getServersRequiringConfig,
  type MCPServerEntry
} from './mcp-catalog.js'

// ============================================================================
// Scoring System
// ============================================================================

export {
  scoreMCPServers,
  scoreTools,
  scorePacks,
  tokenize,
  formatScoredResult,
  DEFAULT_WEIGHTS,
  type ScoredRecommendation,
  type MatchSignal,
  type SignalType,
  type ScoringWeights
} from './scorer.js'

// ============================================================================
// Template Resolution
// ============================================================================

export {
  resolveTemplate,
  isParameterizedTemplate,
  isSimpleTemplate,
  getRequiredParameters,
  getAllParameters,
  getParameterPrompt,
  parseParameterInput,
  type ParameterValues,
  type ParameterValidationError,
  type ResolvedTemplate
} from './template-resolver.js'

// ============================================================================
// Loader (for advanced usage)
// ============================================================================

export {
  loadMCPCatalog,
  loadToolCatalog,
  getMCPEntries,
  getToolEntries,
  getPackEntries,
  clearCache,
  getCacheStatus
} from './loader.js'

// ============================================================================
// Schemas (for extension/validation)
// ============================================================================

export * from './schemas/index.js'
