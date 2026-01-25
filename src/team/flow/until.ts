/**
 * Business-Semantic Until Conditions
 *
 * Provides expressive, business-focused stop conditions for loops.
 * Instead of framework concepts like `noCriticalIssues`, users can write
 * conditions that directly express their business semantics:
 *
 *   until.field(state.path('review.approved')).eq(true)
 *
 * This makes the flow definition self-documenting and easier to understand.
 */

import type { ZodSchema } from 'zod'
import type { TypedStateRef } from '../state/typed-blackboard.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Extended UntilSpec with business-semantic conditions
 */
export type BusinessUntilSpec =
  | FieldEqUntilSpec
  | FieldNeqUntilSpec
  | FieldTruthyUntilSpec
  | FieldFalsyUntilSpec
  | ValidatorUntilSpec
  | MaxIterationsUntilSpec
  | NoProgressUntilSpec
  | BudgetExceededUntilSpec

/**
 * Field equals value condition
 */
export interface FieldEqUntilSpec {
  type: 'field-eq'
  path: string
  value: unknown
}

/**
 * Field not equals value condition
 */
export interface FieldNeqUntilSpec {
  type: 'field-neq'
  path: string
  value: unknown
}

/**
 * Field is truthy condition
 */
export interface FieldTruthyUntilSpec {
  type: 'field-truthy'
  path: string
}

/**
 * Field is falsy condition
 */
export interface FieldFalsyUntilSpec {
  type: 'field-falsy'
  path: string
}

/**
 * Schema-based validator condition
 */
export interface ValidatorUntilSpec<T = unknown> {
  type: 'validator'
  path: string
  schema: ZodSchema<T>
  check: (value: T) => boolean
}

/**
 * Maximum iterations condition
 */
export interface MaxIterationsUntilSpec {
  type: 'max-iterations'
  count: number
}

/**
 * No progress detected condition
 */
export interface NoProgressUntilSpec {
  type: 'no-progress'
  windowSize?: number
}

/**
 * Budget exceeded condition
 */
export interface BudgetExceededUntilSpec {
  type: 'budget-exceeded'
}

// ============================================================================
// Field Condition Builder
// ============================================================================

/**
 * Builder for field-based conditions
 */
export interface FieldConditionBuilder<T> {
  /**
   * Stop when field equals the specified value
   *
   * @example
   * ```typescript
   * until.field(state.path<boolean>('review.approved')).eq(true)
   * ```
   */
  eq(value: T): FieldEqUntilSpec

  /**
   * Stop when field does not equal the specified value
   *
   * @example
   * ```typescript
   * until.field(state.path<string>('status')).neq('pending')
   * ```
   */
  neq(value: T): FieldNeqUntilSpec

  /**
   * Stop when field is truthy
   *
   * @example
   * ```typescript
   * until.field(state.path<boolean>('completed')).truthy()
   * ```
   */
  truthy(): FieldTruthyUntilSpec

  /**
   * Stop when field is falsy
   *
   * @example
   * ```typescript
   * until.field(state.path<boolean>('hasErrors')).falsy()
   * ```
   */
  falsy(): FieldFalsyUntilSpec

  /**
   * Stop when field passes comparison
   * @param comparator Comparison operator
   * @param value Value to compare against
   */
  compare(comparator: 'gt' | 'gte' | 'lt' | 'lte', value: number): FieldCompareUntilSpec
}

/**
 * Field comparison condition
 */
export interface FieldCompareUntilSpec {
  type: 'field-compare'
  path: string
  comparator: 'gt' | 'gte' | 'lt' | 'lte'
  value: number
}

// ============================================================================
// Until Builder
// ============================================================================

/**
 * Business-semantic until condition builders
 *
 * @example
 * ```typescript
 * // Stop when review is approved
 * until.field(state.path<boolean>('review.approved')).eq(true)
 *
 * // Stop when confidence exceeds threshold
 * until.field(state.path<number>('confidence')).compare('gte', 0.9)
 *
 * // Stop when all issues are resolved
 * until.validator(
 *   state.path('issues'),
 *   z.array(IssueSchema),
 *   (issues) => issues.length === 0
 * )
 *
 * // Stop after max iterations
 * until.maxIterations(5)
 * ```
 */
