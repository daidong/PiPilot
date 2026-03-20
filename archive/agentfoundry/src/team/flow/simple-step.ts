/**
 * Simple Step Builder - Simplified Flow API
 *
 * Provides a cleaner, schema-free API for defining flow steps:
 *   step('agent').from('inputPath').to('outputPath')
 *
 * This is an alternative to the typed step builder for cases
 * where schema validation is not needed.
 *
 * @example
 * ```typescript
 * import { step, simpleSeq, simpleBranch } from 'agent-foundry/team'
 *
 * const flow = simpleSeq(
 *   step('planner'),
 *   step('searcher').from('planner'),
 *   step('reviewer').from('searcher').to('review'),
 *   simpleBranch({
 *     if: (s) => s.review?.approved === true,
 *     then: step('publisher'),
 *     else: step('reviser')
 *   })
 * )
 * ```
 */

import type { FlowSpec, InvokeSpec, InputRef, StateRef, BranchSpec, SeqSpec } from './ast.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Simple invoke spec (without schema information)
 */
export interface SimpleInvokeSpec extends InvokeSpec {
  /** Agent ID */
  agent: string
  /** Input reference */
  input: InputRef
  /** Output state path */
  outputAs?: StateRef
}

/**
 * Step builder with from/to API
 */
export interface SimpleStepBuilder {
  /**
   * Specify where to read input from
   *
   * @param source - State path, transform function, or 'initial'
   *
   * @example
   * step('agent').from('planner')           // Read from state.planner
   * step('agent').from('planner.queries')   // Read nested path
   * step('agent').from((s) => s.custom)     // Transform function
   */
  from(source: string | ((state: Record<string, unknown>) => unknown)): SimpleStepBuilderWithFrom

  /**
   * Build step with default input (previous step output)
   */
  to(path: string): SimpleInvokeSpec

  /**
   * Build step with default input and no output storage
   */
  build(): SimpleInvokeSpec
}

/**
 * Step builder after from() is called
 */
export interface SimpleStepBuilderWithFrom {
  /**
   * Specify where to store output in state
   *
   * @param path - State path to store output
   *
   * @example
   * step('agent').from('input').to('result')
   */
  to(path: string): SimpleInvokeSpec

  /**
   * Build without storing output (passes to next step via prev)
   */
  build(): SimpleInvokeSpec
}

/**
 * Branch configuration
 */
export interface SimpleBranchConfig {
  /** Condition function - receives state as unknown for safety */
  if: (state: unknown) => boolean
  /** Branch to execute if condition is true */
  then: FlowSpec
  /** Branch to execute if condition is false */
  else?: FlowSpec
  /** Maximum iterations (if used in loop) */
  maxIterations?: number
}

// ============================================================================
// Step Builder Implementation
// ============================================================================

/**
 * Create a simple step for the given agent ID.
 *
 * Unlike the typed step() builder, this version:
 * - Takes agent ID as string (not agent object)
 * - Uses .from() / .to() instead of .in() / .out()
 * - Doesn't carry schema information
 *
 * @param agentId - The agent ID to invoke
 *
 * @example
 * ```typescript
 * // Basic - uses prev() as input
 * step('analyzer')
 *
 * // With input from state path
 * step('analyzer').from('planner')
 *
 * // With input transformation
 * step('analyzer').from(s => ({ data: s.raw, options: s.config }))
 *
 * // With output storage
 * step('analyzer').from('input').to('result')
 *
 * // Full chain
 * simpleSeq(
 *   step('planner'),                           // input: initial, output: prev
 *   step('executor').from('planner'),          // input: state.planner, output: prev
 *   step('verifier').from('executor').to('final')  // input: state.executor, output: state.final
 * )
 * ```
 */
export function simpleStep(agentId: string): SimpleStepBuilder {
  return {
    from(source: string | ((state: Record<string, unknown>) => unknown)): SimpleStepBuilderWithFrom {
      const inputRef = resolveSimpleSource(source)

      return {
        to(path: string): SimpleInvokeSpec {
          return {
            kind: 'invoke',
            agent: agentId,
            input: inputRef,
            outputAs: { path }
          }
        },

        build(): SimpleInvokeSpec {
          return {
            kind: 'invoke',
            agent: agentId,
            input: inputRef
          }
        }
      }
    },

    to(path: string): SimpleInvokeSpec {
      return {
        kind: 'invoke',
        agent: agentId,
        input: { ref: 'prev' },
        outputAs: { path }
      }
    },

    build(): SimpleInvokeSpec {
      return {
        kind: 'invoke',
        agent: agentId,
        input: { ref: 'prev' }
      }
    }
  }
}

// ============================================================================
// Branch Helper
// ============================================================================

/**
 * Create a conditional branch.
 *
 * @param config - Branch configuration
 *
 * @example
 * ```typescript
 * simpleBranch({
 *   if: (s) => s.review?.approved === true,
 *   then: step('publisher'),
 *   else: step('reviser')
 * })
 *
 * // With optional chaining for safety
 * simpleBranch({
 *   if: (s) => (s.review?.score ?? 0) >= 7,
 *   then: step('publish'),
 *   else: step('improve')
 * })
 * ```
 */
