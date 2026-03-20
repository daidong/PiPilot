/**
 * AgentHooks - Strongly-typed lifecycle hooks for AgentLoop
 *
 * Complements the string-based EventBus with compile-time-safe hooks
 * covering the most common agent extension points.
 */

// ─── Payload types ───────────────────────────────────────────────────────────

export interface BeforeToolCallEvent {
  /** Tool name */
  tool: string
  /** Tool input arguments */
  input: unknown
  /** Current step number */
  step: number
  /** Session ID */
  sessionId: string
}

export interface AfterToolCallEvent {
  /** Tool name */
  tool: string
  /** Tool input arguments */
  input: unknown
  /** Whether the tool call succeeded */
  success: boolean
  /** Raw result data (if success) */
  result?: unknown
  /** Error string (if failed) */
  error?: string
  /** Execution duration in milliseconds */
  durationMs: number
  /** Current step number */
  step: number
  /** Session ID */
  sessionId: string
}

export interface TurnStartEvent {
  /** Step number (1-based) */
  step: number
  /** Number of messages in context */
  messageCount: number
  /** Session ID */
  sessionId: string
}

export interface TurnEndEvent {
  /** Step number (1-based) */
  step: number
  /** Number of tool calls made this turn */
  toolCallCount: number
  /** Whether any tool errored this turn */
  hadErrors: boolean
  /** Session ID */
  sessionId: string
}

export interface RunStartEvent {
  /** User input that started this run */
  input: string
  /** Session ID */
  sessionId: string
  /** Agent ID */
  agentId: string
}

export interface RunEndEvent {
  /** Final text output */
  output: string
  /** Total steps taken */
  steps: number
  /** Whether the run completed normally */
  success: boolean
  /** Error message if run failed */
  error?: string
  /** Session ID */
  sessionId: string
  /** Agent ID */
  agentId: string
}

export interface BlockToolResult {
  block: true
  reason: string
}

export interface AllowToolResult {
  block?: false
}

export type BeforeToolCallResult = BlockToolResult | AllowToolResult | void

// ─── AgentHooks interface ─────────────────────────────────────────────────────

/**
 * Strongly-typed lifecycle hooks for AgentLoop.
 *
 * All hooks are optional. Async hooks are awaited before proceeding.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   hooks: {
 *     beforeToolCall: async ({ tool, input }) => {
 *       if (tool === 'bash' && (input as any).command?.includes('rm -rf')) {
 *         return { block: true, reason: 'Destructive commands are blocked' }
 *       }
 *     },
 *     afterToolCall: ({ tool, success, durationMs }) => {
 *       console.log(`${tool} ${success ? 'ok' : 'failed'} in ${durationMs}ms`)
 *     }
 *   }
 * })
 * ```
 */
export interface AgentHooks {
  /**
   * Called before each tool execution.
   * Return `{ block: true, reason }` to prevent the tool from running.
   */
  beforeToolCall?: (event: BeforeToolCallEvent) => BeforeToolCallResult | Promise<BeforeToolCallResult>

  /**
   * Called after each tool execution (whether success or failure).
   */
  afterToolCall?: (event: AfterToolCallEvent) => void | Promise<void>

  /**
   * Called at the start of each LLM → tool round (before the LLM call).
   */
  onTurnStart?: (event: TurnStartEvent) => void | Promise<void>

  /**
   * Called at the end of each LLM → tool round (after all tools have run).
   */
  onTurnEnd?: (event: TurnEndEvent) => void | Promise<void>

  /**
   * Called once when the agent run begins.
   */
  onRunStart?: (event: RunStartEvent) => void | Promise<void>

  /**
   * Called once when the agent run ends (success or failure).
   */
  onRunEnd?: (event: RunEndEvent) => void | Promise<void>
}
