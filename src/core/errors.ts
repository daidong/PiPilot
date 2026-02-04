/**
 * Structured Error System (RFC-005)
 *
 * Provides typed error categories, sanitization, and classification
 * for the agent error feedback loop.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Error categories that determine retry strategy and feedback generation.
 */
export type ErrorCategory =
  | 'validation'         // Bad tool parameters — agent can fix
  | 'execution'          // Tool/script runtime failure — agent can try different approach
  | 'timeout'            // Operation exceeded time limit
  | 'rate_limit'         // API rate limit — executor retry (no LLM)
  | 'server_overload'    // API server at capacity (HTTP 529) — executor retry
  | 'auth'               // Authentication/permission error — not recoverable
  | 'policy_denied'      // Framework policy blocked the call — maybe recoverable with different approach
  | 'context_overflow'   // Token limit exceeded
  | 'malformed_output'   // Tool returned unparseable output
  | 'resource'           // File not found, disk full, etc.
  | 'transient_network'  // Temporary network failure — executor retry
  | 'unknown'            // Unclassified

/**
 * Discriminated union for error source origin.
 */
export type ErrorSource =
  | { kind: 'tool'; toolName: string }
  | { kind: 'policy'; policyId: string }
  | { kind: 'llm'; model?: string }
  | { kind: 'runtime' }
  | { kind: 'python'; scriptPath?: string }
  | { kind: 'network' }
  | { kind: 'flow'; stepId: string; agentId?: string }
  | { kind: 'context'; phase?: string }

/**
 * Legacy flat error source string (deprecated, kept for backwards compat).
 */
export type ErrorSourceKind = ErrorSource['kind']

/**
 * Three-valued recoverability hint.
 * - 'yes': Agent can likely fix this with different params/approach
 * - 'no': Retrying won't help (auth)
 * - 'maybe': Depends on context (timeouts, resource issues, policy)
 */
export type Recoverability = 'yes' | 'no' | 'maybe'

/**
 * Context for error classification — helps infer source and enrich details.
 */
export interface ClassifyErrorContext {
  toolName?: string
  policyId?: string
  stepId?: number
}

/**
 * Structured error envelope for the framework.
 */
export interface AgentError {
  category: ErrorCategory
  source: ErrorSource
  message: string
  recoverability: Recoverability
  /** Current attempt number (1-based) */
  attempt?: number
  /** Sanitized details safe to include in LLM prompts */
  details?: Record<string, unknown>
  /** Original raw error (not exposed to LLM) */
  rawError?: unknown
}

// ============================================================================
// Classification
// ============================================================================

const RECOVERABILITY_MAP: Record<ErrorCategory, Recoverability> = {
  validation: 'yes',
  execution: 'yes',
  timeout: 'maybe',
  rate_limit: 'yes',
  server_overload: 'yes',
  auth: 'no',
  policy_denied: 'maybe',
  context_overflow: 'maybe',
  malformed_output: 'yes',
  resource: 'maybe',
  transient_network: 'yes',
  unknown: 'maybe'
}

/**
 * Infer an ErrorSource from classification context.
 */
export function inferSource(context?: ClassifyErrorContext): ErrorSource {
  if (context?.policyId) return { kind: 'policy', policyId: context.policyId }
  if (context?.toolName) return { kind: 'tool', toolName: context.toolName }
  return { kind: 'runtime' }
}

/**
 * Classify a raw error string into a structured AgentError.
 *
 * Accepts an optional context object to enrich the source information.
 * For backwards compatibility, also accepts a flat source kind string
 * as the second argument.
 */
export function classifyError(
  error: string | Error,
  sourceOrContext?: ErrorSourceKind | ClassifyErrorContext
): AgentError {
  const message = typeof error === 'string' ? error : error.message
  const lowerMsg = message.toLowerCase()

  // Resolve source: legacy string or new context object
  let source: ErrorSource
  let context: ClassifyErrorContext | undefined

  if (typeof sourceOrContext === 'string') {
    // Legacy: flat source kind string
    source = sourceKindToSource(sourceOrContext)
  } else if (sourceOrContext) {
    context = sourceOrContext
    source = inferSource(context)
  } else {
    source = { kind: 'runtime' }
  }

  let category: ErrorCategory = 'unknown'

  // Classification heuristics
  if (lowerMsg.includes('parameter validation') || lowerMsg.includes('required parameter') || lowerMsg.includes('invalid type')) {
    category = 'validation'
  } else if (lowerMsg.includes('rate limit') || lowerMsg.includes('429') || lowerMsg.includes('too many requests')) {
    category = 'rate_limit'
    source = { kind: 'network' }
  } else if (
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('529') ||
    lowerMsg.includes('overloaded_error') ||
    lowerMsg.includes('server is at capacity')
  ) {
    category = 'server_overload'
    source = { kind: 'llm' }
  } else if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
    category = 'timeout'
  } else if (lowerMsg.includes('unauthorized') || lowerMsg.includes('401') || lowerMsg.includes('403') || lowerMsg.includes('authentication')) {
    category = 'auth'
  } else if (lowerMsg.includes('policy') || lowerMsg.includes('denied by') || lowerMsg.includes('not allowed')) {
    category = 'policy_denied'
    if (source.kind !== 'policy') source = { kind: 'policy', policyId: context?.policyId ?? 'unknown' }
  } else if (lowerMsg.includes('context') && (lowerMsg.includes('overflow') || lowerMsg.includes('too long') || lowerMsg.includes('token'))) {
    category = 'context_overflow'
  } else if (lowerMsg.includes('file not found') || lowerMsg.includes('enoent') || lowerMsg.includes('no such file') || lowerMsg.includes('disk full') || lowerMsg.includes('enospc')) {
    category = 'resource'
  } else if (lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound') || lowerMsg.includes('network') || lowerMsg.includes('dns')
      || lowerMsg.includes('server_error') || lowerMsg.includes('internal server error') || lowerMsg.includes('500')
      || lowerMsg.includes('terminated') || lowerMsg.includes('econnreset') || lowerMsg.includes('und_err_socket') || lowerMsg.includes('socket hang up')) {
    category = 'transient_network'
    source = { kind: 'network' }
  } else if (source.kind === 'python' || lowerMsg.includes('traceback') || lowerMsg.includes('syntaxerror') || lowerMsg.includes('exception')) {
    category = 'execution'
  }

  return {
    category,
    source,
    message: sanitizeErrorContent(message),
    recoverability: RECOVERABILITY_MAP[category],
    rawError: error
  }
}

