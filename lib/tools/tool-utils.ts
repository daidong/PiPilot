/**
 * Tool utility functions for Research Copilot.
 *
 * Simplified from myRAM's tool infrastructure:
 * - toAgentResult(): converts internal ToolResult to pi-mono's AgentToolResult format
 * - truncateHeadTail(): truncates large outputs preserving head and tail
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core'

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string
}

/**
 * Truncate text keeping head and tail portions.
 * Head gets 70% of budget by default, tail gets 30%.
 */
export function truncateHeadTail(
  text: string,
  maxChars: number,
  headRatio = 0.7
): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * headRatio)
  const tailChars = maxChars - headChars
  const truncatedChars = text.length - maxChars
  return `${text.slice(0, headChars)}\n...[truncated ${truncatedChars} chars]\n${text.slice(-tailChars)}`
}

/**
 * Convert our internal ToolResult to pi-mono's AgentToolResult format.
 * The result is { content: [{ type: 'text', text: '...' }], details: { success, tool_name } }.
 */
export function toAgentResult(
  toolName: string,
  result: ToolResult
): AgentToolResult<{ success: boolean; tool_name: string }> {
  let text: string

  if (result.success) {
    if (result.data === undefined || result.data === null) {
      text = `[${toolName}] OK`
    } else if (typeof result.data === 'string') {
      text = result.data
    } else {
      text = JSON.stringify(result.data, null, 2)
    }
  } else {
    text = result.error
      ? `Error: ${result.error}`
      : 'Error: Tool execution failed'
  }

  // Cap output at 100k chars to avoid blowing up context
  const MAX_RESULT_CHARS = 100_000
  const bounded = truncateHeadTail(text, MAX_RESULT_CHARS)

  return {
    content: [{ type: 'text', text: bounded }],
    details: { success: result.success, tool_name: toolName }
  }
}
