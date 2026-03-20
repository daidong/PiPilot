/**
 * NamespacedContext - Namespace-based Context Isolation for Multi-Agent Teams
 *
 * Provides context isolation with:
 * - `team.*` namespace for shared data across all agents
 * - `agent.<id>.*` namespace for private agent data
 * - Permission-based access control
 * - Conflict resolution for concurrent writes
 */

import { Blackboard, type StateTraceContext, type StateEntry } from './blackboard.js'
import { ContextPermissions, type Permission } from './context-permissions.js'
import { ConflictResolver, WriteConflictError, type ConflictStrategy, type ConflictMeta } from './conflict-resolver.js'

// Re-export WriteConflictError for convenience
export { WriteConflictError }

// ============================================================================
// Types
// ============================================================================

/**
 * Namespace types
 * - 'team' for shared data
 * - 'agent.<id>' for private agent data
 */
export type Namespace = 'team' | `agent.${string}`

/**
 * Access denied error
 */
export class AccessDeniedError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly namespace: Namespace,
    public readonly key: string,
    public readonly permission: Permission
  ) {
    super(`Access denied: agent '${agentId}' cannot ${permission} '${namespace}.${key}'`)
    this.name = 'AccessDeniedError'
  }
}


/**
 * Configuration for NamespacedContext
 */
export interface NamespacedContextConfig {
  /** Team namespace prefix */
  teamId: string
  /** Conflict resolution strategy */
  conflictStrategy?: ConflictStrategy
  /** Custom conflict resolver (for 'custom' strategy) */
  customResolver?: <T>(existing: T, incoming: T, meta: ConflictMeta) => T
}

/**
 * Write options
 */
export interface WriteOptions {
  /** Skip permission check (internal use only) */
  skipPermissionCheck?: boolean
  /** Force write even if conflict (override conflict strategy) */
  force?: boolean
}

/**
 * Entry with namespace metadata
 */
export interface NamespacedEntry extends StateEntry {
  namespace: Namespace
  key: string
}

// ============================================================================
// NamespacedContext Implementation
// ============================================================================

/**
 * NamespacedContext - Provides namespace-based context isolation
 */
export class NamespacedContext {
  private blackboard: Blackboard
  private permissions: ContextPermissions
  private conflictResolver: ConflictResolver
  private config: NamespacedContextConfig

  constructor(config: NamespacedContextConfig) {
    this.config = config

    // Create blackboard with team namespace
    this.blackboard = new Blackboard({
      namespace: config.teamId,
      storage: 'memory'
    })

    // Create permissions manager
    this.permissions = new ContextPermissions()

    // Create conflict resolver
    this.conflictResolver = new ConflictResolver({
      strategy: config.conflictStrategy ?? 'last-write-wins',
      customResolver: config.customResolver
    })
  }

  /**
   * Get the team ID
   */
  get teamId(): string {
    return this.config.teamId
  }

  /**
   * Get the permissions manager
   */
  getPermissions(): ContextPermissions {
    return this.permissions
  }

