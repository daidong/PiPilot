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
// Structured truncation — preserves JSON validity
// ---------------------------------------------------------------------------

/**
 * Truncate structured data by shrinking the largest string field.
 * Unlike truncateHeadTail on serialized JSON, this keeps the JSON structure
 * intact so the LLM always receives parseable output.
 */
function truncateStructuredData(
  data: Record<string, unknown>,
  maxChars: number
): Record<string, unknown> {
  const json = JSON.stringify(data, null, 2)
  if (json.length <= maxChars) return data

  const obj = { ...data }
  let largestKey = ''
  let largestSize = 0
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > largestSize) {
      largestKey = k
      largestSize = v.length
    }
  }

  if (largestKey) {
    const overhead = json.length - largestSize
    const fieldBudget = Math.max(1000, maxChars - overhead)
    obj[largestKey] = truncateHeadTail(obj[largestKey] as string, fieldBudget)
  }
  return obj
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
 *
 * On success, structured objects are truncated field-by-field to preserve
 * JSON validity (the largest string field is shrunk first).
 */
export function toAgentResult(
  toolName: string,
  result: ToolResult
): AgentToolResult<{ success: boolean; tool_name: string }> {
  let text: string

  const MAX_RESULT_CHARS = 100_000

  if (result.success) {
    if (result.data === undefined || result.data === null) {
      text = `[${toolName}] OK`
    } else if (typeof result.data === 'string') {
      text = truncateHeadTail(result.data, MAX_RESULT_CHARS)
    } else if (typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)) {
      // Structured object — truncate inside to preserve JSON validity
      const bounded = truncateStructuredData(
        result.data as Record<string, unknown>,
        MAX_RESULT_CHARS
      )
      text = JSON.stringify(bounded, null, 2)
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

  // Safety net: if still too large (e.g. arrays, deeply nested), fall back to head/tail
  if (text.length > MAX_RESULT_CHARS) {
    text = truncateHeadTail(text, MAX_RESULT_CHARS)
  }

  return {
    content: [{ type: 'text', text }],
    details: { success: result.success, tool_name: toolName }
  }
}
