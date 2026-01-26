/**
 * IsolatedBlackboard - Blackboard-compatible wrapper for NamespacedContext
 *
 * Provides backward compatibility with the Blackboard interface while enabling
 * agent isolation through NamespacedContext. This allows teams to opt-in to
 * agent namespace isolation without breaking existing code.
 *
 * Key features:
 * - SYSTEM_AGENT for flow-level operations (predicate, loop, branch)
 * - setCurrentAgent/resetAgent for context switching during step execution
 * - Full Blackboard API compatibility
 * - getPrivate/setPrivate for agent-specific data
 */

import {
  NamespacedContext,
  createNamespacedContext,
  type NamespacedContextConfig,
  type Namespace,
  AccessDeniedError
} from './namespaced-context.js'
import { ContextPermissions } from './context-permissions.js'
import type { ConflictStrategy, ConflictMeta } from './conflict-resolver.js'
import type { StateEntry, StateTraceContext } from './blackboard.js'

// Re-export for convenience
export { AccessDeniedError }

// ============================================================================
// Constants
// ============================================================================

/**
 * System agent ID for flow-level operations (predicate, loop, branch, etc.)
 * These operations don't belong to any specific agent but need state access.
 */
export const SYSTEM_AGENT = '__system__'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for IsolatedBlackboard
 */
export interface IsolatedBlackboardConfig {
  /** Namespace prefix (typically team ID) */
  namespace: string
  /** Conflict resolution strategy (default: last-write-wins) */
  conflictStrategy?: ConflictStrategy
  /** Custom conflict resolver (for 'custom' strategy) */
  customResolver?: <T>(existing: T, incoming: T, meta: ConflictMeta) => T
  /** Storage backend (only 'memory' supported currently) */
  storage?: 'memory' | 'sqlite'
}

/**
 * Isolated state structure
 */
export interface IsolatedState {
  /** Shared team namespace data */
  team: Record<string, unknown>
  /** Per-agent private data */
  agents: Record<string, Record<string, unknown>>
}

// ============================================================================
// IsolatedBlackboard Implementation
// ============================================================================

/**
 * IsolatedBlackboard - Blackboard-compatible wrapper for NamespacedContext
 *
 * Provides a familiar Blackboard API while using NamespacedContext under the hood
 * for agent isolation. The default namespace for Blackboard operations is 'team',
 * making it backward compatible with existing code.
 *
 * @example
 * ```typescript
 * const state = new IsolatedBlackboard({ namespace: 'my-team' })
 *
 * // Regular Blackboard usage (operates on team namespace)
 * state.put('findings', [{ topic: 'AI' }])
 * state.get('findings') // Returns [{ topic: 'AI' }]
 *
 * // Agent context for step execution
 * state.setCurrentAgent('researcher')
 * state.setPrivate('scratchpad', 'Working on research...')
 * state.getPrivate('scratchpad') // Returns 'Working on research...'
 * state.resetAgent()
 * ```
 */
export class IsolatedBlackboard {
  private context: NamespacedContext
  private currentAgentId: string = SYSTEM_AGENT
  private config: IsolatedBlackboardConfig

  constructor(config: IsolatedBlackboardConfig) {
    this.config = config

    // Create underlying NamespacedContext
    const contextConfig: NamespacedContextConfig = {
      teamId: config.namespace,
      conflictStrategy: config.conflictStrategy ?? 'last-write-wins',
      customResolver: config.customResolver
    }

    this.context = createNamespacedContext(contextConfig)

    // Grant SYSTEM_AGENT read access to team namespace
    this.context.getPermissions().grant(SYSTEM_AGENT, 'team', 'read')
  }

  // ============================================================================
  // Agent Context Management
  // ============================================================================

  /**
   * Get the namespace
   */
  get namespace(): string {
    return this.config.namespace
  }

  /**
   * Set the current agent context
   * Call this before executing a step to establish agent identity
   */
  setCurrentAgent(agentId: string): void {
    this.currentAgentId = agentId
  }

  /**
   * Reset to system agent context
   * Call this after step execution completes
   */
  resetAgent(): void {
    this.currentAgentId = SYSTEM_AGENT
  }

  /**
   * Get the current agent ID
   */
  getCurrentAgent(): string {
    return this.currentAgentId
  }

  // ============================================================================
  // Blackboard-Compatible API (operates on team namespace)
  // ============================================================================

  /**
   * Get value at path (team namespace)
   */
  get(path: string, ctx?: StateTraceContext): unknown {
    return this.context.get(this.currentAgentId, 'team', path, ctx)
  }

  /**
   * Check if path exists (team namespace)
   */
  has(path: string): boolean {
    return this.context.has(this.currentAgentId, 'team', path)
  }

  /**
   * Put value at path (team namespace)
   */
  put(
    path: string,
    value: unknown,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const agent = writtenBy ?? this.currentAgentId
    this.context.set(agent, 'team', path, value, ctx)
    return this.buildEntry(path, value, agent)
  }

  /**
   * Append to array at path (team namespace)
   */
  append(
    path: string,
    value: unknown,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const agent = writtenBy ?? this.currentAgentId
    this.context.append(agent, 'team', path, value, ctx)
    const current = this.context.get(agent, 'team', path) as unknown[]
    return this.buildEntry(path, current, agent)
  }

  /**
   * Patch object at path (team namespace)
   */
  patch(
    path: string,
    patchData: Record<string, unknown>,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): StateEntry {
    const agent = writtenBy ?? this.currentAgentId
    this.context.patch(agent, 'team', path, patchData, ctx)
    const current = this.context.get(agent, 'team', path)
    return this.buildEntry(path, current, agent)
  }

