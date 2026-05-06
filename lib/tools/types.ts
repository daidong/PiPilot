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

export interface SvgRasterizeOptions {
  width?: number
  height?: number
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
  /**
   * Vision-capable variant of `callLlm`. Stateless single-shot sub-call —
   * does not pass through the agent tool loop or mutate session state.
   * Throws if the currently-selected model does not accept image input;
   * callers should gate on `visionCapable` first.
   *
   * Image parameter shape (`{ base64, mimeType }`) mirrors the convention
   * used by `Coordinator.chat()` for user-attached images, so renderer ↔
   * IPC ↔ tool plumbing speaks one dialect.
   */
  callLlmVision?: (
    systemPrompt: string,
    userContent: string,
    images: Array<{ base64: string; mimeType: string }>
  ) => Promise<string>
  /** True when the active model declares image input support (pi-ai Model.input). */
  visionCapable?: boolean
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
  /**
   * Live accessor for the current turnId. Tools that write to the
   * artifact-ledger plumb this into the row so each ledger entry has a
   * 1-hop join back to the originating turn. Returns undefined for
   * non-turn paths (background work, CLI, bootstrap).
   */
  getTurnId?: () => string | undefined
  /**
   * Rasterize an SVG document to PNG bytes, when a renderer is available.
   * Used by the diagram tool's SVG-fallback review path so a vision model
   * can evaluate the rendered output (not just the SVG source) and catch
   * overflow / overlap / legibility problems that markup inspection misses.
   *
   * The coordinator wires this up only when running under Electron (main
   * process uses an offscreen BrowserWindow). Tools must treat it as
   * optional and degrade to source-level review when absent.
   */
  rasterizeSvg?: (svg: Buffer, options?: SvgRasterizeOptions) => Promise<Buffer>
}
