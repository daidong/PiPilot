/**
 * Error Feedback System (RFC-005)
 *
 * Builds structured feedback messages for LLM consumption.
 * Uses Facts/Guidance dual channel: facts are sanitized machine data,
 * guidance is framework-generated actionable text.
 */

import type { AgentError, ErrorSource } from './errors.js'
import { sanitizeDetails, sanitizeErrorContent } from './errors.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Machine-readable error facts (sanitized, safe for LLM).
 * Reshaped to focus on category + source + attempt + data.
 */
export interface ErrorFacts {
  category: string
  source: string
  attempt?: number
  data?: Record<string, unknown>
}

/**
 * Summary of a tool's parameter schema, used in feedback context.
 */
export interface ToolSchemaSummary {
  name: string
  params: Array<{ name: string; type: string; required: boolean }>
}

/**
 * Context available when building feedback — provides the original input,
 * history, and tool schema so feedback can be more actionable.
 */
export interface FeedbackContext {
  /** The original tool input that caused the error */
  originalInput?: unknown
  /** Previous attempts/errors for this tool call */
  history?: Array<{ attempt: number; error: string }>
  /** Schema summary of the tool */
  toolSchema?: ToolSchemaSummary
}

/**
 * A function that builds ErrorFeedback from an error and optional context.
 */
export type FeedbackBuilder = (error: AgentError, context?: FeedbackContext) => ErrorFeedback

/**
 * Structured feedback sent to the LLM as a tool result.
 * Split into facts (sanitized data) and guidance (framework text).
 */
export interface ErrorFeedback {
  /** Machine-readable error facts (sanitized, safe for LLM) */
  facts: ErrorFacts
  /** Framework-generated guidance text (never from external sources) */
  guidance: string
  /** If the framework was able to auto-repair the input, it goes here */
  repairedInput?: unknown
}

// ============================================================================
// Guidance Templates
// ============================================================================