  /**
   * Delete value at path (team namespace)
   * Requires admin permission
   */
  delete(path: string, ctx?: StateTraceContext): boolean {
    return this.context.delete(this.currentAgentId, 'team', path, ctx)
  }

  /**
   * Query paths matching a prefix (team namespace)
   */
  query(prefix: string): StateEntry[] {
    const entries = this.context.entries(this.currentAgentId, 'team')
    return entries
      .filter(entry => entry.key.startsWith(prefix))
      .map(entry => ({
        path: entry.path,
        value: entry.value,
        version: entry.version,
        updatedAt: entry.updatedAt,
        writtenBy: entry.writtenBy
      }))
  }

  /**
   * Get state tree at path (team namespace)
   * Preserves Blackboard.getTree semantics for multi-entry assembly
   */
  getTree(path: string): unknown {
    // Delegate to underlying blackboard for getTree semantics
    return this.context.getBlackboard().getTree(`team.${path}`)
  }

  /**
   * Get all state as nested object (backward compatible)
   * Returns the same structure as Blackboard.toObject()
   *
   * Internal structure: { namespace: { team: { ... }, agent: { ... } } }
   * External structure: { namespace: { ... } } (team contents promoted)
   */
  toObject(): Record<string, unknown> {
    const fullState = this.context.getBlackboard().toObject()
    const namespace = this.config.namespace

    // Transform to backward-compatible structure
    // Promote team namespace contents to remove the extra layer
    const namespaceData = fullState[namespace] as Record<string, unknown> | undefined
    if (namespaceData && namespaceData.team && typeof namespaceData.team === 'object') {
      // Return { namespace: { ...teamData } } (promotes team contents up)
      return {
        [namespace]: namespaceData.team
      }
    }

    return fullState
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.context.clear()
  }

  /**
   * Get current version
   */
  getVersion(): number {
    return this.context.getBlackboard().getVersion()
  }

  /**
   * Export state for serialization
   */
  export(): { entries: StateEntry[]; version: number } {
    return this.context.export()
  }

  /**
   * Import state from serialized form
   */
  import(data: { entries: StateEntry[]; version: number }): void {
    this.context.import(data)
  }

  // ============================================================================
  // Extended API for Isolation
  // ============================================================================

  /**
   * Get value from current agent's private namespace
   */
  getPrivate<T = unknown>(key: string): T | undefined {
    const namespace = `agent.${this.currentAgentId}` as Namespace
    return this.context.get<T>(this.currentAgentId, namespace, key)
  }

  /**
   * Set value in current agent's private namespace
   */
  setPrivate(key: string, value: unknown): void {
    const namespace = `agent.${this.currentAgentId}` as Namespace
    this.context.set(this.currentAgentId, namespace, key, value)
  }

  /**
   * Check if key exists in current agent's private namespace
   */
  hasPrivate(key: string): boolean {
    const namespace = `agent.${this.currentAgentId}` as Namespace
    return this.context.has(this.currentAgentId, namespace, key)
  }

  /**
   * Delete key from current agent's private namespace
   */
  deletePrivate(key: string): boolean {
    const namespace = `agent.${this.currentAgentId}` as Namespace
    return this.context.delete(this.currentAgentId, namespace, key)
  }

  /**
   * Get isolated state view (for debugging/monitoring)
   * Shows the internal structure with team and agent namespaces
   */
  toIsolatedObject(): IsolatedState {
    const fullState = this.context.getBlackboard().toObject()
    const namespace = this.config.namespace

    const team: Record<string, unknown> = {}
    const agents: Record<string, Record<string, unknown>> = {}

    // Parse the nested structure
    const namespaceData = fullState[namespace] as Record<string, unknown> | undefined
    if (namespaceData) {
      // Extract team data
      if (namespaceData.team && typeof namespaceData.team === 'object') {
        Object.assign(team, namespaceData.team)
      }

      // Extract agent data
      if (namespaceData.agent && typeof namespaceData.agent === 'object') {
        const agentData = namespaceData.agent as Record<string, unknown>
        for (const [agentId, data] of Object.entries(agentData)) {
          if (typeof data === 'object' && data !== null) {
            agents[agentId] = data as Record<string, unknown>
          }
        }
      }
    }

    return { team, agents }
  }

  // ============================================================================
  // Access to Underlying Components
  // ============================================================================

  /**
   * Get the underlying NamespacedContext
   */
  getNamespacedContext(): NamespacedContext {
    return this.context
  }

  /**
   * Get the permissions manager
   */
  getPermissions(): ContextPermissions {
    return this.context.getPermissions()
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Build a StateEntry from current state
   */
  private buildEntry(path: string, value: unknown, writtenBy?: string): StateEntry {
    const fullPath = `${this.config.namespace}.team.${path}`
    return {
      path: fullPath,
      value,
      version: this.getVersion(),
      updatedAt: Date.now(),
      writtenBy
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an IsolatedBlackboard instance
 */
export function createIsolatedBlackboard(config: IsolatedBlackboardConfig): IsolatedBlackboard {
  return new IsolatedBlackboard(config)
}

/**
 * Type guard to check if a blackboard is an IsolatedBlackboard
 */
export function isIsolatedBlackboard(state: unknown): state is IsolatedBlackboard {
  return (
    state !== null &&
    typeof state === 'object' &&
    'setCurrentAgent' in state &&
    'resetAgent' in state &&
    'getNamespacedContext' in state
  )
}
