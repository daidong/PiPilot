/**
 * Edge Combinators - Input Transformation and Conditional Flow
 *
 * These combinators allow transforming data between agents and
 * creating conditional flows without polluting agent logic.
 */

import type { FlowSpec, InputRef } from './ast.js'
import type {
  TypedInputRef,
  TypedStateRef,
  TypedInitialRef,
  TypedPrevRef,
  TypedConstRef
} from '../state/typed-blackboard.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Mapped input reference - transforms input before passing to agent
 */
export interface MappedInputRef<TFrom, TTo> {
  readonly type: 'mapped-input-ref'
  /** Source input reference */
  readonly source: TypedInputRef<TFrom> | InputRef
  /** Transform function */
  readonly transform: (input: TFrom) => TTo
  /** Phantom type for compile-time checking */
  readonly _phantomFrom?: TFrom
  readonly _phantomTo?: TTo
}

/**
 * Branch specification for conditional flow
 */
export interface BranchSpec<TState = unknown> {
  readonly kind: 'branch'
  /** Condition function */
  readonly condition: (state: TState) => boolean
  /** Flow to execute if condition is true */
  readonly then: FlowSpec
  /** Flow to execute if condition is false */
  readonly else: FlowSpec
  /** Optional name for debugging */
  readonly name?: string
  /** Optional tags */
  readonly tags?: string[]
}

/**
 * No-op specification (for conditional branches that skip)
 */
export interface NoopSpec {
  readonly kind: 'noop'
  /** Optional name for debugging */
  readonly name?: string
}

/**
 * Select specification - choose between multiple branches based on key
 */
export interface SelectSpec<TState = unknown> {
  readonly kind: 'select'
  /** Function to extract the selection key from state */
  readonly selector: (state: TState) => string
  /** Map of branch keys to flows */
  readonly branches: Record<string, FlowSpec>
  /** Default branch if key not found */
  readonly default?: FlowSpec
  /** Optional name for debugging */
  readonly name?: string
  /** Optional tags */
  readonly tags?: string[]
}

// ============================================================================
// Input Transformation
// ============================================================================

/**
 * Transform input before passing to an agent.
 *
 * This is a first-class edge adaptation combinator that keeps
 * transformation logic out of agents.
 *
 * @example
 * ```typescript
 * // Transform query plan to searcher input
 * step(searcher)
 *   .in(mapInput(state.path('plan'), plan => ({
 *     queries: plan.searchQueries,
 *     sources: plan.searchStrategy.suggestedSources
 *   })))
 *   .out(state.path('search'))
 *
 * // Chain transformations
 * const reviewerInput = mapInput(
 *   state.path('search'),
 *   results => ({ papers: results.papers, criteria: 'relevance' })
 * )
 * ```
 */
