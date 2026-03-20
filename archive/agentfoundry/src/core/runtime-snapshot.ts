/**
 * RuntimeSnapshot - Safe runtime state snapshot for system prompts
 *
 * Generates a concise (150-250 tokens) snapshot of runtime state
 * with security redaction rules:
 * - Never include secrets or sensitive values
 * - Redact absolute paths (show relative only)
 * - Limit all lists to bounded format
 */

import type { Runtime } from '../types/runtime.js'
import { countTokens } from '../utils/tokenizer.js'

/**
 * Snapshot configuration
 */
export interface SnapshotConfig {
  /** Maximum tokens for snapshot (default: 200) */
  maxTokens?: number
  /** Maximum tools to display (default: 8) */
  maxToolsDisplay?: number
  /** Maximum context sources to display (default: 5) */
  maxContextDisplay?: number
  /** Include tool list (default: true) */
  includeTools?: boolean
  /** Include context sources (default: true) */
  includeContextSources?: boolean
  /** Custom project path for relative path conversion */
  projectPath?: string
}

/**
 * Snapshot data
 */
export interface RuntimeSnapshotData {
  agentId: string
  sessionId: string
  runId?: string
  step: number
  toolCount: number
  toolList: string
  contextSourceCount: number
  contextSourceList: string
  workingDir: string
}

/**
 * Security patterns to redact
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /auth/i,
  /private/i
]

/**
 * Check if a string looks like a secret
 */
function looksLikeSecret(value: string): boolean {
  // Long strings of alphanumeric that look like keys
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) {
    return true
  }
  // Starts with common key prefixes
  if (/^(sk-|pk-|api_|key_|secret_)/i.test(value)) {
    return true
  }
  return false
}

/**
 * Redact a path to show relative path only
 */
function redactPath(absolutePath: string, projectPath?: string): string {
  if (!absolutePath) return ''

  // If we have a project path, make it relative
  if (projectPath && absolutePath.startsWith(projectPath)) {
    const relative = absolutePath.slice(projectPath.length)
    return relative.startsWith('/') ? `.${relative}` : `./${relative}`
  }

  // Hide home directory
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || ''
  if (homeDir && absolutePath.startsWith(homeDir)) {
    return absolutePath.replace(homeDir, '~')
  }

  // For other absolute paths, just show the last 2 components
  const parts = absolutePath.split('/')
  if (parts.length > 2) {
    return `.../${parts.slice(-2).join('/')}`
  }

  return absolutePath
}

/**
 * Generate bounded list format: "item1, item2, item3 (+N more)"
 */
function boundedList(items: string[], maxDisplay: number): string {
  if (items.length === 0) return 'none'
  if (items.length <= maxDisplay) {
    return items.join(', ')
  }
  const displayed = items.slice(0, maxDisplay)
  const remaining = items.length - maxDisplay
  return `${displayed.join(', ')} (+${remaining} more)`
}

/**
 * Generate runtime snapshot data
 */
export function createSnapshotData(runtime: Runtime, config: SnapshotConfig = {}): RuntimeSnapshotData {
  const {
    maxToolsDisplay = 8,
    maxContextDisplay = 5,
    projectPath = runtime.projectPath
  } = config

  // Get tool names
  const toolNames = runtime.toolRegistry?.getNames() ?? []

  // Get context source IDs
  const contextSources = runtime.contextManager?.getAllSources() ?? []
  const contextSourceIds = contextSources.map(s => s.id)

  return {
    agentId: runtime.agentId,
    sessionId: runtime.sessionId,
    runId: runtime.trace?.getCorrelation?.()?.runId,
    step: runtime.step,
    toolCount: toolNames.length,
    toolList: boundedList(toolNames, maxToolsDisplay),
    contextSourceCount: contextSourceIds.length,
    contextSourceList: boundedList(contextSourceIds, maxContextDisplay),
    workingDir: redactPath(projectPath, projectPath)
  }
}

/**
 * Render snapshot to markdown string
 */
export function renderSnapshot(data: RuntimeSnapshotData, config: SnapshotConfig = {}): string {
  const {
    includeTools = true,
    includeContextSources = true
  } = config

  const lines: string[] = []

  // Header
  lines.push('## Runtime Status')
  lines.push('')

  // Core info (always include)
  lines.push(`- Agent: ${data.agentId}`)
  lines.push(`- Session: ${data.sessionId}`)
  if (data.runId) {
    lines.push(`- Run: ${data.runId}`)
  }
  lines.push(`- Step: ${data.step}`)
  lines.push(`- Working Dir: ${data.workingDir || '.'}`)

  // Tools
  if (includeTools && data.toolCount > 0) {
    lines.push('')
    lines.push(`### Tools (${data.toolCount})`)
    lines.push(data.toolList)
  }

  // Context sources
  if (includeContextSources && data.contextSourceCount > 0) {
    lines.push('')
    lines.push(`### Context Sources (${data.contextSourceCount})`)
    lines.push(data.contextSourceList)
  }

  return lines.join('\n')
}

/**
 * Generate a safe runtime snapshot for system prompt
 *
 * @param runtime - The runtime object
 * @param config - Snapshot configuration
 * @returns Markdown string safe for system prompt inclusion
 */
export function generateRuntimeSnapshot(runtime: Runtime, config: SnapshotConfig = {}): string {
  const { maxTokens = 200 } = config

  const data = createSnapshotData(runtime, config)
  let snapshot = renderSnapshot(data, config)

  // Check token count and trim if needed
  let tokens = countTokens(snapshot)

  if (tokens > maxTokens) {
    // Progressively disable sections to fit
    const trimConfigs = [
      { includeContextSources: false },
      { includeContextSources: false, includeTools: false }
    ]

    for (const trimConfig of trimConfigs) {
      snapshot = renderSnapshot(data, { ...config, ...trimConfig })
      tokens = countTokens(snapshot)
      if (tokens <= maxTokens) break
    }
  }

  return snapshot
}

/**
 * Validate that snapshot doesn't contain secrets
 */
export function validateSnapshot(snapshot: string): { safe: boolean; issues: string[] } {
  const issues: string[] = []

  // Check for sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    const matches = snapshot.match(new RegExp(`${pattern.source}[^\\s]*`, 'gi'))
    if (matches) {
      for (const match of matches) {
        // Only flag if followed by what looks like a value
        if (match.includes('=') || match.includes(':')) {
          issues.push(`Potential sensitive data: ${match.substring(0, 20)}...`)
        }
      }
    }
  }

  // Check for long random strings that might be keys
  const longStrings = snapshot.match(/[a-zA-Z0-9_-]{30,}/g)
  if (longStrings) {
    for (const str of longStrings) {
      if (looksLikeSecret(str)) {
        issues.push(`Potential secret value detected: ${str.substring(0, 10)}...`)
      }
    }
  }

  return {
    safe: issues.length === 0,
    issues
  }
}
