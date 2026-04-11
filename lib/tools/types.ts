/**
 * Research Copilot tool context and types.
 *
 * Simplified from myRAM's ToolContext — only what Research Copilot actually needs.
 */

import type { ResolvedSettings } from '../../shared-ui/settings-types'

export interface ResearchToolContext {
  /** Root of the workspace (e.g., project directory) */
  workspacePath: string
  /** Current session identifier */
  sessionId: string
  /** Project-level path for artifact storage */
  projectPath: string
  /** Optional LLM call function for tools that need sub-calls */
  callLlm?: (systemPrompt: string, userContent: string) => Promise<string>
  /** Callback when a tool is invoked */
  onToolCall?: (tool: string, args: unknown, toolCallId?: string) => void
  /** Callback when a tool returns */
  onToolResult?: (tool: string, result: unknown, args?: unknown, toolCallId?: string) => void
  /** Runtime settings resolved from user preferences */
  settings?: ResolvedSettings
}
