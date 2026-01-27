/**
 * Memory Types - KV Memory Storage Type Definitions
 *
 * Provides types for the explicit key-value memory storage system.
 * Memory is stored in .agent-foundry/memory/ as JSON files.
 */

// ============ Core Types ============

/**
 * Memory item sensitivity levels
 */
export type MemorySensitivity = 'public' | 'internal' | 'sensitive'

/**
 * Memory item status
 */
export type MemoryStatus = 'active' | 'deprecated'

/**
 * Memory namespace (determines storage isolation and policies)
 */
export type MemoryNamespace = 'user' | 'project' | 'session' | string

/**
 * Provenance - tracks where a memory item came from
 */
export interface MemoryProvenance {
  /** Message ID that created this item */
  messageId?: string
  /** Session ID where item was created */
  sessionId?: string
  /** Trace ID for audit */
  traceId: string
  /** Who created this item */
  createdBy: 'user' | 'model' | 'system'
  /** When user confirmed this item (if applicable) */
  confirmedAt?: string
}

/**
 * A single memory item
 */
export interface MemoryItem {
  /** Unique ID */
  id: string
  /** Namespace for isolation (user, project, session) */
  namespace: MemoryNamespace
  /** Key within namespace (dot-separated path, e.g., "writing.style") */
  key: string
  /** Stored value (any JSON-serializable data) */
  value: unknown
  /** Human-readable description of the value */
  valueText?: string
  /** Tags for categorization and search */
  tags: string[]
  /** Sensitivity level */
  sensitivity: MemorySensitivity
  /** Current status */
  status: MemoryStatus
  /** Auto-expire timestamp (ISO string) */
  ttlExpiresAt?: string
  /** Provenance tracking */
  provenance: MemoryProvenance
  /** Creation timestamp */
  createdAt: string
  /** Last update timestamp */
  updatedAt: string
}

// ============ Storage Types ============

/**
 * Memory data file format (.agent-foundry/memory/items.json)
 */
export interface MemoryData {
  version: string
  createdAt: string
  updatedAt: string
  stats: {
    totalItems: number
    byNamespace: Record<string, number>
    bySensitivity: Record<MemorySensitivity, number>
  }
  /** Items keyed by "namespace:key" */
  items: Record<string, MemoryItem>
}

/**
 * Memory index file format (.agent-foundry/memory/index.json)
 */
export interface MemoryIndex {
  version: string
  updatedAt: string
  /** Keyword to item keys mapping */
  keywords: Record<string, string[]>
  /** Tag to item keys mapping */
  tags: Record<string, string[]>
  /** Namespace to item keys mapping */
  namespaces: Record<string, string[]>
}

/**
 * History entry for audit trail
 */
export interface MemoryHistoryEntry {
  op: 'put' | 'update' | 'delete'
  key: string
  timestamp: string
  traceId: string
  actor: 'user' | 'model' | 'system'
  changes?: Record<string, unknown>
  reason?: string
}

// ============ Operation Types ============

/**
 * Options for putting a memory item
 */
export interface MemoryPutOptions {
  namespace: MemoryNamespace
  key: string
  value: unknown
  valueText?: string
  tags?: string[]
  sensitivity?: MemorySensitivity
  ttlDays?: number
  overwrite?: boolean
  provenance?: Partial<MemoryProvenance>
}

/**
 * Options for updating a memory item
 */
export interface MemoryUpdateOptions {
  value?: unknown
  valueText?: string
  tags?: string[]
  status?: MemoryStatus
  sensitivity?: MemorySensitivity
}

/**
 * Options for searching memory
 */
export interface MemorySearchOptions {
  namespace?: MemoryNamespace
  tags?: string[]
  sensitivity?: MemorySensitivity | 'all'
  limit?: number
  includeDeprecated?: boolean
}

/**
 * Search result
 */
export interface MemorySearchResult {
  item: MemoryItem
  score: number
  matchedKeywords: string[]
}

/**
 * Options for listing memory
 */
export interface MemoryListOptions {
  namespace?: MemoryNamespace
  tags?: string[]
  status?: MemoryStatus | 'all'
  limit?: number
  offset?: number
}

// ============ Storage Interface ============

/**
 * Memory storage interface - implemented by FileMemoryStorage
 */
export interface MemoryStorage {
  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>

  // CRUD
  get(namespace: MemoryNamespace, key: string): Promise<MemoryItem | null>
  put(options: MemoryPutOptions): Promise<MemoryItem>
  update(namespace: MemoryNamespace, key: string, options: MemoryUpdateOptions): Promise<MemoryItem | null>
  delete(namespace: MemoryNamespace, key: string, reason?: string): Promise<boolean>

  // Query
  list(options?: MemoryListOptions): Promise<{ items: MemoryItem[]; total: number }>
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>

  // Utilities
  has(namespace: MemoryNamespace, key: string): Promise<boolean>
  cleanExpired(): Promise<number>
  rebuildIndex(): Promise<void>

  // Stats
  getStats(): Promise<MemoryData['stats']>
}

// ============ Validation ============

/**
 * Valid key pattern: lowercase letters, numbers, underscores, hyphens, dots
 * Example: "writing.style", "code_preferences", "note.011b3f93-6ee8-4a74-96c4-f0dc722041ff"
 */
export const MEMORY_KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/

/**
 * Maximum value size in bytes (10KB)
 */
export const MEMORY_MAX_VALUE_SIZE = 10 * 1024

/**
 * Validate a memory key
 */
export function isValidMemoryKey(key: string): boolean {
  return MEMORY_KEY_PATTERN.test(key)
}

/**
 * Build full key from namespace and key
 */
export function buildFullKey(namespace: MemoryNamespace, key: string): string {
  return `${namespace}:${key}`
}

/**
 * Parse full key into namespace and key
 */
export function parseFullKey(fullKey: string): { namespace: MemoryNamespace; key: string } | null {
  const colonIndex = fullKey.indexOf(':')
  if (colonIndex === -1) return null
  return {
    namespace: fullKey.substring(0, colonIndex),
    key: fullKey.substring(colonIndex + 1)
  }
}
