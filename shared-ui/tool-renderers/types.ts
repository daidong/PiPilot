/**
 * Tool render configuration — defines how a tool appears in the UI.
 *
 * Each tool can register a config to control its display name, icon,
 * and how its parameters/results are formatted for human consumption.
 */
export interface ToolRenderConfig {
  /** Tool name (must match AgentTool.name) */
  name: string
  /** Human-readable display name */
  displayName: string
  /** Lucide icon name (e.g., 'FileText', 'Terminal', 'Search') */
  icon: string
  /** Category for grouping in UI */
  category: 'file' | 'search' | 'code' | 'research' | 'web' | 'memory' | 'system'

  /** Format tool-call parameters into a summary string */
  formatCallSummary: (args: Record<string, unknown>) => string
  /** Extract structured detail from args for expanded view */
  formatCallDetail: (args: Record<string, unknown>) => Record<string, unknown>

  /** Format tool-result into a summary string */
  formatResultSummary: (result: unknown, args?: Record<string, unknown>) => string
  /** Extract structured detail from result for expanded view */
  formatResultDetail: (result: unknown, args?: Record<string, unknown>) => Record<string, unknown>

  /** Format progress update for in-flight display */
  formatProgress?: (partialResult: unknown) => string | undefined
}
