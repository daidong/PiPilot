/**
 * Research Copilot tool context and types.
 *
 * Simplified from myRAM's ToolContext — only what Research Copilot actually needs.
 */

import type { ResolvedSettings } from '../../shared-ui/settings-types'

/**
 * Credentials the diagram tool can use to reach image-generation and review
 * providers. The tool context populates this at call time (never cached at
 * coordinator startup) so changes to subscription/env state take effect on
 * the next invocation.
 */
export interface DiagramAuth {
  /** OpenAI API key (required for image generation). */
  openaiKey?: string | null
  /**
   * Anthropic credential for review. Prefers env `ANTHROPIC_API_KEY` when
   * set; otherwise surfaces the `anthropic-sub` OAuth access token so
   * Claude-Pro subscribers can review without configuring a separate key.
   */
  anthropic?: {
    token: string
    /** True when the token is an OAuth access token (sk-ant-oat…). */
    isOAuth: boolean
    /** Optional one-shot refresh on 401; returns a fresh token. */
    refresh?: () => Promise<string>
  } | null
}

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
  /**
   * Static settings snapshot captured at coordinator init. Prefer
   * `getSettings()` when a tool needs to observe live user changes.
   */
  settings?: ResolvedSettings
  /**
   * Live accessor for resolved settings. Tools that care about hot-reload
   * (e.g., user switches diagram review provider mid-session) must read
   * this instead of the `settings` snapshot.
   */
  getSettings?: () => ResolvedSettings
  /** Live accessor for diagram-tool auth (see `DiagramAuth`). */
  getDiagramAuth?: () => DiagramAuth
}
