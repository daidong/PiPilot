/**
 * defineToolAgent - Tool Agent Definition Factory
 *
 * Creates type-safe agents that wrap existing tools with:
 * - Zod schema validation for input/output
 * - Input transformation (agent schema → tool input)
 * - Output transformation (tool output → agent schema)
 * - Works natively with the team system
 * - Implements the unified Agent interface
 */

import { type ZodSchema } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types/tool.js'
import type { Agent, AgentResult, BaseAgentContext } from './types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context provided to tool agents during execution
 */
export interface ToolAgentContext extends BaseAgentContext {
  /** Get a tool by ID from the registry */
  getTool: (toolId: string) => Tool | undefined

  /** Tool execution context */
  toolContext: ToolContext
}

/**
 * Result of tool agent execution (extends unified AgentResult)
 */
export interface ToolAgentResult<T> extends AgentResult<T> {
  // Tool agents use the base AgentResult fields
}

/**
 * Tool agent definition options
 */
export interface ToolAgentDefinition<TInput, TOutput> {
  /** Unique agent ID */
  id: string

  /** Human-readable description */
  description?: string

  /** Tool ID to execute */
  tool: string

  /** Input schema for validation */
  inputSchema: ZodSchema<TInput>

  /** Output schema for validation */
  outputSchema: ZodSchema<TOutput>

  /**
   * Transform agent input to tool input
   * @param input - Validated agent input
   * @returns Tool input
   */
  buildToolInput?: (input: TInput) => unknown

  /**
   * Transform tool output to agent output
   * @param toolOutput - Raw tool output
   * @param input - Original agent input (for context)
   * @returns Agent output (must match outputSchema)
   */
  transformOutput?: (toolOutput: unknown, input: TInput) => TOutput

  /**
   * Optional pre-processing hook
   * Transform input before tool execution
   */
  preProcess?: (input: TInput) => TInput | Promise<TInput>

  /**
   * Optional post-processing hook
   * Transform output after tool execution
   */
  postProcess?: (output: TOutput, input: TInput) => TOutput | Promise<TOutput>
}

/**
 * Tool Agent instance (implements unified Agent interface)
 */
export interface ToolAgent<TInput, TOutput> extends Agent<TInput, TOutput, ToolAgentContext> {
  /** Agent kind discriminator (for type checking) */
  readonly kind: 'tool-agent'

  /** Tool ID this agent wraps */
  readonly toolId: string

  /**
   * Run the agent with typed input
   * @param input - Input object (will be validated)
   * @param ctx - Agent context
   * @returns Typed output result (uses unified AgentResult)
   */
  run: (input: TInput, ctx: ToolAgentContext) => Promise<ToolAgentResult<TOutput>>
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a tool agent with typed input/output.
 *
 * Tool agents wrap existing tools with schema validation,
 * making them compatible with the typed team system.
 *
 * @example
 * ```typescript
 * const searcher = defineToolAgent({
 *   id: 'searcher',
 *   tool: 'literature.search',
 *   inputSchema: z.object({
 *     queries: z.array(z.string()),
 *     sources: z.array(z.string())
 *   }),
 *   outputSchema: z.object({
 *     papers: z.array(PaperSchema),
 *     totalFound: z.number()
 *   }),
 *   buildToolInput: (input) => ({
 *     query: input.queries.join(' OR '),
 *     sources: input.sources
 *   }),
 *   transformOutput: (toolOutput) => ({
 *     papers: toolOutput.results,
 *     totalFound: toolOutput.total
 *   })
 * })
 *
 * const result = await searcher.run(
 *   { queries: ['machine learning'], sources: ['arxiv'] },
 *   { getTool: (id) => toolRegistry.get(id), toolContext }
 * )
 *
 * console.log(result.output.papers)
 * ```
 */
export function defineToolAgent<TInput, TOutput>(
  definition: ToolAgentDefinition<TInput, TOutput>
): ToolAgent<TInput, TOutput> {
  const {
    id,
    description,
    tool: toolId,
    inputSchema,
    outputSchema,
    buildToolInput,
    transformOutput,
    preProcess,
    postProcess
  } = definition

  return {
    id,
    kind: 'tool-agent',
    description,
    toolId,
    inputSchema,
    outputSchema,

    async run(input: TInput, ctx: ToolAgentContext): Promise<ToolAgentResult<TOutput>> {
      const startTime = Date.now()

      // 1. Validate input
      const validatedInput = inputSchema.parse(input)

      // 2. Optional pre-processing
      const processedInput = preProcess
        ? await preProcess(validatedInput)
        : validatedInput

      // 3. Get tool from registry
      const tool = ctx.getTool(toolId)
      if (!tool) {
        return {
          output: undefined as unknown as TOutput,
          success: false,
          error: `Tool not found: ${toolId}`,
          durationMs: Date.now() - startTime
        }
      }

      // 4. Transform input if needed
      const toolInput = buildToolInput
        ? buildToolInput(processedInput)
        : processedInput

      // 5. Execute tool
      let toolResult: ToolResult
      try {
        toolResult = await tool.execute(toolInput, ctx.toolContext)
      } catch (error) {
        return {
          output: undefined as unknown as TOutput,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime
        }
      }

      // 6. Check tool result
      if (!toolResult.success) {
        return {
          output: undefined as unknown as TOutput,
          success: false,
          error: toolResult.error ?? 'Tool execution failed',
          durationMs: Date.now() - startTime
        }
      }

      // 7. Transform output if needed
      const rawOutput = transformOutput
        ? transformOutput(toolResult.data, processedInput)
        : toolResult.data as TOutput

      // 8. Validate output
      const validatedOutput = outputSchema.parse(rawOutput)

      // 9. Optional post-processing
      const finalOutput = postProcess
        ? await postProcess(validatedOutput, processedInput)
        : validatedOutput

      return {
        output: finalOutput,
        success: true,
        durationMs: Date.now() - startTime
      }
    }
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a tool agent
 */
export function isToolAgent(value: unknown): value is ToolAgent<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: unknown }).kind === 'tool-agent' &&
    'id' in value &&
    'toolId' in value &&
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
 * Create a simple tool agent context
 */
export function createSimpleToolAgentContext(
  getTool: (toolId: string) => Tool | undefined,
  toolContext: ToolContext,
  options?: {
    abortSignal?: AbortSignal
  }
): ToolAgentContext {
  return {
    getTool,
    toolContext,
    abortSignal: options?.abortSignal
  }
}

/**
 * Create a tool agent that passes input/output directly (no transformation)
 * Useful when tool I/O already matches your schema
 */
export function definePassthroughToolAgent<T>(
  id: string,
  toolId: string,
  schema: ZodSchema<T>,
  description?: string
): ToolAgent<T, T> {
  return defineToolAgent({
    id,
    description,
    tool: toolId,
    inputSchema: schema,
    outputSchema: schema
  })
}
