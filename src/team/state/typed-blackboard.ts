/**
 * Typed Blackboard - Schema-Validated State Management
 *
 * Extends the Blackboard with Zod schema validation for type-safe state access.
 * This is the foundation for contract-first team state management.
 */

import { type ZodSchema, type z } from 'zod'
import { Blackboard, type StateTraceContext } from './blackboard.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Schema definition for typed state
 * Maps path names to Zod schemas
 */
export type StateSchemaDefinition = Record<string, ZodSchema<unknown>>

/**
 * Infer the TypeScript type from a state schema definition
 */
export type InferStateType<T extends StateSchemaDefinition> = {
  [K in keyof T]: z.infer<T[K]>
}

/**
 * Typed state reference for use in flow definitions
 */
export interface TypedStateRef<T> {
  readonly type: 'typed-state-ref'
  readonly path: string
  /** Phantom type for compile-time checking */
  readonly _phantom?: T
}

/**
 * Initial input reference for use in flow definitions
 */
export interface TypedInitialRef<T> {
  readonly type: 'typed-initial-ref'
  /** Phantom type for compile-time checking */
  readonly _phantom?: T
}

/**
 * Previous output reference for use in flow definitions
 */
export interface TypedPrevRef<T> {
  readonly type: 'typed-prev-ref'
  /** Phantom type for compile-time checking */
  readonly _phantom?: T
}

/**
 * Constant value reference for use in flow definitions
 */
export interface TypedConstRef<T> {
  readonly type: 'typed-const-ref'
  readonly value: T
}

/**
 * Union of all typed input references
 */
export type TypedInputRef<T> =
  | TypedStateRef<T>
  | TypedInitialRef<T>
  | TypedPrevRef<T>
  | TypedConstRef<T>

/**
 * Configuration for typed blackboard
 */
export interface TypedBlackboardConfig<T extends StateSchemaDefinition> {
  /** Namespace for this team's state */
  namespace: string
  /** State schema definition */
  schema: T
  /** Whether to validate on read (default: false for performance) */
  validateOnRead?: boolean
}

// ============================================================================
// Typed Blackboard Implementation
// ============================================================================

/**
 * Typed Blackboard with schema validation
 */
export class TypedBlackboard<T extends StateSchemaDefinition> {
  private blackboard: Blackboard
  private schema: T
  private validateOnRead: boolean

  constructor(config: TypedBlackboardConfig<T>) {
    this.blackboard = new Blackboard({
      namespace: config.namespace,
      storage: 'memory'
    })
    this.schema = config.schema
    this.validateOnRead = config.validateOnRead ?? false
  }

  /**
   * Get the namespace
   */
  get namespace(): string {
    return this.blackboard.namespace
  }

  /**
   * Get value at a typed path
   */
  get<K extends keyof T & string>(
    key: K,
    ctx?: StateTraceContext
  ): z.infer<T[K]> | undefined {
    const value = this.blackboard.get(key, ctx)

    if (value === undefined) {
      return undefined
    }

    if (this.validateOnRead) {
      const schema = this.schema[key]
      if (schema) {
        return schema.parse(value) as z.infer<T[K]>
      }
    }

    return value as z.infer<T[K]>
  }

  /**
   * Check if path exists
   */
  has<K extends keyof T & string>(key: K): boolean {
    return this.blackboard.has(key)
  }

  /**
   * Set value at a typed path with validation
   */
  set<K extends keyof T & string>(
    key: K,
    value: z.infer<T[K]>,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): void {
    const schema = this.schema[key]
    if (schema) {
      // Validate before storing
      schema.parse(value)
    }
    this.blackboard.put(key, value, ctx, writtenBy)
  }

  /**
   * Delete value at path
   */
  delete<K extends keyof T & string>(key: K, ctx?: StateTraceContext): boolean {
    return this.blackboard.delete(key, ctx)
  }

  /**
   * Get nested path value (for complex state access)
   */
  getPath<R = unknown>(path: string, ctx?: StateTraceContext): R | undefined {
    return this.blackboard.get(path, ctx) as R | undefined
  }

  /**
   * Set nested path value (bypasses schema validation - use with caution)
   */
  setPath(
    path: string,
    value: unknown,
    ctx?: StateTraceContext,
    writtenBy?: string
  ): void {
    this.blackboard.put(path, value, ctx, writtenBy)
  }

  /**
   * Get all state as a typed object
   */
  toObject(): Partial<InferStateType<T>> {
    const obj = this.blackboard.toObject()
    // Extract just our namespace's data
    const namespaceData = obj[this.namespace] as Record<string, unknown> | undefined
    return (namespaceData ?? {}) as Partial<InferStateType<T>>
  }

