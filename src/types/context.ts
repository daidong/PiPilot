/**
 * Context Types - Context axis type definitions
 * Context Sources provide agents with the ability to retrieve necessary information
 */

import type { Runtime } from './runtime.js'

// ============ Kind & Namespace ============

/**
 * Context Source Kind - determines parameter shape and usage pattern
 */
export type ContextKind = 'index' | 'search' | 'open' | 'get'

/**
 * Built-in namespaces
 */
export type ContextNamespace = 'docs' | 'session' | 'memory' | 'ctx'

// ============ Standard Parameter Shapes ============

/**
 * Index Shape - Browse structure
 * Used by: docs.index, memory.list, session.trace
 */
export interface IndexParams {
  /** Subtree to browse */
  scope?: string
  /** Filter by prefix */
  prefix?: string
  /** Max depth (default: 2) */
  depth?: number
  /** Max items (default: 50) */
  limit?: number
  /** Sort order */
  sort?: 'name' | 'modified' | 'size'
  /** Domain-specific filters */
  filters?: Record<string, unknown>
}

/**
 * Search Shape - Retrieve candidates
 * Used by: docs.search, memory.search
 */
export interface SearchParams {
  /** Search query (required) */
  query: string
  /** Max results (default: 10) */
  k?: number
  /** Search mode */
  mode?: 'keyword' | 'semantic' | 'hybrid'
  /** Recency bias */
  recencyBias?: 'high' | 'medium' | 'low'
  /** Limit search scope */
  scope?: string
  /** Domain-specific filters */
  filters?: {
    type?: string | string[]
    tags?: string[]
    dateRange?: { from?: string; to?: string }
    [key: string]: unknown
  }
}

/**
 * Open Shape - Read single object
 * Used by: docs.open
 */
export interface OpenParams {
  /** Object ID (mutually exclusive with path) */
  id?: string
  /** File path (mutually exclusive with id) */
  path?: string
  /** Read mode */
  mode?: 'full' | 'snippets' | 'outline'
  /** Line or chunk range */
  range?: {
    start?: number
    end?: number
  }
  /** Specific chunk */
  chunkId?: string
  /** Highlight relevant sections */
  focusQuery?: string
  /** Domain-specific filters */
  filters?: Record<string, unknown>
}

/**
 * Get Shape - Exact key lookup
 * Used by: memory.get, config.get
 */
export interface GetParams {
  /** Namespace (required) */
  namespace: string
  /** Key (required) */
  key: string
  /** Specific version */
  version?: string
}

// ============ Provenance & Coverage ============

/**
 * Data provenance tracking
 */
export interface Provenance {
  /** List of executed operations */
  operations: {
    type: string
    target: string
    traceId: string
  }[]
  /** Execution duration (milliseconds) */
  durationMs: number
  /** Whether the result came from cache */
  cached: boolean
}

/**
 * Coverage description
 */
export interface Coverage {
  /** Whether the result is complete */
  complete: boolean
  /** Limitation descriptions */
  limitations?: string[]
  /** Suggestions */
  suggestions?: string[]
}

/**
 * Kind Echo - confirms what was actually called
 */
export interface KindEcho {
  /** Source ID that was called */
  source: string
  /** Kind of the source */
  kind: ContextKind
  /** Actual params used (after defaults applied) */
  paramsUsed: Record<string, unknown>
}

/**
 * Next Step - machine-readable hint for next action
 */
export interface NextStep {
  /** Recommended next source */
  source: string
  /** Suggested params (can be partial template) */
  params: Record<string, unknown>
  /** One-line explanation */
  why: string
  /** Confidence score 0-1 */
  confidence?: number
}

/**
 * Context fetch result
 */
export interface ContextResult<T = unknown> {
  success: boolean
  error?: string
  /** Structured data (for programmatic use) */
  data?: T
  /** Rendered text (for the model; token budget is calculated based on this) */
  rendered: string
  /** Data provenance tracking */
  provenance: Provenance
  /** Coverage description */
  coverage: Coverage
  /** Echo back what was called (for confirmation) */
  kindEcho?: KindEcho
  /** Machine-readable hints for next action */
  next?: NextStep[]
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** TTL (milliseconds) */
  ttlMs: number
  /** Invalidation events */
  invalidateOn?: string[]
}

/**
 * Render configuration
 */
export interface RenderConfig {
  /** Maximum number of tokens */
  maxTokens: number
  /** Truncation strategy */
  truncateStrategy: 'head' | 'tail' | 'middle'
}

/**
 * Cost tier
 */
export type CostTier = 'cheap' | 'medium' | 'expensive'

/**
 * Parameter schema for a context source
 */
export interface ParamSchema {
  /** Parameter name */
  name: string
  /** Parameter type */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  /** Is required */
  required: boolean
  /** Description */
  description: string
  /** Default value */
  default?: unknown
  /** Allowed values for enums */
  enum?: unknown[]
}

/**
 * Example call for documentation
 */
export interface ContextSourceExample {
  /** Example description */
  description: string
  /** Example params */
  params: Record<string, unknown>
  /** Expected result summary */
  resultSummary?: string
}

/**
 * Context source definition
 */
export interface ContextSource<TParams = unknown, TData = unknown> {
  /** Source ID (e.g., docs.index, session.trace) */
  id: string
  /** Namespace (extracted from id, e.g., 'docs' from 'docs.index') */
  namespace: string
  /** Kind determines parameter shape and usage pattern */
  kind: ContextKind
  /** Full description */
  description: string
  /** One-liner for catalog listing */
  shortDescription: string
  /** Declared resource types (for Policy matching) */
  resourceTypes: string[]
  /** Parameter schema for validation */
  params?: ParamSchema[]
  /** Example calls for documentation */
  examples?: ContextSourceExample[]
  /** Fetch function */
  fetch: (params: TParams, runtime: Runtime) => Promise<ContextResult<TData>>
  /** Cache configuration */
  cache?: CacheConfig
  /** Cost tier */
  costTier: CostTier
  /** Render configuration */
  render?: RenderConfig
}

/**
 * Context source configuration (for defineContextSource)
 */
export interface ContextSourceConfig<TParams = unknown, TData = unknown> {
  /** Source ID (e.g., 'docs.index') - namespace is extracted automatically */
  id: string
  /** Kind determines parameter shape */
  kind: ContextKind
  /** Full description */
  description: string
  /** One-liner for catalog (optional, derived from description if not provided) */
  shortDescription?: string
  /** Resource types for Policy matching */
  resourceTypes?: string[]
  /** Parameter schema for validation */
  params?: ParamSchema[]
  /** Example calls */
  examples?: ContextSourceExample[]
  /** Fetch function */
  fetch: (params: TParams, runtime: Runtime) => Promise<ContextResult<TData>>
  /** Cache config */
  cache?: CacheConfig
  /** Cost tier */
  costTier: CostTier
  /** Render config */
  render?: RenderConfig
}

/**
 * Built-in context source IDs
 */
export type BuiltinContextSourceId =
  // session namespace
  | 'session.trace'
  // memory namespace
  | 'memory.get'
  | 'memory.search'
  | 'memory.list'
  // docs namespace
  | 'docs.index'
  | 'docs.search'
  | 'docs.open'
  // todo namespace
  | 'todo.list'
  | 'todo.get'
  // meta namespace
  | 'ctx.catalog'
  | 'ctx.describe'
