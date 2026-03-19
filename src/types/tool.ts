/**
 * Tool Types - Tool axis type definitions
 * Tools define the operations an Agent can execute
 */

import type { Runtime, RuntimeIO } from './runtime.js'

/**
 * Parameter type definition
 */
export interface ParameterDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  required?: boolean
  default?: unknown
  enum?: unknown[]
  items?: ParameterDefinition
  properties?: Record<string, ParameterDefinition>
}

export type ParameterSchema = Record<string, ParameterDefinition>

/**
 * Tool execution context
 */
export interface ToolContext {
  /** Runtime instance */
  runtime: Runtime
  /** Session ID */
  sessionId: string
  /** Current step number */
  step: number
  /** Agent ID */
  agentId: string
  /** Current conversation messages (optional, for tools that need conversation context) */
  messages?: unknown[]
  /**
   * Abort signal from the agent run. Set when the agent is stopped or the run
   * is cancelled. Tools should respect this signal for long-running operations.
   */
  signal?: AbortSignal
}

/**
 * Attachment type
 */
export interface Attachment {
  type: 'image' | 'file' | 'code'
  name: string
  content: string | Buffer
  mimeType?: string
}

/**
 * Tool execution result
 */
export interface ToolResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  attachments?: Attachment[]
  /**
   * Optional compact string to send to the LLM instead of serializing `data`.
   *
   * Use this to keep the LLM context lean while preserving full-fidelity data
   * in `data` for UI consumers (via the `onToolResult` callback).
   *
   * Example: a diff tool returns the raw unified diff in `data` but a
   * one-line summary like "Changed 12 lines across 3 files" in `llmSummary`.
   *
   * When absent, the LLM receives the JSON-serialized `data` as usual.
   */
  llmSummary?: string
  /**
   * GAP-12: Tool-initiated retry signal.
   *
   * When a tool returns `success: false` with a `retry` field, the executor
   * retries the tool call transparently (no LLM round-trip) before falling
   * back to error classification. This lets tools handle transient failures
   * that the framework's heuristic error classifier cannot detect.
   *
   * If retries are exhausted or the budget is spent, the error falls through
   * to the normal agent_retry path (feedback to LLM).
   *
   * Example:
   * ```typescript
   * execute: async (input) => {
   *   const res = await externalAPI.call(input)
   *   if (res.status === 503) {
   *     return {
   *       success: false,
   *       error: 'Service temporarily unavailable',
   *       retry: { shouldRetry: true, delayMs: 2000, maxAttempts: 3 }
   *     }
   *   }
   *   return { success: true, data: res.data }
   * }
   * ```
   */
  retry?: ToolRetrySignal
}

/**
 * GAP-12: Retry signal returned by a tool to request executor-level retry.
 */
export interface ToolRetrySignal {
  /** When true, the executor retries this tool call without consulting the LLM. */
  shouldRetry: boolean
  /** Suggested delay (ms) between retries. Default: 1000. */
  delayMs?: number
  /** Maximum retry attempts the tool recommends. Capped by the run's retry budget. Default: 2. */
  maxAttempts?: number
  /** Custom guidance to include in error feedback if all retries are exhausted. */
  guidance?: string
}

/**
 * Tool definition
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Tool name (unique identifier) */
  name: string

  /** Tool description (for the LLM) */
  description: string

  /** Parameter definitions */
  parameters: ParameterSchema

  /** Execute function */
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>

  /** Optional activity label formatters for UI display */
  activity?: ToolActivityFormat

  /**
   * Maximum execution time in milliseconds. When set, the registry wraps
   * `execute()` in a timeout race — returning `{ success: false, error: '...' }`
   * if the tool does not complete within the allotted time.
   *
   * Note: this does not cancel in-flight I/O unless the tool also respects
   * `context.signal`. Combine with GAP-18 AbortSignal for full cancellation.
   */
  timeout?: number

  /**
   * Per-tool IO override. When provided, the tool receives a custom RuntimeIO
   * instead of the agent's default. The factory receives the agent's default IO
   * (so it can delegate or compose) and the current Runtime.
   *
   * Use cases: SSH/Docker execution for specific tools, sandboxed write access,
   * or mixed local+remote workflows where most tools use local IO but one tool
   * targets a remote host.
   *
   * Priority: tool.createIO > agent-level ioProvider > default LocalRuntimeIO
   */
  createIO?: (defaultIO: RuntimeIO, runtime: Runtime) => RuntimeIO | Promise<RuntimeIO>
}

/**
 * Tool configuration (for defineTool)
 */
export interface ToolConfig<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  parameters: ParameterSchema
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>>
  /** Optional activity label formatters for UI display */
  activity?: ToolActivityFormat
  /** Maximum execution time in milliseconds (see Tool.timeout) */
  timeout?: number
  /** Per-tool IO override factory (see Tool.createIO) */
  createIO?: (defaultIO: RuntimeIO, runtime: Runtime) => RuntimeIO | Promise<RuntimeIO>
}

/**
 * Built-in tool names
 */
export type BuiltinToolName =
  // Safe core
  | 'ctx-get'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  // Execution capability
  | 'bash'
  // Network capability
  | 'fetch'
  // Compute capability
  | 'llm-call'
  | 'llm-expand'
  | 'llm-filter'

/**
 * Activity summary for UI display when a tool is called or returns
 */
export interface ActivitySummary {
  label: string
  icon?: 'search' | 'file' | 'network' | 'memory' | 'task' | 'run' | 'edit' | 'default'
}

/**
 * Optional activity label formatters for UI display
 */
export interface ToolActivityFormat {
  /** Format a human-readable label when the tool is called */
  formatCall?: (args: Record<string, unknown>) => ActivitySummary
  /** Format a human-readable label when the tool returns */
  formatResult?: (result: Record<string, unknown>, args?: Record<string, unknown>) => ActivitySummary
}

/**
 * Tool risk level
 */
export type ToolRiskLevel = 'safe' | 'elevated' | 'high'

/**
 * Tool category
 */
export type ToolCategory = 'safe' | 'exec' | 'network' | 'compute'