  /**
   * Get state tree at path
   */
  getTree(path: string): unknown {
    return this.blackboard.getTree(path)
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.blackboard.clear()
  }

  /**
   * Get the underlying blackboard (for advanced usage)
   */
  getBlackboard(): Blackboard {
    return this.blackboard
  }

  /**
   * Get the schema definition
   */
  getSchema(): T {
    return this.schema
  }

  /**
   * Validate a value against a schema key
   */
  validate<K extends keyof T & string>(
    key: K,
    value: unknown
  ): z.infer<T[K]> {
    const schema = this.schema[key]
    if (!schema) {
      throw new Error(`No schema defined for key: ${key}`)
    }
    return schema.parse(value) as z.infer<T[K]>
  }

  /**
   * Safe parse a value against a schema key
   */
  safeParse<K extends keyof T & string>(
    key: K,
    value: unknown
  ): { success: true; data: z.infer<T[K]> } | { success: false; error: unknown } {
    const schema = this.schema[key]
    if (!schema) {
      return { success: false, error: new Error(`No schema defined for key: ${key}`) }
    }

    const result = schema.safeParse(value)
    if (result.success) {
      return { success: true, data: result.data as z.infer<T[K]> }
    }
    return { success: false, error: result.error }
  }
}

// ============================================================================
// State Reference Builders
// ============================================================================

/**
 * Builders for creating typed state references
 */
export const state = {
  /**
   * Define a state schema for a team
   */
  schema: <T extends StateSchemaDefinition>(schema: T) => ({
    type: 'state-schema' as const,
    schema
  }),

  /**
   * Create a typed reference to a state path
   */
  path: <T>(path: string): TypedStateRef<T> => ({
    type: 'typed-state-ref',
    path
  }),

  /**
   * Create a typed reference to the initial team input
   */
  initial: <T>(): TypedInitialRef<T> => ({
    type: 'typed-initial-ref'
  }),

  /**
   * Create a typed reference to the previous step's output
   */
  prev: <T>(): TypedPrevRef<T> => ({
    type: 'typed-prev-ref'
  }),

  /**
   * Create a constant value reference
   */
  const: <T>(value: T): TypedConstRef<T> => ({
    type: 'typed-const-ref',
    value
  })
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a typed state reference
 */
export function isTypedStateRef(value: unknown): value is TypedStateRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'typed-state-ref'
  )
}

/**
 * Check if a value is a typed initial reference
 */
export function isTypedInitialRef(value: unknown): value is TypedInitialRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'typed-initial-ref'
  )
}

/**
 * Check if a value is a typed prev reference
 */
export function isTypedPrevRef(value: unknown): value is TypedPrevRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'typed-prev-ref'
  )
}

/**
 * Check if a value is a typed const reference
 */
export function isTypedConstRef(value: unknown): value is TypedConstRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'typed-const-ref'
  )
}

/**
 * Check if a value is any typed input reference
 */
export function isTypedInputRef(value: unknown): value is TypedInputRef<unknown> {
  return (
    isTypedStateRef(value) ||
    isTypedInitialRef(value) ||
    isTypedPrevRef(value) ||
    isTypedConstRef(value)
  )
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a typed blackboard instance
 */
export function createTypedBlackboard<T extends StateSchemaDefinition>(
  config: TypedBlackboardConfig<T>
): TypedBlackboard<T> {
  return new TypedBlackboard(config)
}

/**
 * Create typed state path helpers from a schema
 *
 * @example
 * ```typescript
 * const schema = {
 *   plan: QueryPlanSchema,
 *   search: SearchResultsSchema,
 *   review: ReviewResultSchema
 * }
 *
 * const paths = createStatePaths(schema)
 * // paths.plan is TypedStateRef<QueryPlan>
 * // paths.search is TypedStateRef<SearchResults>
 * // paths.review is TypedStateRef<ReviewResult>
 *
 * // Usage in flow:
 * step(reviewer).in(paths.search).out(paths.review)
 * ```
 */
export function createStatePaths<T extends StateSchemaDefinition>(
  schema: T
): { [K in keyof T]: TypedStateRef<z.infer<T[K]>> } {
  const paths = {} as { [K in keyof T]: TypedStateRef<z.infer<T[K]>> }

  for (const key of Object.keys(schema) as Array<keyof T>) {
    paths[key] = state.path(key as string)
  }

  return paths
}
