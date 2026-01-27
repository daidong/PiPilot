/**
 * defineAgent - Schema-Free Agent Definition
 *
 * Creates agents without requiring Zod schemas.
 * Uses JSON output mode for structured communication while
 * maintaining flexibility in input/output shapes.
 *
 * @example
 * ```typescript
 * const researcher = defineAgent({
 *   id: 'researcher',
 *   system: `You are a research assistant.
 *
 * Output JSON:
 * { "findings": [...], "recommendation": "string" }`,
 *   prompt: (input) => `Research: ${input.topic ?? input}`
 * })
 * ```
 */

import { generateText, type LanguageModel } from 'ai'
import type { TokenUsage } from '../llm/provider.types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Base context fields shared by all agents
 */
export interface AgentContext {
  /** Get a language model by ID (or default if not specified) */
  getLanguageModel: (modelId?: string) => LanguageModel
  /** Trace callback */
  trace?: (event: AgentTraceEvent) => void
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
 * Trace events for agents
 */
export type AgentTraceEvent =
  | { type: 'agent.call.start'; agentId: string; ts: number }
  | { type: 'agent.call.end'; agentId: string; ts: number; success: boolean; error?: string }
  | { type: 'agent.retry'; agentId: string; ts: number; attempt: number; error: string }

/**
 * Result of agent execution
 */
export interface AgentResult<T = unknown> {
  /** The output (parsed JSON or text) */
  output: T
  /** Whether the execution was successful */
  success: boolean
  /** Error message if failed */
  error?: string
  /** Total duration in milliseconds */
  durationMs: number
  /** Token usage statistics */
  usage: TokenUsage
  /** Number of attempts */
  attempts: number
  /** Raw text output (before JSON parsing) */
  rawOutput?: string
}

/**
 * Agent definition options
 */
export interface AgentDefinition {
  /** Unique agent ID */
  id: string

  /** Human-readable description */
  description?: string

  /** Model ID to use (overrides context default) */
  model?: string

  /** Temperature (0-1, default: 0.7) */
  temperature?: number

  /** Max tokens to generate */
  maxTokens?: number

  /** System prompt - describe expected JSON structure here */
  system: string

  /**
   * Build the user prompt from input
   * Input can be any type - use optional chaining for safe access
   */
  prompt: (input: unknown) => string

  /**
   * Configuration options
   */
  config?: {
    /** Use JSON output mode (default: true) */
    jsonMode?: boolean
    /** Max retries on parse failure (default: 2) */
    maxRetries?: number
  }

  /**
   * Optional pre-processing hook
   */
  preProcess?: (input: unknown) => unknown | Promise<unknown>

  /**
   * Optional post-processing hook
   */
  postProcess?: (output: unknown, input: unknown) => unknown | Promise<unknown>
}

/**
 * Agent instance (schema-free)
 *
 * Agents use JSON output mode and prompt engineering for
 * structured communication, without requiring Zod schemas.
 */
export interface Agent {
  /** Unique agent ID */
  readonly id: string

  /** Agent kind discriminator */
  readonly kind: 'agent'

  /** Human-readable description */
  readonly description?: string

