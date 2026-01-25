/**
 * Step Builder - Fluent API for Flow Definition
 *
 * Provides a type-safe, fluent API for defining flow steps:
 *   step(agent).in(input).out(statePath)
 *
 * This keeps the flow definition readable and enables compile-time
 * type checking between agent input/output and state paths.
 */

import type { ZodSchema } from 'zod'
import type { InvokeSpec, InputRef, StateRef, TransferSpec } from './ast.js'
import type { Agent, BaseAgentContext } from '../../agent/types.js'
import type {
  TypedInputRef,
  TypedStateRef
} from '../state/typed-blackboard.js'
import type { MappedInputRef } from './edges.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal agent interface for custom agents that don't use Zod schemas.
 * Provides backward compatibility for simple agent implementations.
 */
export interface MinimalAgent<TInput, TOutput> {
  id: string
  kind: string
  inputSchema?: ZodSchema<TInput>
  outputSchema?: ZodSchema<TOutput>
  run: (input: TInput, ctx: unknown) => Promise<{ output: TOutput; [key: string]: unknown }>
}

/**
 * Agent type that can be used with step builder.
 * Accepts:
 * - Unified Agent interface (LLMAgent, ToolAgent)
 * - Minimal agent implementations for backward compatibility
 */
export type StepAgent<TInput, TOutput> =
  | Agent<TInput, TOutput, BaseAgentContext>
  | MinimalAgent<TInput, TOutput>

/**
 * Input types accepted by step builder
 */
export type StepInput<T> =
  | TypedInputRef<T>
  | MappedInputRef<unknown, T>
  | InputRef

/**
 * Step specification with schema information
 */
export interface TypedInvokeSpec<TInput = unknown, TOutput = unknown> extends InvokeSpec {
  /** Input schema (for validation) */
  _inputSchema?: ZodSchema<TInput>
  /** Output schema (for validation) */
  _outputSchema?: ZodSchema<TOutput>
}

/**
 * Step builder - first stage (agent selected, waiting for input)
 */
export interface StepBuilderWithAgent<TInput, TOutput> {
  /**
   * Specify the input for this step
   *
   * @example
   * ```typescript
   * step(agent).in(state.initial())
   * step(agent).in(state.path('plan'))
   * step(agent).in(mapInput(state.path('plan'), p => ({ query: p.searchQueries })))
   * ```
   */
  in<TIn extends TInput>(
    input: TypedStateRef<TIn>
  ): StepBuilderWithInput<TIn, TOutput>

  in<TIn extends TInput>(
    input: MappedInputRef<unknown, TIn>
  ): StepBuilderWithInput<TIn, TOutput>

  in(input: InputRef): StepBuilderWithInput<TInput, TOutput>

  in<TIn extends TInput>(
    input: StepInput<TIn>
  ): StepBuilderWithInput<TIn, TOutput>
}

/**
 * Step builder - second stage (input specified, can set output or build)
 */
export interface StepBuilderWithInput<TInput, TOutput> {
  /**
   * Specify where to store the output in state
   *
   * @example
   * ```typescript
   * step(agent).in(input).out(state.path('result'))
   * ```
   */
  out(statePath: TypedStateRef<TOutput>): TypedInvokeSpec<TInput, TOutput>

  out(statePath: StateRef): TypedInvokeSpec<TInput, TOutput>

  /**
   * Build without storing output (output passed to next step via prev())
   */
  build(): TypedInvokeSpec<TInput, TOutput>

  /**
   * Add context transfer options
   */
  transfer(spec: TransferSpec): StepBuilderWithInput<TInput, TOutput>

  /**
   * Add name for debugging
   */
  name(name: string): StepBuilderWithInput<TInput, TOutput>

