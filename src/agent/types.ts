/**
 * Unified Agent Types - Contract-First Agent Interface
 *
 * Provides a unified interface for all agent types (LLM, Tool, Custom),
 * enabling composable patterns without type casts.
 */

import { type ZodSchema } from 'zod'
import type { TokenUsage } from '../llm/provider.types.js'

// ============================================================================
// Core Agent Interface
// ============================================================================

/**
 * Unified agent result that all agent types return.
 * Provides a consistent interface for flow composition.
 */
export interface AgentResult<TOutput> {
  /** The validated output */
  output: TOutput

  /** Whether the execution was successful */
  success: boolean

  /** Error message if failed */
  error?: string

  /** Total duration in milliseconds */
  durationMs: number

  /** Token usage (for LLM agents) */
  usage?: TokenUsage

  /** Number of attempts (for LLM agents with retries) */
  attempts?: number
}

/**
 * Base context fields shared by all agent types
 */
export interface BaseAgentContext {
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal

  /** Runtime metadata */
  metadata?: {
    teamId?: string
    runId?: string
    stepIndex?: number
    parentStepId?: string
  }
}

/**
 * Unified agent interface that all agent types implement.
 * This enables composable patterns without type casts.
 *
 * @template TInput - The input type (validated with Zod)
 * @template TOutput - The output type (validated with Zod)
 * @template TContext - The context type (extends BaseAgentContext)
 */
export interface Agent<TInput = unknown, TOutput = unknown, TContext extends BaseAgentContext = BaseAgentContext> {
  /** Unique agent ID */
  readonly id: string

  /** Agent kind discriminator */
  readonly kind: AgentKind

  /** Human-readable description */
  readonly description?: string

  /** Input schema for validation */
  readonly inputSchema: ZodSchema<TInput>

  /** Output schema for validation */
  readonly outputSchema: ZodSchema<TOutput>

  /**
   * Run the agent with typed input.
   * All agent types return the same AgentResult structure.
   *
   * @param input - Input object (will be validated)
   * @param ctx - Agent context (type varies by agent kind)
   * @returns Unified agent result
   */
  run(input: TInput, ctx: TContext): Promise<AgentResult<TOutput>>
}

/**
 * Agent kind discriminator for runtime type checking
 */
export type AgentKind = 'llm-agent' | 'tool-agent' | 'custom-agent'

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value implements the Agent interface
 */
export function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'kind' in value &&
    'inputSchema' in value &&
    'outputSchema' in value &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  )
}

/**
 * Check if an agent is an LLM agent
 */
export function isLLMAgentKind(agent: Agent): boolean {
  return agent.kind === 'llm-agent'
}

/**
 * Check if an agent is a tool agent
 */
export function isToolAgentKind(agent: Agent): boolean {
  return agent.kind === 'tool-agent'
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract input type from an agent
 */
export type AgentInput<T extends Agent<unknown, unknown, BaseAgentContext>> = T extends Agent<infer TInput, unknown, BaseAgentContext> ? TInput : never

/**
 * Extract output type from an agent
 */
export type AgentOutput<T extends Agent<unknown, unknown, BaseAgentContext>> = T extends Agent<unknown, infer TOutput, BaseAgentContext> ? TOutput : never

/**
 * Any agent type (for use in collections/registries)
 */
export type AnyAgent = Agent<unknown, unknown, BaseAgentContext>

/**
 * Create a successful agent result
 */
export function successResult<T>(
  output: T,
  options: {
    durationMs: number
    usage?: TokenUsage
    attempts?: number
  }
): AgentResult<T> {
  return {
    output,
    success: true,
    durationMs: options.durationMs,
    usage: options.usage,
    attempts: options.attempts
  }
}

/**
 * Create a failed agent result
 */
export function failureResult<T>(
  error: string,
  durationMs: number
): AgentResult<T> {
  return {
    output: undefined as unknown as T,
    success: false,
    error,
    durationMs
  }
}