export const until = {
  /**
   * Create a field-based condition
   *
   * @example
   * ```typescript
   * until.field(state.path<boolean>('approved')).eq(true)
   * until.field(state.path<string>('status')).neq('pending')
   * until.field(state.path<boolean>('done')).truthy()
   * ```
   */
  field: <T>(pathRef: TypedStateRef<T> | string): FieldConditionBuilder<T> => {
    const path = typeof pathRef === 'string' ? pathRef : pathRef.path

    return {
      eq(value: T): FieldEqUntilSpec {
        return { type: 'field-eq', path, value }
      },

      neq(value: T): FieldNeqUntilSpec {
        return { type: 'field-neq', path, value }
      },

      truthy(): FieldTruthyUntilSpec {
        return { type: 'field-truthy', path }
      },

      falsy(): FieldFalsyUntilSpec {
        return { type: 'field-falsy', path }
      },

      compare(comparator: 'gt' | 'gte' | 'lt' | 'lte', value: number): FieldCompareUntilSpec {
        return { type: 'field-compare', path, comparator, value }
      }
    }
  },

  /**
   * Create a schema-based validator condition
   *
   * @example
   * ```typescript
   * until.validator(
   *   state.path('review'),
   *   ReviewSchema,
   *   (review) => review.approved && review.issues.length === 0
   * )
   * ```
   */
  validator: <T>(
    pathRef: TypedStateRef<T> | string,
    schema: ZodSchema<T>,
    check: (value: T) => boolean
  ): ValidatorUntilSpec<T> => {
    const path = typeof pathRef === 'string' ? pathRef : pathRef.path
    return { type: 'validator', path, schema, check }
  },

  /**
   * Stop after maximum iterations
   *
   * @example
   * ```typescript
   * until.maxIterations(3)
   * ```
   */
  maxIterations: (count: number): MaxIterationsUntilSpec => ({
    type: 'max-iterations',
    count
  }),

  /**
   * Stop when no progress is detected
   *
   * @example
   * ```typescript
   * until.noProgress(3) // Stop if no progress for 3 iterations
   * ```
   */
  noProgress: (windowSize?: number): NoProgressUntilSpec => ({
    type: 'no-progress',
    windowSize
  }),

  /**
   * Stop when budget is exceeded
   *
   * @example
   * ```typescript
   * until.budgetExceeded()
   * ```
   */
  budgetExceeded: (): BudgetExceededUntilSpec => ({
    type: 'budget-exceeded'
  }),

  /**
   * Combine multiple conditions with AND logic
   * Stop when ALL conditions are true
   *
   * @example
   * ```typescript
   * until.all(
   *   until.field(state.path('approved')).eq(true),
   *   until.field(state.path('confidence')).compare('gte', 0.8)
   * )
   * ```
   */
  all: (...conditions: BusinessUntilSpec[]): AllUntilSpec => ({
    type: 'all',
    conditions
  }),

  /**
   * Combine multiple conditions with OR logic
   * Stop when ANY condition is true
   *
   * @example
   * ```typescript
   * until.any(
   *   until.field(state.path('approved')).eq(true),
   *   until.maxIterations(5)
   * )
   * ```
   */
  any: (...conditions: BusinessUntilSpec[]): AnyUntilSpec => ({
    type: 'any',
    conditions
  })
}

/**
 * Combined condition with AND logic
 */
export interface AllUntilSpec {
  type: 'all'
  conditions: BusinessUntilSpec[]
}

/**
 * Combined condition with OR logic
 */
export interface AnyUntilSpec {
  type: 'any'
  conditions: BusinessUntilSpec[]
}