/**
 * Convert a legacy flat source kind string to an ErrorSource object.
 */
function sourceKindToSource(kind: ErrorSourceKind): ErrorSource {
  switch (kind) {
    case 'tool': return { kind: 'tool', toolName: 'unknown' }
    case 'policy': return { kind: 'policy', policyId: 'unknown' }
    case 'llm': return { kind: 'llm' }
    case 'python': return { kind: 'python' }
    case 'network': return { kind: 'network' }
    case 'runtime':
    default: return { kind: 'runtime' }
  }
}

/**
 * Create a validation AgentError from tool parameter errors.
 */
export function createValidationError(
  toolName: string,
  errors: Array<{ param: string; message: string }>
): AgentError {
  return {
    category: 'validation',
    source: { kind: 'tool', toolName },
    message: `Parameter validation failed for tool "${toolName}"`,
    recoverability: 'yes',
    details: {
      tool: toolName,
      paramErrors: errors.map(e => ({
        param: sanitizeErrorContent(e.param, 64),
        message: sanitizeErrorContent(e.message, 128)
      }))
    }
  }
}

/**
 * Create a Python execution AgentError from stderr output.
 */
export function createPythonError(stderr: string, exitCode?: number): AgentError {
  const parsed = parsePythonTraceback(stderr)
  return {
    category: 'execution',
    source: { kind: 'python' },
    message: parsed.exceptionType
      ? `${parsed.exceptionType}: ${sanitizeErrorContent(parsed.exceptionMessage || '', 200)}`
      : sanitizeErrorContent(stderr.slice(0, 256), 256),
    recoverability: 'yes',
    details: {
      exceptionType: parsed.exceptionType,
      exceptionMessage: parsed.exceptionMessage ? sanitizeErrorContent(parsed.exceptionMessage, 200) : undefined,
      topFrame: parsed.topFrame ? sanitizeErrorContent(parsed.topFrame, 200) : undefined,
      exitCode
    },
    rawError: stderr
  }
}

// ============================================================================
// Sanitization
// ============================================================================

const MAX_FIELD_LENGTH = 256
const MAX_TOTAL_BYTES = 1024

// Patterns that could be prompt injection attempts
const INJECTION_PATTERNS = [
  /ignore (?:all )?(?:previous |above )?instructions/i,
  /you are now/i,
  /system:\s/i,
  /\bprompt\b.*\binjection\b/i,
  /<\/?(?:system|user|assistant)\b/i
]

/**
 * Sanitize error content before including in LLM feedback.
 * Strips potential prompt injection, truncates to safe length.
 */
export function sanitizeErrorContent(content: string, maxLength: number = MAX_FIELD_LENGTH): string {
  if (!content) return ''

  let sanitized = content

  // Strip potential injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[FILTERED]')
  }

  // Truncate
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength - 3) + '...'
  }

  return sanitized
}

/**
 * Sanitize an entire details object, enforcing total byte budget.
 */
export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let totalBytes = 0

  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    const fieldBytes = Buffer.byteLength(serialized, 'utf-8')

    if (totalBytes + fieldBytes > MAX_TOTAL_BYTES) {
      // Truncate remaining fields
      const remaining = MAX_TOTAL_BYTES - totalBytes
      if (remaining > 20) {
        result[key] = typeof value === 'string'
          ? sanitizeErrorContent(value, remaining)
          : sanitizeErrorContent(serialized, remaining)
      }
      break
    }

    totalBytes += fieldBytes
    result[key] = value
  }

  return result
}

/**
 * Get the source kind string from an ErrorSource (for backwards compat).
 */
export function getSourceKind(source: ErrorSource): ErrorSourceKind {
  return source.kind
}

// ============================================================================
// Python Traceback Parser
// ============================================================================

interface ParsedTraceback {
  exceptionType?: string
  exceptionMessage?: string
  topFrame?: string
}

/**
 * Extract structured info from a Python traceback string.
 */
export function parsePythonTraceback(stderr: string): ParsedTraceback {
  const lines = stderr.trim().split('\n')
  const result: ParsedTraceback = {}

  // Find the last exception line (e.g., "ValueError: invalid literal...")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    // Match "ExceptionType: message" or just "ExceptionType"
    const match = line.match(/^(\w+(?:\.\w+)*)(?::\s*(.*))?$/)
    if (match && /Error|Exception|Warning|Interrupt|Exit/i.test(match[1]!)) {
      result.exceptionType = match[1]!
      result.exceptionMessage = match[2] || undefined
      break
    }
  }

  // Find the topmost "File ..." frame after "Traceback"
  const tracebackIdx = lines.findIndex(l => l.includes('Traceback'))
  if (tracebackIdx >= 0) {
    for (let i = tracebackIdx + 1; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line.startsWith('File ')) {
        result.topFrame = line
        break
      }
    }
  }

  return result
}