export function mapInput<TFrom, TTo>(
  source: TypedStateRef<TFrom>,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo>

export function mapInput<TFrom, TTo>(
  source: TypedInitialRef<TFrom>,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo>

export function mapInput<TFrom, TTo>(
  source: TypedPrevRef<TFrom>,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo>

export function mapInput<TFrom, TTo>(
  source: TypedConstRef<TFrom>,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo>

export function mapInput<TFrom, TTo>(
  source: InputRef,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo>

export function mapInput<TFrom, TTo>(
  source: TypedInputRef<TFrom> | InputRef,
  transform: (input: TFrom) => TTo
): MappedInputRef<TFrom, TTo> {
  return {
    type: 'mapped-input-ref',
    source,
    transform
  }
}

/**
 * Compose multiple input transformations
 *
 * @example
 * ```typescript
 * const transform = composeMapInput(
 *   (plan: QueryPlan) => plan.searchQueries,
 *   (queries: string[]) => queries.map(q => q.toLowerCase()),
 *   (queries: string[]) => ({ queries, limit: 10 })
 * )
 * ```
 */
export function composeMapInput<A, B>(
  f1: (a: A) => B
): (a: A) => B

export function composeMapInput<A, B, C>(
  f1: (a: A) => B,
  f2: (b: B) => C
): (a: A) => C

export function composeMapInput<A, B, C, D>(
  f1: (a: A) => B,
  f2: (b: B) => C,
  f3: (c: C) => D
): (a: A) => D

export function composeMapInput(...fns: Array<(x: unknown) => unknown>): (x: unknown) => unknown {
  return (x: unknown) => fns.reduce((acc, fn) => fn(acc), x)
}

// ============================================================================
// Conditional Flow
// ============================================================================

/**
 * Conditional branching without polluting agent logic.
 *
 * Use this to create conditional flows based on state,
 * keeping agents focused on their single responsibility.
 *
 * @example
 * ```typescript
 * // Only refine search if not approved
 * branch({
 *   when: state => state.review?.approved === false,
 *   then: step(searcher).in(mapInput(state.path('review'), r => ({
 *     queries: r.additionalQueries ?? [],
 *     sources: ['arxiv', 'semantic_scholar']
 *   }))).out(state.path('search')),
 *   else: noop
 * })
 * ```
 */
export function branch<TState = unknown>(config: {
  when: (state: TState) => boolean
  then: FlowSpec
  else: FlowSpec
  name?: string
  tags?: string[]
}): BranchSpec<TState> {
  return {
    kind: 'branch',
    condition: config.when,
    then: config.then,
    else: config.else,
    name: config.name,
    tags: config.tags
  }
}

/**
 * No-op flow step - does nothing.
 *
 * Useful in conditional branches where one path should skip.
 *
 * @example
 * ```typescript
 * branch({
 *   when: state => state.needsRefinement,
 *   then: step(refiner).in(...).out(...),
 *   else: noop  // Skip refinement
 * })
 * ```
 */
export const noop: NoopSpec = {
  kind: 'noop'
}

/**
 * Create a named noop (useful for debugging)
 */
export function namedNoop(name: string): NoopSpec {
  return {
    kind: 'noop',
    name
  }
}

/**
 * Select one of multiple branches based on a key.
 *
 * Similar to a switch statement in code.
 *
 * @example
 * ```typescript
 * select({
 *   selector: state => state.taskType,
 *   branches: {
 *     'search': step(searcher).in(...).out(...),
 *     'summarize': step(summarizer).in(...).out(...),
 *     'review': step(reviewer).in(...).out(...)
 *   },
 *   default: step(defaultHandler).in(...).out(...)
 * })
 * ```
 */
export function select<TState = unknown>(config: {
  selector: (state: TState) => string
  branches: Record<string, FlowSpec>
  default?: FlowSpec
  name?: string
  tags?: string[]
}): SelectSpec<TState> {
  return {
    kind: 'select',
    selector: config.selector,
    branches: config.branches,
    default: config.default,
    name: config.name,
    tags: config.tags
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a mapped input reference
 */
export function isMappedInputRef(value: unknown): value is MappedInputRef<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'mapped-input-ref'
  )
}

/**
 * Check if a value is a branch spec
 */
export function isBranchSpec(value: unknown): value is BranchSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'branch'
  )
}

/**
 * Check if a value is a noop spec
 */
export function isNoopSpec(value: unknown): value is NoopSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'noop'
  )
}

/**
 * Check if a value is a select spec
 */
export function isSelectSpec(value: unknown): value is SelectSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'select'
  )
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Resolve a mapped input reference to get the final value
 */
export function resolveMappedInput<TFrom, TTo>(
  ref: MappedInputRef<TFrom, TTo>,
  getValue: (source: TypedInputRef<TFrom> | InputRef) => TFrom
): TTo {
  const sourceValue = getValue(ref.source)
  return ref.transform(sourceValue)
}

/**
 * Create a passthrough transform (identity function)
 */
export function passthrough<T>(): (x: T) => T {
  return (x: T) => x
}

/**
 * Create a transform that picks specific fields
 */
export function pick<T, K extends keyof T>(...keys: K[]): (obj: T) => Pick<T, K> {
  return (obj: T) => {
    const result = {} as Pick<T, K>
    for (const key of keys) {
      result[key] = obj[key]
    }
    return result
  }
}

/**
 * Create a transform that omits specific fields
 */
export function omit<T, K extends keyof T>(...keys: K[]): (obj: T) => Omit<T, K> {
  return (obj: T) => {
    const result = { ...obj }
    for (const key of keys) {
      delete (result as Record<string, unknown>)[key as string]
    }
    return result as Omit<T, K>
  }
}

/**
 * Create a transform that merges with a constant object
 */
export function merge<T, U>(additions: U): (obj: T) => T & U {
  return (obj: T) => ({ ...obj, ...additions })
}
