/**
 * Structured LLM Output - Contract-First LLM Calls
 *
 * Provides type-safe structured output generation using AI SDK's Output.object.
 * This is the foundation for contract-first agent communication.
 */

import { generateText, Output, type LanguageModelV1, type CoreMessage } from 'ai'
import { type ZodSchema, ZodError } from 'zod'
import type { TokenUsage } from './provider.types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Trace event for observability
 */
export interface StructuredTraceEvent {
  type:
    | 'structured.call.start'
    | 'structured.call.ok'
    | 'structured.call.fail'
    | 'structured.call.retry'
  timestamp: number
  attempt: number
  schemaName?: string
  error?: string
  durationMs?: number
  usage?: TokenUsage
}

/**
 * Repair strategy for failed structured output
 */
export interface RepairStrategy {
  /**
   * Generate repair instructions based on the error
   * @param error - The error that occurred (ZodError or other)
   * @param rawText - The raw text that failed to parse (if available)
   * @returns Modified prompt/system to retry with
   */
  repair: (error: unknown, rawText?: string) => {
    system?: string
    prompt?: string
    messages?: CoreMessage[]
  }
}

/**
 * Options for generateStructured
 */
export interface GenerateStructuredOptions<T> {
  /** Language model to use */
  model: LanguageModelV1

  /** System prompt */
  system?: string

  /** User prompt (simple case) */
  prompt?: string

  /** Message history (complex case) */
  messages?: CoreMessage[]

  /** Zod schema for output validation */
  schema: ZodSchema<T>

  /** Optional name for the schema (used in prompts) */
  schemaName?: string

  /** Optional description for the schema */
  schemaDescription?: string

  /** Temperature (0-1) */
  temperature?: number

  /** Max tokens to generate */
  maxTokens?: number

  /** Number of retries on failure (default: 1) */
  retries?: number

  /** Custom repair strategy */
  repairStrategy?: RepairStrategy

  /** Trace callback for observability */
  onTrace?: (event: StructuredTraceEvent) => void

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
}

/**
 * Result of generateStructured
 */
export interface GenerateStructuredResult<T> {
  /** The validated output object */
  output: T

  /** Token usage statistics */
  usage: TokenUsage

  /** Number of attempts made */
  attempts: number

  /** Total duration in milliseconds */
  durationMs: number
}

// ============================================================================
// Default Repair Strategy
// ============================================================================

/**
 * Default repair strategy that adds schema validation feedback to the prompt
 */