  /**
   * Run the agent with untyped input
   * @param input - Any input (object, string, etc.)
   * @param ctx - Agent context
   * @returns Result with parsed output
   */
  run: (input: unknown, ctx: AgentContext) => Promise<AgentResult>
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a schema-free agent.
 *
 * Agents use JSON output mode and prompt engineering to get
 * structured output. This significantly reduces boilerplate
 * while maintaining object-based I/O.
 *
 * @example
 * ```typescript
 * const reviewer = defineAgent({
 *   id: 'reviewer',
 *   system: `You are a quality reviewer.
 *
 * Output JSON:
 * {
 *   "approved": boolean,
 *   "feedback": "string",
 *   "score": number (1-10)
 * }`,
 *   prompt: (input) => `Review this:\n\n${format(input)}`
 * })
 *
 * const result = await reviewer.run(
 *   { content: 'Some content to review' },
 *   { getLanguageModel: () => openai('gpt-4o') }
 * )
 *
 * // Access output with optional chaining
 * if (result.output?.approved) {
 *   console.log('Approved!')
 * }
 * ```
 */
export function defineAgent(definition: AgentDefinition): Agent {
  const {
    id,
    description,
    model: modelId,
    temperature = 0.7,
    maxTokens,
    system,
    prompt: buildPrompt,
    config = {},
    preProcess,
    postProcess
  } = definition

  const { jsonMode = true, maxRetries = 2 } = config

  return {
    id,
    kind: 'agent',
    description,

    async run(input: unknown, ctx: AgentContext): Promise<AgentResult> {
      const startTime = Date.now()
      let attempts = 0
      let lastError: Error | undefined

      ctx.trace?.({
        type: 'agent.call.start',
        agentId: id,
        ts: startTime
      })

      // Pre-process input if hook provided
      const processedInput = preProcess ? await preProcess(input) : input

      // Build prompt
      const userPrompt = buildPrompt(processedInput)

      // Get language model
      const model = ctx.getLanguageModel(modelId)

      // Retry loop
      while (attempts <= maxRetries) {
        attempts++

        try {
          // Call LLM (SDK 6: maxOutputTokens instead of maxTokens)
          const result = await generateText({
            model,
            system,
            prompt: userPrompt,
            temperature,
            maxOutputTokens: maxTokens,
            // Use JSON mode if enabled (OpenAI/compatible models)
            ...(jsonMode && {
              response_format: { type: 'json_object' as const }
            }),
            abortSignal: ctx.abortSignal
          })

          const rawText = result.text

          // Parse JSON output
          let output: unknown
          if (jsonMode) {
            try {
              output = JSON.parse(rawText)
            } catch (parseError) {
              // If JSON parsing fails, try to extract JSON from the text
              const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/) ||
                               rawText.match(/```\s*([\s\S]*?)```/) ||
                               rawText.match(/\{[\s\S]*\}/)

              if (jsonMatch) {
                const jsonStr = jsonMatch[1] || jsonMatch[0]
                output = JSON.parse(jsonStr.trim())
              } else {
                throw new Error(`Failed to parse JSON output: ${parseError}`)
              }
            }
          } else {
            // Non-JSON mode: return text as-is
            output = rawText
          }

          // Post-process output if hook provided
          const finalOutput = postProcess ? await postProcess(output, processedInput) : output

          // SDK 6: inputTokens/outputTokens instead of promptTokens/completionTokens
          const inputTokens = result.usage?.inputTokens ?? 0
          const outputTokens = result.usage?.outputTokens ?? 0
          const usage: TokenUsage = {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens
          }

          ctx.trace?.({
            type: 'agent.call.end',
            agentId: id,
            ts: Date.now(),
            success: true
          })

          return {
            output: finalOutput,
            success: true,
            usage,
            durationMs: Date.now() - startTime,
            attempts,
            rawOutput: rawText
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          if (attempts <= maxRetries) {
            ctx.trace?.({
              type: 'agent.retry',
              agentId: id,
              ts: Date.now(),
              attempt: attempts,
              error: lastError.message
            })
          }
        }
      }

      // All retries failed
      ctx.trace?.({
        type: 'agent.call.end',
        agentId: id,
        ts: Date.now(),
        success: false,
        error: lastError?.message
      })

      return {
        output: undefined,
        success: false,
        error: lastError?.message ?? 'Unknown error',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - startTime,
        attempts
      }
    }
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is an agent
 */
export function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'agent' &&
    'id' in value &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  )
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Create a context for standalone agent execution
 */
export function createAgentContext(
  getLanguageModel: (modelId?: string) => LanguageModel,
  options?: {
    trace?: (event: AgentTraceEvent) => void
    abortSignal?: AbortSignal
  }
): AgentContext {
  return {
    getLanguageModel,
    trace: options?.trace,
    abortSignal: options?.abortSignal
  }
}

// ============================================================================
// Legacy Aliases (for backward compatibility during migration)
// ============================================================================

/** @deprecated Use AgentContext instead */
export type SimpleAgentContext = AgentContext

/** @deprecated Use AgentResult instead */
export type SimpleAgentResult<T = unknown> = AgentResult<T>

/** @deprecated Use AgentDefinition instead */
export type SimpleAgentDefinition = AgentDefinition

/** @deprecated Use Agent instead */
export type SimpleAgent = Agent

/** @deprecated Use AgentTraceEvent instead */
export type SimpleAgentTraceEvent = AgentTraceEvent

/** @deprecated Use isAgent instead */
export const isSimpleAgent = isAgent

/** @deprecated Use createAgentContext instead */
export const createSimpleAgentContext = createAgentContext
