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

// Type alias for schema-free API (keeping interface compatible)
type TypedStateRef<T> = { ref: 'state'; path: string; _phantom?: T }

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
  }),

  /**
   * Three-state termination: success, no-progress-fail, or continue.
   *
   * This prevents loops from spinning when reviewer rejects but provides
   * no actionable refinement (a common real-world scenario).
   *
   * States:
   * - approved=true → success exit
   * - approved=false + no actionable refinement → fail exit
   * - approved=false + has actionable refinement → continue
   *
   * @example
   * ```typescript
   * loop(
   *   seq(
   *     step(reviewer).in(...).out(state.path('review')),
   *     branch({
   *       when: (s) => s.review?.additionalQueries?.length > 0,
   *       then: step(refiner).in(...).out(...),
   *       else: noop
   *     })
   *   ),
   *   until.threeState({
   *     approvalPath: 'review.approved',
   *     refinementPath: 'review.additionalQueries'
   *   }),
   *   { maxIters: 5 }
   * )
   * ```
   */
  threeState: (options: {
    /** Path to approval field (e.g., 'review.approved') */
    approvalPath: string
    /** Path to refinement field (e.g., 'review.additionalQueries') */
    refinementPath: string
    /** Custom check for actionable refinement (default: non-empty array/object) */
    hasActionableRefinement?: (refinement: unknown) => boolean
  }): ThreeStateUntilSpec => ({
    type: 'three-state',
    approvalPath: options.approvalPath,
    refinementPath: options.refinementPath,
    hasActionableRefinement: options.hasActionableRefinement
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

// Extend BusinessUntilSpec to include combinators and three-state
export type ExtendedBusinessUntilSpec =
  | BusinessUntilSpec
  | AllUntilSpec
  | AnyUntilSpec
  | FieldCompareUntilSpec
  | ThreeStateUntilSpec

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
    spec.type === 'any' ||
    spec.type === 'three-state'
  )
}

/**
 * Check if a value is a three-state until spec
 */
export function isThreeStateUntilSpec(value: unknown): value is ThreeStateUntilSpec {
  if (typeof value !== 'object' || value === null) return false
  return (value as { type?: unknown }).type === 'three-state'
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
// Three-State Termination
// ============================================================================

/**
 * Three-state termination result.
 * Addresses the issue of loops spinning without progress.
 */
export interface ThreeStateResult {
  /** Whether the loop should stop */
  done: boolean
  /** Reason for termination */
  reason: ThreeStateReason
  /** Whether this is a failure (vs success) */
  failed?: boolean
}

/**
 * Reason for three-state termination
 */
export type ThreeStateReason =
  | 'approved'              // Success: condition met
  | 'no-actionable-refinement'  // Fail: can't make progress
  | 'max-iterations'        // Fail: exceeded max attempts
  | 'continue'              // Continue: has refinement to try

/**
 * Three-state condition spec
 */
export interface ThreeStateUntilSpec {
  type: 'three-state'
  /** Path to approval field (e.g., 'review.approved') */
  approvalPath: string
  /** Path to refinement field (e.g., 'review.additionalQueries') */
  refinementPath: string
  /** Optional: custom check for actionable refinement */
  hasActionableRefinement?: (refinement: unknown) => boolean
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

    case 'three-state':
      // Three-state evaluation returns boolean for backwards compatibility
      // Use evaluateThreeState for full result
      return evaluateThreeState(spec, ctx).done

    default:
      return false
  }
}

/**
 * Evaluate a three-state termination condition.
 *
 * Returns a detailed result indicating:
 * - done: whether to stop
 * - reason: why (approved, no-actionable-refinement, or continue)
 * - failed: whether this is a failure state
 *
 * @example
 * ```typescript
 * const spec = until.threeState({
 *   approvalPath: 'review.approved',
 *   refinementPath: 'review.additionalQueries'
 * })
 *
 * const result = evaluateThreeState(spec, ctx)
 * if (result.done) {
 *   if (result.failed) {
 *     console.log(`Loop failed: ${result.reason}`)
 *   } else {
 *     console.log('Loop succeeded')
 *   }
 * }
 * ```
 */
export function evaluateThreeState(
  spec: ThreeStateUntilSpec,
  ctx: UntilEvaluationContext
): ThreeStateResult {
  // Check approval
  const approved = ctx.getStateValue(spec.approvalPath)
  if (approved === true) {
    return { done: true, reason: 'approved', failed: false }
  }

  // Not approved - check if there's actionable refinement
  const refinement = ctx.getStateValue(spec.refinementPath)

  // Default check: refinement is a non-empty array or truthy value
  const hasRefinement = spec.hasActionableRefinement
    ? spec.hasActionableRefinement(refinement)
    : defaultHasActionableRefinement(refinement)

  if (!hasRefinement) {
    // No actionable refinement - fail exit
    return { done: true, reason: 'no-actionable-refinement', failed: true }
  }

  // Has actionable refinement - continue
  return { done: false, reason: 'continue', failed: false }
}

/**
 * Default check for actionable refinement.
 * Returns true if refinement is a non-empty array or truthy non-empty value.
 */
function defaultHasActionableRefinement(refinement: unknown): boolean {
  if (refinement === null || refinement === undefined) return false
  if (Array.isArray(refinement)) return refinement.length > 0
  if (typeof refinement === 'object') return Object.keys(refinement).length > 0
  return Boolean(refinement)
}
