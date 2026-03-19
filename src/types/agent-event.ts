/**
 * Agent Event Types — unified event stream for agent execution.
 *
 * Every observable action during an agent run (LLM text, tool calls, step
 * boundaries, errors, completion) is represented as a typed event. Consumers
 * can iterate over these events via `agent.run(prompt).events()`.
 */

import type { AgentRunResult } from './agent.js'

// ---------------------------------------------------------------------------
// Individual event interfaces
// ---------------------------------------------------------------------------

/** Incremental text chunk from the LLM */
export interface AgentTextDeltaEvent {
  type: 'text-delta'
  /** The text fragment */
  text: string
  /** Current step number */
  step: number
}

/** LLM requested a tool call */
export interface AgentToolCallEvent {
  type: 'tool-call'
  /** Tool name */
  tool: string
  /** Provider-assigned call ID */
  toolCallId: string
  /** Parsed arguments */
  args: unknown
  /** Current step number */
  step: number
}

/** Tool execution completed */
export interface AgentToolResultEvent {
  type: 'tool-result'
  /** Tool name */
  tool: string
  /** Provider-assigned call ID */
  toolCallId: string
  /** Whether the tool succeeded */
  success: boolean
  /** Result data (on success) */
  data?: unknown
  /** Error message (on failure) */
  error?: string
  /** Execution time in ms */
  durationMs?: number
  /** Current step number */
  step: number
}

/** A new step (LLM round) is starting */
export interface AgentStepStartEvent {
  type: 'step-start'
  /** Step number (1-based) */
  step: number
}

/** A step (LLM round) finished */
export interface AgentStepFinishEvent {
  type: 'step-finish'
  /** Step number */
  step: number
  /** Text produced in this step */
  text: string
  /** Number of tool calls in this step */
  toolCallCount: number
}

/** An error occurred (may or may not be recoverable) */
export interface AgentErrorEvent {
  type: 'error'
  /** Error description */
  error: string
  /** Whether the agent will attempt recovery */
  recoverable: boolean
  /** Current step number */
  step: number
}

/** Agent run completed */
export interface AgentDoneEvent {
  type: 'done'
  /** Full run result */
  result: AgentRunResult
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/** All possible events emitted during an agent run */
export type AgentEvent =
  | AgentTextDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentStepStartEvent
  | AgentStepFinishEvent
  | AgentErrorEvent
  | AgentDoneEvent
