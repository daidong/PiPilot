/**
 * ConflictResolver - Conflict Resolution for Concurrent Writes
 *
 * Provides configurable strategies for handling write conflicts:
 * - last-write-wins: Latest timestamp wins (default)
 * - merge: Deep merge objects, concat arrays
 * - reject: Throw error on conflict
 * - custom: User-provided resolver function
 */

import type { Namespace } from './namespaced-context.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Conflict resolution strategies
 */
export type ConflictStrategy = 'last-write-wins' | 'merge' | 'reject' | 'custom'

/**
 * Metadata about a write conflict
 */
export interface ConflictMeta {
  /** Key being written */
  key: string
  /** Namespace of the key */
  namespace: Namespace
  /** Agent that wrote the existing value */
  existingWriter: string
  /** Timestamp of existing value */
  existingTimestamp: number
  /** Agent attempting the new write */
  incomingWriter: string
  /** Timestamp of incoming write */
  incomingTimestamp: number
}

/**
 * Custom resolver function type
 */
export type CustomResolverFn<T = unknown> = (
  existing: T,
  incoming: T,
  meta: ConflictMeta
) => T

/**
 * Conflict resolver configuration
 */
export interface ConflictResolverConfig {
  /** Resolution strategy */
  strategy: ConflictStrategy
  /** Custom resolver function (for 'custom' strategy) */
  customResolver?: CustomResolverFn
}

/**
 * Conflict resolution result
 */
export interface ConflictResolutionResult<T> {
  /** Resolved value */
  value: T
  /** Strategy used */
  strategy: ConflictStrategy
  /** Whether a conflict occurred */
  hadConflict: boolean
  /** Winner (if applicable) */
  winner?: 'existing' | 'incoming' | 'merged'
}

/**
 * Write conflict error (thrown by 'reject' strategy)
 */
export class WriteConflictError extends Error {
  constructor(public readonly meta: ConflictMeta) {
    super(
      `Write conflict: '${meta.namespace}.${meta.key}' ` +
      `was written by '${meta.existingWriter}' at ${meta.existingTimestamp}, ` +
      `cannot be overwritten by '${meta.incomingWriter}'`
    )
    this.name = 'WriteConflictError'
  }
}

// ============================================================================
// ConflictResolver Implementation
// ============================================================================

/**
 * ConflictResolver - Handles write conflicts in namespaced context
 */
export class ConflictResolver {
  private config: ConflictResolverConfig

  constructor(config: ConflictResolverConfig) {
    this.config = config

    // Validate custom strategy has resolver
    if (config.strategy === 'custom' && !config.customResolver) {
      throw new Error('Custom conflict strategy requires a customResolver function')
    }
  }

  /**
   * Get current strategy
   */
  get strategy(): ConflictStrategy {
    return this.config.strategy
  }

  /**
   * Resolve a conflict between existing and incoming values
   */
  resolve<T>(existing: T, incoming: T, meta: ConflictMeta): T {
    const result = this.resolveWithDetails(existing, incoming, meta)
    return result.value
  }

  /**
   * Resolve a conflict with detailed result
   */
  resolveWithDetails<T>(
    existing: T,
    incoming: T,
    meta: ConflictMeta
  ): ConflictResolutionResult<T> {
    switch (this.config.strategy) {
      case 'last-write-wins':
        return this.resolveLastWriteWins(existing, incoming, meta)

      case 'merge':
        return this.resolveMerge(existing, incoming, meta)

      case 'reject':
        throw new WriteConflictError(meta)

      case 'custom':
        return this.resolveCustom(existing, incoming, meta)

      default:
        // Default to last-write-wins
        return this.resolveLastWriteWins(existing, incoming, meta)
    }
  }

  /**
   * Change the resolution strategy
   */
  setStrategy(strategy: ConflictStrategy, customResolver?: CustomResolverFn): void {
    if (strategy === 'custom' && !customResolver) {
      throw new Error('Custom conflict strategy requires a customResolver function')
    }
    this.config.strategy = strategy
    this.config.customResolver = customResolver
  }

  // ============================================================================
  // Resolution Strategies
  // ============================================================================

  /**
   * Last-write-wins strategy
   */
  private resolveLastWriteWins<T>(
    _existing: T,
    incoming: T,
    _meta: ConflictMeta
  ): ConflictResolutionResult<T> {
    // Incoming write always wins (it's the latest)
    return {
      value: incoming,
      strategy: 'last-write-wins',
      hadConflict: true,
      winner: 'incoming'
    }
  }

  /**
   * Merge strategy - deep merge objects, concat arrays
   */
  private resolveMerge<T>(
    existing: T,
    incoming: T,
    _meta: ConflictMeta
  ): ConflictResolutionResult<T> {
    const merged = this.deepMerge(existing, incoming)
    return {
      value: merged as T,
      strategy: 'merge',
      hadConflict: true,
      winner: 'merged'
    }
  }

  /**
   * Custom strategy
   */
  private resolveCustom<T>(
    existing: T,
    incoming: T,
    meta: ConflictMeta
  ): ConflictResolutionResult<T> {
    const resolver = this.config.customResolver!
    const resolved = resolver(existing, incoming, meta)
    return {
      value: resolved as T,
      strategy: 'custom',
      hadConflict: true
    }
  }

  // ============================================================================
  // Merge Helpers
  // ============================================================================

  /**
   * Deep merge two values
   */
  private deepMerge(existing: unknown, incoming: unknown): unknown {
    // Handle null/undefined
    if (existing === null || existing === undefined) {
      return incoming
    }
    if (incoming === null || incoming === undefined) {
      return existing
    }

    // Handle arrays - concatenate
    if (Array.isArray(existing) && Array.isArray(incoming)) {
      return [...existing, ...incoming]
    }

    // Handle objects - deep merge
    if (this.isPlainObject(existing) && this.isPlainObject(incoming)) {
      const result: Record<string, unknown> = { ...existing as Record<string, unknown> }
      for (const key of Object.keys(incoming as Record<string, unknown>)) {
        const existingValue = (existing as Record<string, unknown>)[key]
        const incomingValue = (incoming as Record<string, unknown>)[key]
        result[key] = this.deepMerge(existingValue, incomingValue)
      }
      return result
    }

    // For primitives, incoming wins
    return incoming
  }

  /**
   * Check if value is a plain object
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    )
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a conflict resolver
 */
export function createConflictResolver(config: ConflictResolverConfig): ConflictResolver {
  return new ConflictResolver(config)
}

/**
 * Create a last-write-wins resolver
 */
export function createLastWriteWinsResolver(): ConflictResolver {
  return new ConflictResolver({ strategy: 'last-write-wins' })
}

/**
 * Create a merge resolver
 */
export function createMergeResolver(): ConflictResolver {
  return new ConflictResolver({ strategy: 'merge' })
}

/**
 * Create a reject resolver
 */
export function createRejectResolver(): ConflictResolver {
  return new ConflictResolver({ strategy: 'reject' })
}

/**
 * Create a custom resolver
 */
export function createCustomResolver<T>(
  resolver: CustomResolverFn<T>
): ConflictResolver {
  return new ConflictResolver({
    strategy: 'custom',
    customResolver: resolver as CustomResolverFn
  })
}