const GUIDANCE_TEMPLATES: Record<string, string> = {
  validation: 'Fix the invalid parameters and retry the tool call. Check the parameter names, types, and required fields against the tool definition.',
  execution: 'The code or command failed at runtime. Review the error details, fix the issue, and try again with a corrected approach.',
  timeout: 'The operation timed out. Consider simplifying the request, reducing data size, or breaking it into smaller steps.',
  rate_limit: 'Rate limited. This will be retried automatically. No action needed.',
  auth: 'Authentication failed. This cannot be fixed by retrying. Report this to the user.',
  policy_denied: 'This operation was blocked by a security policy. Try a different approach or different parameters.',
  context_overflow: 'The context is too large. Reduce the amount of data being processed or summarize intermediate results.',
  context_drop: 'Some context was dropped to stay within limits. The response may be missing information. Consider summarizing or re-fetching key data.',
  malformed_output: 'The previous output was malformed. Try a different approach to produce valid output.',
  resource: 'A required resource was not found or unavailable. Verify the path/resource exists before retrying.',
  transient_network: 'A temporary network error occurred. This will be retried automatically.',
  unknown: 'An unexpected error occurred. Review the error details and try a different approach.'
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Flatten ErrorSource to a string label for the facts channel.
 */
function sourceLabel(source: ErrorSource): string {
  switch (source.kind) {
    case 'tool': return `tool:${source.toolName}`
    case 'policy': return `policy:${source.policyId}`
    default: return source.kind
  }
}

// ============================================================================
// Feedback Builders
// ============================================================================

/**
 * Build an ErrorFeedback from an AgentError and optional context.
 */
export function buildFeedback(error: AgentError, context?: FeedbackContext): ErrorFeedback {
  const facts: ErrorFacts = {
    category: error.category,
    source: sourceLabel(error.source),
    attempt: error.attempt,
    data: error.details ? sanitizeDetails(error.details) : undefined
  }

  let guidance = GUIDANCE_TEMPLATES[error.category] || GUIDANCE_TEMPLATES.unknown!

  // Enrich guidance with schema info when available
  if (context?.toolSchema && error.category === 'validation') {
    const paramList = context.toolSchema.params
      .map(p => `${p.name}: ${p.type}${p.required ? ' (required)' : ''}`)
      .join(', ')
    guidance += `\nTool "${context.toolSchema.name}" expects: ${paramList}`
  }

  return { facts, guidance: guidance! }
}

/**
 * Build feedback specifically for tool validation errors.
 */
export function toolValidationFeedback(
  toolName: string,
  paramErrors: Array<{ param: string; message: string }>,
  context?: FeedbackContext
): ErrorFeedback {
  const errorList = paramErrors
    .map(e => `  - ${sanitizeErrorContent(e.param, 64)}: ${sanitizeErrorContent(e.message, 128)}`)
    .join('\n')

  let guidance = `Fix these parameter errors and retry:\n${errorList}\n\nCheck the tool definition for correct parameter names, types, and required fields.`

  if (context?.toolSchema) {
    const paramList = context.toolSchema.params
      .map(p => `${p.name}: ${p.type}${p.required ? ' (required)' : ''}`)
      .join(', ')
    guidance += `\nTool "${context.toolSchema.name}" expects: ${paramList}`
  }

  return {
    facts: {
      category: 'validation',
      source: `tool:${sanitizeErrorContent(toolName, 64)}`,
      data: {
        tool: sanitizeErrorContent(toolName, 64),
        paramErrors: paramErrors.map(e => ({
          param: sanitizeErrorContent(e.param, 64),
          message: sanitizeErrorContent(e.message, 128)
        }))
      }
    },
    guidance
  }
}

/**
 * Build feedback for Python/code execution failures.
 */
export function executionFailureFeedback(
  error: AgentError,
  _context?: FeedbackContext
): ErrorFeedback {
  const details = error.details || {}
  const exType = details.exceptionType as string | undefined
  const exMsg = details.exceptionMessage as string | undefined

  let guidance: string = GUIDANCE_TEMPLATES.execution!
  if (exType) {
    guidance = `Python raised ${exType}${exMsg ? ': ' + exMsg : ''}. Fix the code and try again.`
  }

  return {
    facts: {
      category: error.category,
      source: sourceLabel(error.source),
      attempt: error.attempt,
      data: error.details ? sanitizeDetails(error.details) : undefined
    },
    guidance
  }
}

/**
 * Build feedback for policy denial.
 */
export function policyDenialFeedback(
  toolName: string,
  reason: string,
  contextOrPolicyId?: FeedbackContext | string
): ErrorFeedback {
  const policyId = typeof contextOrPolicyId === 'string' ? contextOrPolicyId : undefined
  return {
    facts: {
      category: 'policy_denied',
      source: `policy:${sanitizeErrorContent(policyId || 'unknown', 64)}`,
      data: { tool: sanitizeErrorContent(toolName, 64), reason: sanitizeErrorContent(reason, 200) }
    },
    guidance: `The tool "${sanitizeErrorContent(toolName, 64)}" was blocked by a security policy: ${sanitizeErrorContent(reason, 200)}. Try a different tool or approach.`
  }
}

/**
 * Build feedback for context drop events.
 */
export function contextDropFeedback(
  droppedItems: string[],
  reason: string
): ErrorFeedback {
  return {
    facts: {
      category: 'context_overflow',
      source: 'runtime',
      data: { droppedItems, reason }
    },
    guidance: GUIDANCE_TEMPLATES.context_drop!
  }
}

/**
 * Format an ErrorFeedback as a JSON tool result string.
 * Returns `{ success: false, error: facts, guidance }` for structured consumption.
 */
export function formatFeedbackAsToolResult(feedback: ErrorFeedback): string {
  return JSON.stringify({
    success: false,
    error: feedback.facts,
    guidance: feedback.guidance,
    ...(feedback.repairedInput !== undefined ? { repairedInput: feedback.repairedInput } : {})
  })
}