  /**
   * Add tags for filtering
   */
  tags(...tags: string[]): StepBuilderWithInput<TInput, TOutput>
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a step builder for the given agent.
 *
 * The step builder provides a fluent API for defining flow steps
 * that is type-safe and readable.
 *
 * @example
 * ```typescript
 * // Basic usage
 * step(planner).in(state.initial()).out(state.path('plan'))
 *
 * // With input transformation
 * step(searcher)
 *   .in(mapInput(state.path('plan'), plan => ({
 *     queries: plan.searchQueries,
 *     sources: plan.searchStrategy.suggestedSources
 *   })))
 *   .out(state.path('search'))
 *
 * // Without output storage (uses prev())
 * step(validator).in(state.path('data')).build()
 *
 * // With additional options
 * step(agent)
 *   .in(input)
 *   .name('Process Data')
 *   .tags('processing', 'core')
 *   .out(state.path('result'))
 * ```
 */
export function step<TInput, TOutput>(
  agent: StepAgent<TInput, TOutput>
): StepBuilderWithAgent<TInput, TOutput> {
  return {
    in(input: StepInput<TInput>): StepBuilderWithInput<TInput, TOutput> {
      return createStepBuilderWithInput(agent, input)
    }
  } as StepBuilderWithAgent<TInput, TOutput>
}

/**
 * Create the second stage builder
 */
function createStepBuilderWithInput<TInput, TOutput>(
  agent: StepAgent<TInput, TOutput>,
  input: StepInput<TInput>,
  options: {
    transfer?: TransferSpec
    name?: string
    tags?: string[]
  } = {}
): StepBuilderWithInput<TInput, TOutput> {
  const resolvedInput = resolveInput(input)

  return {
    out(statePath: TypedStateRef<TOutput> | StateRef): TypedInvokeSpec<TInput, TOutput> {
      const outputAs = 'type' in statePath && statePath.type === 'typed-state-ref'
        ? { path: (statePath as TypedStateRef<TOutput>).path }
        : statePath as StateRef

      return {
        kind: 'invoke',
        agent: agent.id,
        input: resolvedInput,
        outputAs,
        transfer: options.transfer,
        name: options.name,
        tags: options.tags,
        _inputSchema: 'inputSchema' in agent ? agent.inputSchema : undefined,
        _outputSchema: 'outputSchema' in agent ? agent.outputSchema : undefined
      }
    },

    build(): TypedInvokeSpec<TInput, TOutput> {
      return {
        kind: 'invoke',
        agent: agent.id,
        input: resolvedInput,
        transfer: options.transfer,
        name: options.name,
        tags: options.tags,
        _inputSchema: 'inputSchema' in agent ? agent.inputSchema : undefined,
        _outputSchema: 'outputSchema' in agent ? agent.outputSchema : undefined
      }
    },

    transfer(spec: TransferSpec): StepBuilderWithInput<TInput, TOutput> {
      return createStepBuilderWithInput(agent, input, { ...options, transfer: spec })
    },

    name(name: string): StepBuilderWithInput<TInput, TOutput> {
      return createStepBuilderWithInput(agent, input, { ...options, name })
    },

    tags(...tags: string[]): StepBuilderWithInput<TInput, TOutput> {
      return createStepBuilderWithInput(agent, input, { ...options, tags })
    }
  }
}

/**
 * Resolve a step input to a flow InputRef
 */
function resolveInput<T>(input: StepInput<T>): InputRef {
  if ('type' in input) {
    switch (input.type) {
      case 'typed-state-ref':
        return { ref: 'state', path: input.path }

      case 'typed-initial-ref':
        return { ref: 'initial' }

      case 'typed-prev-ref':
        return { ref: 'prev' }

      case 'typed-const-ref':
        return { ref: 'const', value: input.value }

      case 'mapped-input-ref':
        // For mapped inputs, we store the transform and resolve at execution time
        // The executor will need to handle this specially
        return {
          ref: 'mapped' as any,
          source: resolveInput(input.source as StepInput<unknown>),
          transform: input.transform
        } as any
    }
  }

  // Already an InputRef
  return input as InputRef
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a typed invoke spec
 */
export function isTypedInvokeSpec(value: unknown): value is TypedInvokeSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'invoke'
  )
}

/**
 * Check if an invoke spec has schema information
 */
export function hasSchemaInfo(spec: InvokeSpec): spec is TypedInvokeSpec {
  return '_inputSchema' in spec || '_outputSchema' in spec
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Create a step that just passes through data (identity agent)
 * Useful for data routing without transformation
 */
export function passthrough<T>(
  inputPath: TypedStateRef<T>,
  outputPath: TypedStateRef<T>
): TypedInvokeSpec<T, T> {
  return {
    kind: 'invoke',
    agent: '__passthrough__',
    input: { ref: 'state', path: inputPath.path },
    outputAs: { path: outputPath.path }
  }
}

/**
 * Create multiple steps from a list of agents
 * Each step uses prev() as input
 */
export function pipeline<T>(
  agents: Array<StepAgent<T, T>>,
  initialInput: StepInput<T>,
  finalOutput?: TypedStateRef<T>
): TypedInvokeSpec<T, T>[] {
  if (agents.length === 0) return []

  const steps: TypedInvokeSpec<T, T>[] = []

  // First agent uses the provided initial input
  const firstAgent = agents[0]!
  steps.push(
    step(firstAgent).in(initialInput).build()
  )

  // Middle agents use prev()
  for (let i = 1; i < agents.length - 1; i++) {
    const agent = agents[i]!
    steps.push(
      step(agent).in({ type: 'typed-prev-ref' } as StepInput<T>).build()
    )
  }

  // Last agent optionally outputs to state
  if (agents.length > 1) {
    const lastAgent = agents[agents.length - 1]!
    if (finalOutput) {
      steps.push(
        step(lastAgent).in({ type: 'typed-prev-ref' } as StepInput<T>).out(finalOutput)
      )
    } else {
      steps.push(
        step(lastAgent).in({ type: 'typed-prev-ref' } as StepInput<T>).build()
      )
    }
  } else if (finalOutput) {
    // Only one agent, update the first step to include output
    steps[0] = step(agents[0]!).in(initialInput).out(finalOutput)
  }

  return steps
}