export function simpleBranch(config: SimpleBranchConfig): BranchSpec {
  return {
    kind: 'branch',
    condition: config.if,
    then: config.then,
    else: config.else ?? { kind: 'noop' }
  }
}

// ============================================================================
// Sequence Helper
// ============================================================================

/**
 * Create a sequence of steps.
 *
 * Similar to seq() but automatically handles first step's input.
 *
 * @param steps - Steps to execute in sequence
 *
 * @example
 * ```typescript
 * simpleSeq(
 *   step('planner'),
 *   step('executor').from('planner'),
 *   step('verifier').from('executor')
 * )
 * ```
 */
export function simpleSeq(...steps: FlowSpec[]): SeqSpec {
  // Process steps to set initial input for first step if not specified
  const processedSteps = steps.map((step, index) => {
    if (index === 0 && step.kind === 'invoke') {
      const invokeStep = step as InvokeSpec
      // If first step has no input specified (using prev), change to initial
      if (invokeStep.input.ref === 'prev') {
        return {
          ...invokeStep,
          input: { ref: 'initial' as const }
        }
      }
    }
    return step
  })

  return {
    kind: 'seq',
    steps: processedSteps
  }
}

// ============================================================================
// Loop Helper
// ============================================================================

export interface SimpleLoopConfig {
  /** Body to execute */
  body: FlowSpec
  /** Until condition (return true to stop) - receives state as unknown */
  until: (state: unknown) => boolean
  /** Maximum iterations */
  maxIterations: number
}

/**
 * Create a loop that executes until a condition is met.
 *
 * @param config - Loop configuration
 *
 * @example
 * ```typescript
 * simpleLoop({
 *   body: simpleSeq(
 *     step('improver').from('draft'),
 *     step('reviewer').from('improver').to('review')
 *   ),
 *   until: (s) => s.review?.approved === true,
 *   maxIterations: 3
 * })
 * ```
 */
export function simpleLoop(config: SimpleLoopConfig): FlowSpec {
  return {
    kind: 'loop',
    body: config.body,
    until: {
      type: 'predicate',
      predicate: {
        op: 'custom' as any,
        check: config.until
      }
    } as any,  // Custom predicate - executor handles function-based until
    maxIters: config.maxIterations
  }
}

// ============================================================================
// Select Helper
// ============================================================================

export interface SimpleSelectConfig {
  /** Selector function - returns branch key, receives state as unknown */
  select: (state: unknown) => string
  /** Branches keyed by selector return value */
  branches: Record<string, FlowSpec>
  /** Default branch if selector returns unknown key */
  default?: FlowSpec
}

/**
 * Create a multi-way branch based on a selector function.
 *
 * @param config - Select configuration
 *
 * @example
 * ```typescript
 * simpleSelect({
 *   select: (s) => s.task?.type ?? 'unknown',
 *   branches: {
 *     'bug': step('bugfixer'),
 *     'feature': step('developer'),
 *     'docs': step('writer')
 *   },
 *   default: step('triager')
 * })
 * ```
 */
export function simpleSelect(config: SimpleSelectConfig): FlowSpec {
  return {
    kind: 'select',
    selector: config.select,
    branches: config.branches,
    default: config.default
  }
}

// ============================================================================
// Parallel Helper
// ============================================================================

export interface SimpleParConfig {
  /** Branches to execute in parallel */
  branches: FlowSpec[]
  /** How to combine results */
  reduce?: 'merge' | 'collect' | 'first'
  /** Output path */
  to?: string
}

/**
 * Execute multiple branches in parallel.
 *
 * @param config - Parallel configuration
 *
 * @example
 * ```typescript
 * simplePar({
 *   branches: [
 *     step('researcher1').from('topic'),
 *     step('researcher2').from('topic'),
 *     step('researcher3').from('topic')
 *   ],
 *   reduce: 'merge',
 *   to: 'research'
 * })
 * ```
 */
export function simplePar(config: SimpleParConfig): FlowSpec {
  const { branches, reduce = 'collect', to } = config

  return {
    kind: 'par',
    branches,
    join: {
      reducerId: reduce,
      outputAs: to ? { path: to } : undefined
    }
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function resolveSimpleSource(
  source: string | ((state: Record<string, unknown>) => unknown)
): InputRef {
  if (typeof source === 'function') {
    // Transform function - create mapped input ref
    return {
      ref: 'mapped' as any,
      source: { ref: 'state', path: '' },  // Full state
      transform: source
    } as any
  }

  if (source === 'initial') {
    return { ref: 'initial' }
  }

  if (source === 'prev') {
    return { ref: 'prev' }
  }

  // State path
  return { ref: 'state', path: source }
}

// ============================================================================
// Convenience Re-export
// ============================================================================

// Allow using simpleStep as just 'step' via named import
export { simpleStep as step }
