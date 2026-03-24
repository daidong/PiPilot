/**
 * Tool utility functions for Research Copilot.
 *
 * Core infrastructure for standardized tool results:
 * - ToolErrorCode: machine-readable error classification for agent self-correction
 * - ToolResult: standardized result envelope with error_code, suggestions, context, warnings
 * - toolError(): builder for structured error results
 * - toolSuccess(): builder for success results with optional warnings
 * - toAgentResult(): converts ToolResult to pi-mono's AgentToolResult format
 * - truncateHeadTail(): truncates large outputs preserving head and tail
 */

import type { AgentToolResult } from '@mariozechner/pi-agent-core'

// ---------------------------------------------------------------------------
// Error codes — agent can programmatically switch on these
// ---------------------------------------------------------------------------

/** Machine-readable error codes for agent self-correction. */
export type ToolErrorCode =
  // Input errors — agent should fix parameters and retry
  | 'MISSING_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'FILE_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  // Dependency errors — agent should check prerequisites
  | 'LLM_UNAVAILABLE'
  | 'CONVERTER_NOT_FOUND'
  | 'RUNTIME_NOT_FOUND'
  // External service errors — agent should retry or use fallback
  | 'API_ERROR'
  | 'API_RATE_LIMITED'
  | 'DOWNLOAD_FAILED'
  | 'NETWORK_TIMEOUT'
  // Processing errors
  | 'CONVERSION_FAILED'
  | 'EXECUTION_FAILED'
  | 'PARSE_FAILED'
  | 'OUTPUT_TOO_LARGE'
  // Data errors
  | 'NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'

// ---------------------------------------------------------------------------
// ToolResult — standardized result envelope
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean
  data?: unknown
  error?: string                    // Human-readable error message
  error_code?: ToolErrorCode        // Machine-readable error classification
  retryable?: boolean               // Should agent retry this call?
  suggestions?: string[]            // Actionable next steps for agent
  context?: Record<string, unknown> // Diagnostic metadata (paths, status codes, etc.)
  warnings?: string[]               // Non-fatal issues (partial results, degraded mode)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a structured error result.
 * Answers three questions for the agent: what broke, why, and how to fix it.
 */
export function toolError(
  code: ToolErrorCode,
  message: string,
  opts?: {
    retryable?: boolean
    suggestions?: string[]
    context?: Record<string, unknown>
    data?: unknown
  }
): ToolResult {
  return {
    success: false,
    error: message,
    error_code: code,
    retryable: opts?.retryable ?? false,
    suggestions: opts?.suggestions,
    context: opts?.context,
    data: opts?.data,
  }
}

/**
 * Build a success result with optional warnings for degraded/partial results.
 */
export function toolSuccess(data: unknown, warnings?: string[]): ToolResult {
  return { success: true, data, warnings }
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// toAgentResult — convert ToolResult to pi-mono format
// ---------------------------------------------------------------------------

/**
 * Convert our internal ToolResult to pi-mono's AgentToolResult format.
 *
 * On error, formats a structured message that helps agents self-correct:
 *   Error [ERROR_CODE]: human-readable message
 *   Retryable: yes/no
 *   Suggestions:
 *   - actionable step 1
 *   - actionable step 2
 *   Context: { diagnostic metadata }
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
    // Append warnings for partial/degraded results
    if (result.warnings?.length) {
      text += `\n\nWarnings:\n${result.warnings.map(w => `- ${w}`).join('\n')}`
    }
  } else {
    // Structured error for agent self-correction
    const parts: string[] = []
    parts.push(`Error [${result.error_code ?? 'UNKNOWN'}]: ${result.error ?? 'Tool execution failed'}`)
    if (result.retryable !== undefined) {
      parts.push(`Retryable: ${result.retryable ? 'yes' : 'no'}`)
    }
    if (result.suggestions?.length) {
      parts.push(`Suggestions:\n${result.suggestions.map(s => `- ${s}`).join('\n')}`)
    }
    if (result.context && Object.keys(result.context).length > 0) {
      parts.push(`Context: ${JSON.stringify(result.context)}`)
    }
    text = parts.join('\n')
  }

  // Cap output at 100k chars to avoid blowing up context
  const MAX_RESULT_CHARS = 100_000
  const bounded = truncateHeadTail(text, MAX_RESULT_CHARS)

  return {
    content: [{ type: 'text', text: bounded }],
    details: { success: result.success, tool_name: toolName }
  }
}
