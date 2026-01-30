/**
 * Activity Formatter - Converts tool calls/results into human-readable labels
 *
 * Reads formatters from tool definitions (self-describing tools), supports
 * custom rules for app-specific tools, and provides sensible fallbacks.
 */

import type { ToolRegistry } from '../core/tool-registry.js'
import type { ActivitySummary } from '../types/tool.js'

/** Custom rule for app-specific tools not in the registry */
export interface ToolActivityRule {
  /** Tool name to match (string = exact, RegExp = test) */
  match: string | RegExp
  /** Format label when tool is called */
  formatCall?: (toolName: string, args: Record<string, unknown>) => ActivitySummary
  /** Format label when tool returns */
  formatResult?: (toolName: string, result: Record<string, unknown>, args?: Record<string, unknown>) => ActivitySummary
}

export interface ActivityFormatterOptions {
  /** Tool registry to pull built-in labels from (or a getter for deferred access) */
  toolRegistry?: ToolRegistry | (() => ToolRegistry | undefined)
  /** Custom rules for app-specific tools (checked first) */
  customRules?: ToolActivityRule[]
}

function matchRule(rule: ToolActivityRule, toolName: string): boolean {
  if (typeof rule.match === 'string') return rule.match === toolName
  return rule.match.test(toolName)
}

/**
 * Create an activity formatter that converts tool calls/results
 * into human-readable ActivitySummary labels for UI display.
 *
 * Priority: custom rules > tool.activity > fallback
 */
export function createActivityFormatter(options?: ActivityFormatterOptions) {
  const { toolRegistry: registryOpt, customRules = [] } = options ?? {}

  /** Resolve the registry whether it's a value or a lazy getter */
  function getRegistry(): ToolRegistry | undefined {
    if (typeof registryOpt === 'function') return registryOpt()
    return registryOpt
  }

  function formatToolCall(tool: string, args: unknown): ActivitySummary {
    const a = (args ?? {}) as Record<string, unknown>

    // 1. Check custom rules first
    for (const rule of customRules) {
      if (matchRule(rule, tool) && rule.formatCall) {
        return rule.formatCall(tool, a)
      }
    }

    // 2. Check tool registry for built-in activity formatter
    const registry = getRegistry()
    if (registry) {
      const toolDef = registry.get(tool)
      if (toolDef?.activity?.formatCall) {
        return toolDef.activity.formatCall(a)
      }
    }

    // 3. Fallback
    return { label: tool }
  }

  function formatToolResult(tool: string, result: unknown, args?: unknown): ActivitySummary {
    const r = (result ?? {}) as Record<string, unknown>
    const a = (args ?? {}) as Record<string, unknown>

    // Check for failure first (universal)
    if (r.success === false) {
      const error = (r.error as string) || 'failed'
      return { label: `Failed: ${error.slice(0, 50)}` }
    }

    // 1. Check custom rules first
    for (const rule of customRules) {
      if (matchRule(rule, tool) && rule.formatResult) {
        return rule.formatResult(tool, r, a)
      }
    }

    // 2. Check tool registry for built-in activity formatter
    const registry = getRegistry()
    if (registry) {
      const toolDef = registry.get(tool)
      if (toolDef?.activity?.formatResult) {
        return toolDef.activity.formatResult(r, a)
      }
    }

    // 3. Fallback
    return { label: `${tool}: done` }
  }

  return { formatToolCall, formatToolResult }
}