export const defaultRepairStrategy: RepairStrategy = {
  repair: (error: unknown, rawText?: string) => {
    let errorMessage = 'Unknown error'

    if (error instanceof ZodError) {
      // Format Zod errors in a helpful way
      const issues = error.issues.map((issue) => {
        const path = issue.path.join('.')
        return `- ${path ? `"${path}": ` : ''}${issue.message}`
      })
      errorMessage = `Schema validation failed:\n${issues.join('\n')}`
    } else if (error instanceof Error) {
      errorMessage = error.message
    }

    const repairPrompt = rawText
      ? `Your previous response was:\n\`\`\`\n${rawText.slice(0, 500)}${rawText.length > 500 ? '...' : ''}\n\`\`\`\n\n${errorMessage}\n\nPlease provide a corrected response that matches the required schema.`
      : `${errorMessage}\n\nPlease provide a response that matches the required schema.`

    return { prompt: repairPrompt }
  }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Generate structured output from an LLM with schema validation.
 *
 * Uses AI SDK's Output.object for structured output generation,
 * which instructs the model to generate data matching the schema.
 *
 * @example
 * ```typescript
 * const result = await generateStructured({
 *   model: openai('gpt-4o'),
 *   system: 'You are a helpful assistant.',
 *   prompt: 'Extract the person info from: John Doe, 30 years old',
 *   schema: z.object({
 *     name: z.string(),
 *     age: z.number()
 *   }),
 *   schemaName: 'PersonInfo'
 * })
 *
 * console.log(result.output.name) // "John Doe"
 * console.log(result.output.age)  // 30
 * ```
 */
export async function generateStructured<T>(
  options: GenerateStructuredOptions<T>
): Promise<GenerateStructuredResult<T>> {
  const {
    model,
    system,
    prompt,
    messages,
    schema,
    schemaName,
    // schemaDescription is kept in options for future AI SDK versions that may support it
    temperature,
    maxTokens,
    retries = 1,
    repairStrategy = defaultRepairStrategy,
    onTrace,
    abortSignal
  } = options

  const startTime = Date.now()
  let lastError: unknown
  let lastRawText: string | undefined
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  // Build initial messages
  let currentPrompt = prompt
  let currentMessages = messages
  let currentSystem = system

  for (let attempt = 0; attempt <= retries; attempt++) {
    const attemptStart = Date.now()

    onTrace?.({
      type: 'structured.call.start',
      timestamp: attemptStart,
      attempt,
      schemaName
    })

    try {
      // Check for abort
      if (abortSignal?.aborted) {
        throw new Error('Operation aborted')
      }

      const result = await generateText({
        model,
        system: currentSystem,
        prompt: currentPrompt,
        messages: currentMessages,
        temperature,
        maxTokens,
        abortSignal,
        // AI SDK structured output - validates automatically
        experimental_output: Output.object({ schema })
      })

      // Accumulate usage
      if (result.usage) {
        totalUsage.promptTokens += result.usage.promptTokens
        totalUsage.completionTokens += result.usage.completionTokens
        totalUsage.totalTokens += result.usage.totalTokens
      }

      // The output is already validated by AI SDK
      const output = result.experimental_output as T

      const durationMs = Date.now() - attemptStart

      onTrace?.({
        type: 'structured.call.ok',
        timestamp: Date.now(),
        attempt,
        schemaName,
        durationMs,
        usage: result.usage
          ? {
              promptTokens: result.usage.promptTokens,
              completionTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens
            }
          : undefined
      })

      return {
        output,
        usage: totalUsage,
        attempts: attempt + 1,
        durationMs: Date.now() - startTime
      }
    } catch (error) {
      lastError = error
      lastRawText = undefined // AI SDK doesn't expose raw text on error

      const durationMs = Date.now() - attemptStart

      onTrace?.({
        type: 'structured.call.fail',
        timestamp: Date.now(),
        attempt,
        schemaName,
        error: error instanceof Error ? error.message : String(error),
        durationMs
      })

      // Don't retry on abort
      if (abortSignal?.aborted) {
        break
      }

      // Don't retry if this was the last attempt
      if (attempt >= retries) {
        break
      }

      // Apply repair strategy for next attempt
      const repair = repairStrategy.repair(error, lastRawText)

      onTrace?.({
        type: 'structured.call.retry',
        timestamp: Date.now(),
        attempt: attempt + 1,
        schemaName
      })

      // Update for next attempt
      if (repair.system !== undefined) currentSystem = repair.system
      if (repair.prompt !== undefined) currentPrompt = repair.prompt
      if (repair.messages !== undefined) currentMessages = repair.messages
    }
  }

  // All retries exhausted
  throw new StructuredOutputError(
    `Failed to generate structured output after ${retries + 1} attempts`,
    lastError,
    schemaName
  )
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when structured output generation fails
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly schemaName?: string
  ) {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a trace callback that logs to console
 */
export function createConsoleTracer(prefix = '[structured]'): (event: StructuredTraceEvent) => void {
  return (event) => {
    const time = new Date(event.timestamp).toISOString()
    switch (event.type) {
      case 'structured.call.start':
        console.log(`${prefix} ${time} Starting call (attempt ${event.attempt + 1})${event.schemaName ? ` for ${event.schemaName}` : ''}`)
        break
      case 'structured.call.ok':
        console.log(`${prefix} ${time} Call succeeded in ${event.durationMs}ms${event.usage ? ` (${event.usage.totalTokens} tokens)` : ''}`)
        break
      case 'structured.call.fail':
        console.log(`${prefix} ${time} Call failed: ${event.error}`)
        break
      case 'structured.call.retry':
        console.log(`${prefix} ${time} Retrying (attempt ${event.attempt + 1})`)
        break
    }
  }
}

/**
 * Combine multiple trace callbacks
 */
export function combineTracers(
  ...tracers: Array<((event: StructuredTraceEvent) => void) | undefined>
): (event: StructuredTraceEvent) => void {
  const validTracers = tracers.filter(Boolean) as Array<(event: StructuredTraceEvent) => void>
  return (event) => {
    for (const tracer of validTracers) {
      tracer(event)
    }
  }
}
