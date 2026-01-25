/**
 * Context Types - 上下文轴类型定义
 * Context Sources 提供 Agent 获取必要信息的能力
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
export type ContextNamespace = 'repo' | 'docs' | 'session' | 'memory' | 'images' | 'ctx'

// ============ Standard Parameter Shapes ============

/**
 * Index Shape - Browse structure
 * Used by: repo.index, docs.index, images.index, memory.list
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
 * Used by: repo.search, docs.search, session.search, memory.search, images.search
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
 * Used by: repo.file, docs.open, session.thread, images.open
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
 * 数据来源追踪
 */
export interface Provenance {
  /** 执行的操作列表 */
  operations: {
    type: string
    target: string
    traceId: string
  }[]
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 是否来自缓存 */
  cached: boolean
}

/**
 * 覆盖度说明
 */
export interface Coverage {
  /** 是否完整 */
  complete: boolean
  /** 限制说明 */
  limitations?: string[]
  /** 建议 */
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
 * 上下文获取结果
 */
export interface ContextResult<T = unknown> {
  success: boolean
  error?: string
  /** 结构化数据（供程序侧使用） */
  data?: T
  /** 渲染后的文本（给模型看，token 预算基于此计算） */
  rendered: string
  /** 数据来源追踪 */
  provenance: Provenance
  /** 覆盖度说明 */
  coverage: Coverage
  /** Echo back what was called (for confirmation) */
  kindEcho?: KindEcho
  /** Machine-readable hints for next action */
  next?: NextStep[]
}

/**
 * 缓存配置
 */
export interface CacheConfig {
  /** TTL（毫秒） */
  ttlMs: number
  /** 失效事件 */
  invalidateOn?: string[]
}

/**
 * 渲染配置
 */
export interface RenderConfig {
  /** 最大 token 数 */
  maxTokens: number
  /** 截断策略 */
  truncateStrategy: 'head' | 'tail' | 'middle'
}

/**
 * 成本等级
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
 * 上下文源定义
 */
export interface ContextSource<TParams = unknown, TData = unknown> {
  /** 源 ID（如 repo.index, repo.search） */
  id: string
  /** Namespace (extracted from id, e.g., 'repo' from 'repo.index') */
  namespace: string
  /** Kind determines parameter shape and usage pattern */
  kind: ContextKind
  /** Full description */
  description: string
  /** One-liner for catalog listing */
  shortDescription: string
  /** 声明的资源类型（用于 Policy 匹配） */
  resourceTypes: string[]
  /** Parameter schema for validation */
  params?: ParamSchema[]
  /** Example calls for documentation */
  examples?: ContextSourceExample[]
  /** 获取函数 */
  fetch: (params: TParams, runtime: Runtime) => Promise<ContextResult<TData>>
  /** 缓存配置 */
  cache?: CacheConfig
  /** 成本等级 */
  costTier: CostTier
  /** 渲染配置 */
  render?: RenderConfig
}

/**
 * 上下文源配置（用于 defineContextSource）
 */
export interface ContextSourceConfig<TParams = unknown, TData = unknown> {
  /** Source ID (e.g., 'repo.index') - namespace is extracted automatically */
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
 * 内置上下文源 ID
 */
export type BuiltinContextSourceId =
  // repo namespace
  | 'repo.index'
  | 'repo.search'
  | 'repo.symbols'
  | 'repo.file'
  | 'repo.git'
  // session namespace
  | 'session.history'
  | 'session.recent'
  | 'session.search'
  | 'session.thread'
  // memory namespace
  | 'memory.get'
  | 'memory.search'
  | 'memory.list'
  // docs namespace
  | 'docs.index'
  | 'docs.search'
  | 'docs.open'
  // meta namespace
  | 'ctx.catalog'
  | 'ctx.describe'
  | 'ctx.route'