// Extend BusinessUntilSpec to include combinators
export type ExtendedBusinessUntilSpec = BusinessUntilSpec | AllUntilSpec | AnyUntilSpec | FieldCompareUntilSpec

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a business until spec
 */
export function isBusinessUntilSpec(value: unknown): value is ExtendedBusinessUntilSpec {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as { type?: unknown }
  return (
    spec.type === 'field-eq' ||
    spec.type === 'field-neq' ||
    spec.type === 'field-truthy' ||
    spec.type === 'field-falsy' ||
    spec.type === 'field-compare' ||
    spec.type === 'validator' ||
    spec.type === 'max-iterations' ||
    spec.type === 'no-progress' ||
    spec.type === 'budget-exceeded' ||
    spec.type === 'all' ||
    spec.type === 'any'
  )
}

/**
 * Check if a value is a field-based until spec
 */
export function isFieldUntilSpec(
  value: unknown
): value is FieldEqUntilSpec | FieldNeqUntilSpec | FieldTruthyUntilSpec | FieldFalsyUntilSpec | FieldCompareUntilSpec {
  if (typeof value !== 'object' || value === null) return false
  const spec = value as { type?: unknown }
  return (
    spec.type === 'field-eq' ||
    spec.type === 'field-neq' ||
    spec.type === 'field-truthy' ||
    spec.type === 'field-falsy' ||
    spec.type === 'field-compare'
  )
}

/**
 * Check if a value is a validator until spec
 */
export function isValidatorUntilSpec(value: unknown): value is ValidatorUntilSpec {
  if (typeof value !== 'object' || value === null) return false
  return (value as { type?: unknown }).type === 'validator'
}

// ============================================================================
// Evaluation
// ============================================================================

/**
 * Context for evaluating until conditions
 */
export interface UntilEvaluationContext {
  /** Get value from state path */
  getStateValue: (path: string) => unknown
  /** Current iteration count */
  iteration: number
  /** Budget tracker (if available) */
  budget?: {
    used: number
    limit: number
  }
  /** Progress tracker (if available) */
  progressTracker?: {
    hasProgress: (windowSize: number) => boolean
  }
}

/**
 * Evaluate a business until condition
 *
 * @returns true if the loop should stop
 */
export function evaluateBusinessUntil(
  spec: ExtendedBusinessUntilSpec,
  ctx: UntilEvaluationContext
): boolean {
  switch (spec.type) {
    case 'field-eq': {
      const value = ctx.getStateValue(spec.path)
      return value === spec.value
    }

    case 'field-neq': {
      const value = ctx.getStateValue(spec.path)
      return value !== spec.value
    }

    case 'field-truthy': {
      const value = ctx.getStateValue(spec.path)
      return Boolean(value)
    }

    case 'field-falsy': {
      const value = ctx.getStateValue(spec.path)
      return !value
    }

    case 'field-compare': {
      const value = ctx.getStateValue(spec.path) as number
      if (typeof value !== 'number') return false
      switch (spec.comparator) {
        case 'gt': return value > spec.value
        case 'gte': return value >= spec.value
        case 'lt': return value < spec.value
        case 'lte': return value <= spec.value
      }
      return false
    }

    case 'validator': {
      const value = ctx.getStateValue(spec.path)
      if (value === undefined) return false
      try {
        const validated = spec.schema.parse(value)
        return spec.check(validated)
      } catch {
        // If validation fails, condition is not met
        return false
      }
    }

    case 'max-iterations':
      return ctx.iteration >= spec.count

    case 'no-progress':
      if (!ctx.progressTracker) return false
      return !ctx.progressTracker.hasProgress(spec.windowSize ?? 2)

    case 'budget-exceeded':
      if (!ctx.budget) return false
      return ctx.budget.used >= ctx.budget.limit

    case 'all':
      return spec.conditions.every(cond => evaluateBusinessUntil(cond, ctx))

    case 'any':
      return spec.conditions.some(cond => evaluateBusinessUntil(cond, ctx))

    default:
      return false
  }
}
