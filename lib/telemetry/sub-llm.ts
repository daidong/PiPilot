/**
 * `runSubLlmText` — single entry point for one-shot sub-LLM calls.
 *
 * Consolidates the `tracer ? tracedCompleteSimple(...) : completeSimple(...)`
 * ternary that was duplicated at 6 sites in the codebase, along with the
 * `piContext` shape, `llmOpts` shape, and `result.content.find(text)?.text`
 * extraction. Routing is identity-preserving in both branches.
 *
 * Every new sub-LLM call site SHOULD go through this helper. If you need
 * something the helper doesn't expose (e.g. raw AssistantMessage with usage
 * details), extend the helper rather than reaching past it — that keeps the
 * "is wire-capture complete?" answer at the helper boundary, per the
 * coverage table in `lib/telemetry/PARITY.md#wire-level-capture-coverage`.
 */

import type { Context } from '@opentelemetry/api'
import type {
  Context as PiContext,
  Model,
  SimpleStreamOptions,
  TextContent,
  ImageContent,
  Usage
} from '@mariozechner/pi-ai'
import { completeSimple } from '@mariozechner/pi-ai'
import { tracedCompleteSimple } from './llm-trace.js'
import type { PipilotTracer } from './tracer.js'
import type { PipilotAuthMode } from './semantic-registry.js'

export interface RunSubLlmOpts<TApi extends string> {
  /** Resolved pi-ai model. */
  model: Model<TApi>
  /** System prompt (always required, even if empty). */
  systemPrompt: string
  /** API key resolved by the caller (handles OAuth refresh upstream). */
  apiKey: string
  /**
   * Span purpose label (`router`, `callLlm`, `session-summary`, etc.).
   * Required: every traced sub-call must carry one so the trace is filterable.
   */
  purpose: string

  /**
   * Single user message content — string or vision array. Mutually exclusive
   * with `messages`. If both are omitted, the helper throws.
   */
  userContent?: string | (TextContent | ImageContent)[]
  /**
   * Pre-built messages array for callers that need multi-turn context (e.g.
   * background extraction replaying recent turns). Pass through `as` cast
   * if your message shape is `AgentMessage` rather than pi-ai's `Message`.
   */
  messages?: PiContext['messages']

  /** Max output tokens. Defaults to provider default when omitted. */
  maxTokens?: number
  /** Sampling temperature. Pass 0 for deterministic, reproducible calls
   *  (e.g. the audit judge). Defaults to the provider default when omitted. */
  temperature?: number
  /** Abort signal (compaction passes the agent's signal here). */
  signal?: AbortSignal

  /** Tracer — when null/undefined, the call goes through raw `completeSimple`. */
  tracer?: PipilotTracer | null
  /** Auth mode for `pipilot.auth.mode` span attribute. */
  authMode?: PipilotAuthMode
  /**
   * OTel parent context override. Pass `ROOT_CONTEXT` to detach from any
   * active task trace (background extractors, wiki bg agent).
   */
  parent?: Context
  /**
   * Invoked after a successful completion with `(usage, cost)`. Same shape
   * the main agent loop's `turn_end` produces, so a single accumulator can
   * service both. Without this, sub-LLM calls (router, summarizer, memory
   * extractor, wiki-bg) consume billable tokens but never reach `usage.json`
   * or the StatusBar (G1, telemetry-trace v0.13). Fires for both the traced
   * and non-traced branches.
   */
  onUsage?: (usage: Usage, cost: Usage['cost']) => void
}

/**
 * Run a one-shot sub-LLM call and return the assistant's text content.
 * Returns empty string if the response had no text part — callers that need
 * to distinguish empty-response from no-text-part should inspect raw via
 * `tracedCompleteSimple` directly.
 */
export async function runSubLlmText<TApi extends string>(
  opts: RunSubLlmOpts<TApi>
): Promise<string> {
  const messages = opts.messages ?? (
    opts.userContent !== undefined
      ? ([{ role: 'user', content: opts.userContent, timestamp: Date.now() }] as PiContext['messages'])
      : null
  )
  if (!messages) {
    throw new Error('runSubLlmText: must provide either `userContent` or `messages`')
  }

  const piContext: PiContext = {
    systemPrompt: opts.systemPrompt,
    messages
  }
  const llmOpts: SimpleStreamOptions = { apiKey: opts.apiKey }
  if (opts.maxTokens !== undefined) llmOpts.maxTokens = opts.maxTokens
  if (opts.temperature !== undefined) llmOpts.temperature = opts.temperature
  if (opts.signal) llmOpts.signal = opts.signal

  const result = opts.tracer
    ? await tracedCompleteSimple(opts.model, piContext, llmOpts, {
        tracer: opts.tracer,
        ...(opts.parent && { parent: opts.parent }),
        ...(opts.authMode && { authMode: opts.authMode }),
        purpose: opts.purpose,
        ...(opts.onUsage && { onUsage: opts.onUsage })
      })
    : await completeSimple(opts.model, piContext, llmOpts)

  // Telemetry-disabled / no-tracer branch: tracedCompleteSimple's onUsage hook
  // never fires, so we mirror the same emission here. Sub-LLM tokens must be
  // visible to the accumulator regardless of telemetry mode.
  if (!opts.tracer && opts.onUsage && result.stopReason !== 'error' && result.stopReason !== 'aborted') {
    opts.onUsage(result.usage, result.usage.cost)
  }

  const textContent = result.content.find((c): c is TextContent => c.type === 'text')
  return textContent?.text ?? ''
}
