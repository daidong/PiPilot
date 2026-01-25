/**
 * defineLLMAgent - LLM Agent Definition Factory
 *
 * Creates type-safe LLM agents that:
 * - Accept typed input (validated with Zod)
 * - Return typed output (validated with AI SDK structured output)
 * - Don't require tools infrastructure
 * - Work natively with the team system
 */

import { type ZodSchema } from 'zod'
import type { LanguageModelV1 } from 'ai'
import {
  generateStructured,
  type GenerateStructuredResult,
  type StructuredTraceEvent
} from '../llm/structured.js'
import type { TokenUsage } from '../llm/provider.types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context provided to LLM agents during execution
 */
export interface LLMAgentContext {
  /** Get a language model by ID (or default if not specified) */
  getLanguageModel: (modelId?: string) => LanguageModelV1

  /** Trace callback for observability */
  trace?: (event: StructuredTraceEvent) => void

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal

  /** Runtime metadata */
  metadata?: {
    teamId?: string
    runId?: string
    stepIndex?: number
  }
}

/**
 * Result of LLM agent execution
 */
export interface LLMAgentResult<T> {
  /** The validated output */
  output: T

  /** Token usage statistics */
  usage: TokenUsage

  /** Total duration in milliseconds */
  durationMs: number

  /** Number of LLM call attempts */
  attempts: number
}

/**
 * LLM Agent definition options
 */
export interface LLMAgentDefinition<TInput, TOutput> {
  /** Unique agent ID */
  id: string

  /** Human-readable description */
  description?: string

  /** Model ID to use (overrides context default) */
  model?: string

  /** Temperature (0-1) */
  temperature?: number

  /** Max tokens to generate */
  maxTokens?: number

  /** Number of retries on failure */
  retries?: number

  /** Input schema for validation */
  inputSchema: ZodSchema<TInput>

  /** Output schema for structured generation */
  outputSchema: ZodSchema<TOutput>

  /** System prompt */
  system: string

  /**
   * Build the user prompt from validated input
   * @param input - Validated input object
   * @returns User prompt string
   */
  buildPrompt: (input: TInput) => string

  /**
   * Optional pre-processing hook
   * Transform input before prompt building
   */
  preProcess?: (input: TInput) => TInput | Promise<TInput>

  /**
   * Optional post-processing hook
   * Transform output after LLM generation
   */
  postProcess?: (output: TOutput, input: TInput) => TOutput | Promise<TOutput>
}

/**
 * LLM Agent instance
 */
export interface LLMAgent<TInput, TOutput> {
  /** Agent ID */
  readonly id: string

  /** Agent kind discriminator (for type checking) */
  readonly kind: 'llm-agent'

  /** Human-readable description */
  readonly description?: string

  /** Input schema */
  readonly inputSchema: ZodSchema<TInput>

  /** Output schema */
  readonly outputSchema: ZodSchema<TOutput>

  /**
   * Run the agent with typed input
   * @param input - Input object (will be validated)
   * @param ctx - Agent context
   * @returns Typed output result
   */
  run: (input: TInput, ctx: LLMAgentContext) => Promise<LLMAgentResult<TOutput>>
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define an LLM agent with typed input/output.
 *
 * LLM agents are simpler than full agents - they don't have tools,
 * just input → LLM → output with schema validation.
 *
 * @example
 * ```typescript
 * const summarizer = defineLLMAgent({
 *   id: 'summarizer',
 *   inputSchema: z.object({
 *     text: z.string(),
 *     maxLength: z.number().optional()
 *   }),
 *   outputSchema: z.object({
 *     summary: z.string(),
 *     keyPoints: z.array(z.string())
 *   }),
 *   system: 'You are a text summarizer.',
 *   buildPrompt: ({ text, maxLength }) =>
 *     `Summarize the following text${maxLength ? ` in ${maxLength} words or less` : ''}:\n\n${text}`
 * })
 *
 * const result = await summarizer.run(
 *   { text: 'Long article...', maxLength: 100 },
 *   { getLanguageModel: () => openai('gpt-4o') }
 * )
 *
 * console.log(result.output.summary)
 * console.log(result.output.keyPoints)
 * ```
 */
export function defineLLMAgent<TInput, TOutput>(
  definition: LLMAgentDefinition<TInput, TOutput>
): LLMAgent<TInput, TOutput> {
  const {
    id,
    description,
    model: modelId,
    temperature,
    maxTokens,
    retries,
    inputSchema,
    outputSchema,
    system,
    buildPrompt,
    preProcess,
    postProcess
  } = definition

  return {
    id,
    kind: 'llm-agent',
    description,
    inputSchema,
    outputSchema,

    async run(input: TInput, ctx: LLMAgentContext): Promise<LLMAgentResult<TOutput>> {
      const startTime = Date.now()

      // 1. Validate input
      const validatedInput = inputSchema.parse(input)

      // 2. Optional pre-processing
      const processedInput = preProcess
        ? await preProcess(validatedInput)
        : validatedInput

      // 3. Build prompt
      const prompt = buildPrompt(processedInput)

      // 4. Get language model
      const model = ctx.getLanguageModel(modelId)

      // 5. Call LLM with structured output
      const result: GenerateStructuredResult<TOutput> = await generateStructured({
        model,
        system,
        prompt,
        schema: outputSchema,
        schemaName: `${id}Output`,
        temperature,
        maxTokens,
        retries,
        onTrace: ctx.trace,
        abortSignal: ctx.abortSignal
      })

      // 6. Optional post-processing
      const finalOutput = postProcess
        ? await postProcess(result.output, processedInput)
        : result.output

      return {
        output: finalOutput,
        usage: result.usage,
        durationMs: Date.now() - startTime,
        attempts: result.attempts
      }
    }
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is an LLM agent
 */
export function isLLMAgent(value: unknown): value is LLMAgent<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'llm-agent' &&
    'id' in value &&
    'inputSchema' in value &&
    'outputSchema' in value &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  )
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Create a simple context for standalone agent execution
 */
export function createSimpleLLMAgentContext(
  getLanguageModel: (modelId?: string) => LanguageModelV1,
  options?: {
    trace?: (event: StructuredTraceEvent) => void
    abortSignal?: AbortSignal
  }
): LLMAgentContext {
  return {
    getLanguageModel,
    trace: options?.trace,
    abortSignal: options?.abortSignal
  }
}

/**
 * Create a context with a specific model
 */
export function createModelContext(
  model: LanguageModelV1,
  options?: {
    trace?: (event: StructuredTraceEvent) => void
    abortSignal?: AbortSignal
  }
): LLMAgentContext {
  return {
    getLanguageModel: () => model,
    trace: options?.trace,
    abortSignal: options?.abortSignal
  }
}