  /**
   * Get the conflict resolver
   */
  getConflictResolver(): ConflictResolver {
    return this.conflictResolver
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get value from namespace
   */
  get<T>(
    agentId: string,
    namespace: Namespace,
    key: string,
    ctx?: StateTraceContext
  ): T | undefined {
    // Check read permission
    if (!this.permissions.canAccess(agentId, namespace, 'read')) {
      throw new AccessDeniedError(agentId, namespace, key, 'read')
    }

    const fullPath = this.buildPath(namespace, key)
    return this.blackboard.get(fullPath, ctx) as T | undefined
  }

  /**
   * Check if key exists in namespace
   */
  has(agentId: string, namespace: Namespace, key: string): boolean {
    // Check read permission
    if (!this.permissions.canAccess(agentId, namespace, 'read')) {
      throw new AccessDeniedError(agentId, namespace, key, 'read')
    }

    const fullPath = this.buildPath(namespace, key)
    return this.blackboard.has(fullPath)
  }

  /**
   * Get all keys in namespace
   */
  keys(agentId: string, namespace: Namespace): string[] {
    // Check read permission
    if (!this.permissions.canAccess(agentId, namespace, 'read')) {
      throw new AccessDeniedError(agentId, namespace, '', 'read')
    }

    const prefix = this.buildPath(namespace, '')
    const entries = this.blackboard.query(prefix)

    // The Blackboard prepends teamId, so full prefix is: teamId.namespace
    const fullPrefix = `${this.config.teamId}.${namespace}`

    return entries.map(entry => {
      // Extract key from full path (entry.path = teamId.namespace.key)
      if (!entry.path.startsWith(fullPrefix)) {
        return ''
      }
      const relativePath = entry.path.slice(fullPrefix.length)
      return relativePath.startsWith('.') ? relativePath.slice(1) : relativePath
    }).filter(key => key.length > 0)
  }

  /**
   * Get all entries in namespace
   */
  entries(agentId: string, namespace: Namespace): NamespacedEntry[] {
    // Check read permission
    if (!this.permissions.canAccess(agentId, namespace, 'read')) {
      throw new AccessDeniedError(agentId, namespace, '', 'read')
    }

    const prefix = this.buildPath(namespace, '')
    const stateEntries = this.blackboard.query(prefix)

    // The Blackboard prepends teamId, so full prefix is: teamId.namespace
    const fullPrefix = `${this.config.teamId}.${namespace}`

    return stateEntries.map(entry => {
      if (!entry.path.startsWith(fullPrefix)) {
        return { ...entry, namespace, key: '' }
      }
      const relativePath = entry.path.slice(fullPrefix.length)
      const key = relativePath.startsWith('.') ? relativePath.slice(1) : relativePath
      return {
        ...entry,
        namespace,
        key
      }
    }).filter(entry => entry.key.length > 0)
  }

  /**
   * Get state tree at path (preserves Blackboard.getTree semantics)
   * This is important for multi-entry assembly functionality
   */
  getTree(agentId: string, namespace: Namespace, path: string): unknown {
    // Check read permission
    if (!this.permissions.canAccess(agentId, namespace, 'read')) {
      throw new AccessDeniedError(agentId, namespace, path, 'read')
    }

    const fullPath = this.buildPath(namespace, path)
    return this.blackboard.getTree(fullPath)
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Set value in namespace
   */
  set<T>(
    agentId: string,
    namespace: Namespace,
    key: string,
    value: T,
    ctx?: StateTraceContext,
    options?: WriteOptions
  ): void {
    // Check write permission
    if (!options?.skipPermissionCheck) {
      if (!this.permissions.canAccess(agentId, namespace, 'write')) {
        throw new AccessDeniedError(agentId, namespace, key, 'write')
      }
    }

    const fullPath = this.buildPath(namespace, key)

    // Check for conflicts
    if (!options?.force) {
      const existing = this.blackboard.get(fullPath) as T | undefined
      if (existing !== undefined) {
        const entry = this.getEntry(fullPath)
        if (entry && entry.writtenBy && entry.writtenBy !== agentId) {
          // Potential conflict
          const meta: ConflictMeta = {
            key,
            namespace,
            existingWriter: entry.writtenBy,
            existingTimestamp: entry.updatedAt,
            incomingWriter: agentId,
            incomingTimestamp: Date.now()
          }

          const resolved = this.conflictResolver.resolve(existing, value, meta)
          this.blackboard.put(fullPath, resolved, ctx, agentId)
          return
        }
      }
    }

    this.blackboard.put(fullPath, value, ctx, agentId)
  }

  /**
   * Append to array in namespace
   */
  append<T>(
    agentId: string,
    namespace: Namespace,
    key: string,
    value: T,
    ctx?: StateTraceContext
  ): void {
    // Check write permission
    if (!this.permissions.canAccess(agentId, namespace, 'write')) {
      throw new AccessDeniedError(agentId, namespace, key, 'write')
    }

    const fullPath = this.buildPath(namespace, key)
    this.blackboard.append(fullPath, value, ctx, agentId)
  }

  /**
   * Patch object in namespace (shallow merge)
   */
  patch(
    agentId: string,
    namespace: Namespace,
    key: string,
    patch: Record<string, unknown>,
    ctx?: StateTraceContext
  ): void {
    // Check write permission
    if (!this.permissions.canAccess(agentId, namespace, 'write')) {
      throw new AccessDeniedError(agentId, namespace, key, 'write')
    }

    const fullPath = this.buildPath(namespace, key)
    this.blackboard.patch(fullPath, patch, ctx, agentId)
  }

  /**
   * Delete key from namespace
   */
  delete(
    agentId: string,
    namespace: Namespace,
    key: string,
    ctx?: StateTraceContext
  ): boolean {
    // Check admin permission for delete
    if (!this.permissions.canAccess(agentId, namespace, 'admin')) {
      throw new AccessDeniedError(agentId, namespace, key, 'admin')
    }

    const fullPath = this.buildPath(namespace, key)
    return this.blackboard.delete(fullPath, ctx)
  }

  // ============================================================================
  // Namespace Helpers
  // ============================================================================

  /**
   * Get team namespace accessor for an agent
   */
  team(agentId: string): NamespaceAccessor {
    return new NamespaceAccessor(this, agentId, 'team')
  }

  /**
   * Get private namespace accessor for an agent
   */
  private_(agentId: string): NamespaceAccessor {
    return new NamespaceAccessor(this, agentId, `agent.${agentId}`)
  }

  /**
   * Get accessor for a specific namespace
   */
  namespace(agentId: string, namespace: Namespace): NamespaceAccessor {
    return new NamespaceAccessor(this, agentId, namespace)
  }

  // ============================================================================
  // Admin Operations
  // ============================================================================

  /**
   * Clear all data (admin only)
   */
  clear(): void {
    this.blackboard.clear()
  }

  /**
   * Export all state
   */
  export(): { entries: StateEntry[]; version: number } {
    return this.blackboard.export()
  }

  /**
   * Import state
   */
  import(data: { entries: StateEntry[]; version: number }): void {
    this.blackboard.import(data)
  }

  /**
   * Get the underlying blackboard (for advanced usage)
   */
  getBlackboard(): Blackboard {
    return this.blackboard
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Build full path from namespace and key
   */
  private buildPath(namespace: Namespace, key: string): string {
    if (key === '') {
      return namespace
    }
    return `${namespace}.${key}`
  }

  /**
   * Get entry metadata
   */
  private getEntry(fullPath: string): StateEntry | undefined {
    const entries = this.blackboard.query(fullPath)
    return entries.find(e => e.path === fullPath)
  }
}

// ============================================================================
// Namespace Accessor
// ============================================================================

/**
 * Namespace accessor - convenience wrapper for accessing a specific namespace
 */
export class NamespaceAccessor {
  constructor(
    private context: NamespacedContext,
    private agentId: string,
    private namespace: Namespace
  ) {}

  /**
   * Get value
   */
  get<T>(key: string, ctx?: StateTraceContext): T | undefined {
    return this.context.get<T>(this.agentId, this.namespace, key, ctx)
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    return this.context.has(this.agentId, this.namespace, key)
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return this.context.keys(this.agentId, this.namespace)
  }

  /**
   * Set value
   */
  set<T>(key: string, value: T, ctx?: StateTraceContext): void {
    this.context.set(this.agentId, this.namespace, key, value, ctx)
  }

  /**
   * Append to array
   */
  append<T>(key: string, value: T, ctx?: StateTraceContext): void {
    this.context.append(this.agentId, this.namespace, key, value, ctx)
  }

  /**
   * Patch object
   */
  patch(key: string, patch: Record<string, unknown>, ctx?: StateTraceContext): void {
    this.context.patch(this.agentId, this.namespace, key, patch, ctx)
  }

  /**
   * Delete key
   */
  delete(key: string, ctx?: StateTraceContext): boolean {
    return this.context.delete(this.agentId, this.namespace, key, ctx)
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a namespaced context
 */
export function createNamespacedContext(config: NamespacedContextConfig): NamespacedContext {
  return new NamespacedContext(config)
}
