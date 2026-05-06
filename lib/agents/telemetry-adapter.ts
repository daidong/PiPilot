/**
 * Coordinator telemetry adapter — owns the OTel span lifecycle around the
 * pi-mono agent loop.
 *
 * Hides three closure variables that previously had to live in
 * `coordinator.ts`:
 *   - `activeStepSpan`: the open `invoke_agent step` span for the current
 *     turn, used by `onPayload` / `onResponse` (wire capture) and by the
 *     skill-load event recorder.
 *   - `activeStepIndex`: monotonic per-turn counter.
 *   - `toolCallSpans`: open `execute_tool {name}` spans keyed by
 *     `toolCall.id` so sibling parallel tool calls each finalize the
 *     correct span (spec §4.2 fallback).
 *
 * The adapter exposes telemetry-only operations. Coordinator composes
 * non-telemetry side effects (renderer callbacks, skill onLoaded, debug
 * logging) outside this surface.
 *
 * All operations are no-op when `tracer` is null, so callers can wire the
 * hooks unconditionally.
 */

import { SpanKind, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api'
import type {
  AgentEvent,
  BeforeToolCallContext,
  AfterToolCallContext
} from '@mariozechner/pi-agent-core'
import type { ProviderResponse } from '@mariozechner/pi-ai'
import type { PipilotTracer } from '../telemetry/tracer.js'
import { redact, SCRUBBER_VERSION } from '../telemetry/redaction.js'
import { categorizeTool } from '../tools/categories.js'

export type SkillLoadTrigger = 'router-match' | 'explicit-load'

export interface CoordinatorTelemetryAdapter {
  /** Wire to `Agent({ onPayload })`. No-op when no tracer or no active step. */
  onPayload(payload: unknown): Promise<undefined>
  /** Wire to `Agent({ onResponse })`. No-op when no tracer or no active step. */
  onResponse(resp: ProviderResponse): Promise<void>
  /**
   * Telemetry side-effects for the agent's `beforeToolCall` hook. Caller
   * composes with non-telemetry callbacks (onToolCall, debug logging).
   */
  beforeToolCall(ctx: BeforeToolCallContext): void
  /**
   * Telemetry side-effects for the agent's `afterToolCall` hook. Caller
   * composes with onToolResult and skill-load notification.
   */
  afterToolCall(ctx: AfterToolCallContext): void
  /**
   * Process an `AgentEvent` for step-span lifecycle. Call from
   * `agent.subscribe(...)`. Handles only `turn_start` / `turn_end`.
   */
  processAgentEvent(event: AgentEvent): void
  /**
   * Record a `pipilot.skill.load` event on the currently-active step span.
   * No-op when no active step span — callers don't need to guard.
   */
  recordSkillLoadOnActiveStep(skillName: string, trigger: SkillLoadTrigger): void
}

export interface CoordinatorTelemetryAdapterOptions {
  tracer: PipilotTracer | null
  /** Looked up at span-open time so a per-turn id minted at the IPC boundary lands on the span. */
  getTurnId?: () => string | undefined
  /**
   * Looked up at step-span open time. Captures the agent's current thinking
   * level (`xhigh` / `high` / `medium` / `low` / `minimal` / `off`). Mid-session
   * changes via the UI need to land on the next span, hence the accessor
   * shape rather than a static string.
   */
  getThinkingLevel?: () => string | undefined
  debug?: boolean
}

export function createCoordinatorTelemetryAdapter(
  opts: CoordinatorTelemetryAdapterOptions
): CoordinatorTelemetryAdapter {
  const { tracer, getTurnId, getThinkingLevel, debug } = opts

  let activeStepSpan: Span | null = null
  let activeStepIndex = 0
  const toolCallSpans = new Map<string, Span>()

  return {
    async onPayload(payload) {
      if (!tracer || !activeStepSpan) return undefined
      try {
        const { value: redactedPayload } = redact(payload, {
          sizeCapBytes: 4096,
          blobStore: tracer.blobs
        })
        activeStepSpan.addEvent('pipilot.chat.request_payload', {
          body: JSON.stringify(redactedPayload)
        } as Attributes)
      } catch {
        // Telemetry must never affect the LLM call.
      }
      return undefined
    },

    async onResponse(resp) {
      if (!tracer || !activeStepSpan) return
      try {
        activeStepSpan.setAttribute('http.response.status_code', resp.status)
        const wanted = [
          'request-id',
          'x-request-id',
          'anthropic-request-id',
          'anthropic-ratelimit-input-tokens-remaining',
          'anthropic-ratelimit-output-tokens-remaining',
          'x-ratelimit-remaining-requests',
          'x-ratelimit-remaining-tokens'
        ]
        for (const k of wanted) {
          const v = resp.headers?.[k] ?? resp.headers?.[k.toLowerCase()]
          if (typeof v === 'string') {
            activeStepSpan.setAttribute(`http.response.header.${k}`, v)
          }
        }
      } catch {
        // ignore
      }
    },

    beforeToolCall(ctx) {
      if (!tracer) return
      const toolName = ctx.toolCall.name
      const span = tracer.startSpan(`execute_tool ${toolName}`, SpanKind.INTERNAL)
      span.setAttributes({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.call.id': ctx.toolCall.id,
        'pipilot.tool.category': categorizeTool(toolName),
        // §6.4: retry_count default 0. Tools that retry internally can bump
        // this via span attribute updates before afterToolCall lands.
        'pipilot.tool.retry_count': 0
      })
      const tid = getTurnId?.()
      if (tid) span.setAttribute('pipilot.turn.id', tid)
      // §6.9: tool args attach as a span event. Same redaction pipeline as
      // chat spans (>4KB → blob ref via tracer.blobs).
      const { value: redactedArgs, stats: argStats } = redact(ctx.args, {
        sizeCapBytes: 4096,
        blobStore: tracer.blobs
      })
      span.addEvent('pipilot.tool.args', {
        body: JSON.stringify(redactedArgs)
      } as Attributes)
      if (argStats.fieldsRedactedCount > 0) {
        span.setAttribute('pipilot.redaction.fields_redacted_count', argStats.fieldsRedactedCount)
        span.setAttribute('pipilot.redaction.scrubber_version', SCRUBBER_VERSION)
      }
      toolCallSpans.set(ctx.toolCall.id, span)
    },

    afterToolCall(ctx) {
      const span = toolCallSpans.get(ctx.toolCall.id)
      if (!span) return
      try {
        if (!tracer) return
        const result = ctx.result as any
        // Two failure surfaces, both must mark the span as ERROR:
        //   - ctx.isError: pi sets this when the tool throws or otherwise
        //     fails before the tool code runs to completion. result may
        //     not carry an isError field in that case.
        //   - result.isError: the tool ran to completion but returned a
        //     structured failure (e.g. our toolError() helper).
        const isError =
          ctx.isError ||
          (result && typeof result === 'object' && 'isError' in result && result.isError === true)
        if (isError) {
          const errorClass = (result.details?.error_code ?? result.error_code ?? 'unknown') as string
          span.setAttribute('pipilot.tool.error_class', errorClass)
          span.setStatus({ code: SpanStatusCode.ERROR })
        } else {
          span.setStatus({ code: SpanStatusCode.OK })
        }
        // §6.9: tool result content attached as a span event.
        try {
          const resultPayload = {
            content: result?.content ?? [],
            details: result?.details ?? null,
            isError
          }
          const { value: redactedResult, stats: resultStats } = redact(resultPayload, {
            sizeCapBytes: 4096,
            blobStore: tracer.blobs
          })
          span.addEvent('pipilot.tool.result', {
            body: JSON.stringify(redactedResult)
          } as Attributes)
          if (resultStats.fieldsRedactedCount > 0) {
            const existing = (span as unknown as { attributes?: Record<string, unknown> })
              .attributes?.['pipilot.redaction.fields_redacted_count']
            const prev = typeof existing === 'number' ? existing : 0
            span.setAttribute(
              'pipilot.redaction.fields_redacted_count',
              prev + resultStats.fieldsRedactedCount
            )
            span.setAttribute('pipilot.redaction.scrubber_version', SCRUBBER_VERSION)
          }
        } catch (err) {
          // Result serialization failure (cycles, exotic types) — record but
          // don't fail the agent path.
          if (debug) console.warn('[Telemetry] tool result event failed:', err)
        }
      } finally {
        span.end()
        toolCallSpans.delete(ctx.toolCall.id)
      }
    },

    processAgentEvent(event) {
      if (!tracer) return
      if (event.type === 'turn_start') {
        activeStepIndex++
        activeStepSpan = tracer.startSpan('invoke_agent step', SpanKind.INTERNAL)
        activeStepSpan.setAttribute('gen_ai.operation.name', 'invoke_agent')
        activeStepSpan.setAttribute('pipilot.step.index', activeStepIndex)
        const tid = getTurnId?.()
        if (tid) activeStepSpan.setAttribute('pipilot.turn.id', tid)
        const tl = getThinkingLevel?.()
        if (tl) activeStepSpan.setAttribute('pipilot.thinking_level', tl)
      } else if (event.type === 'turn_end' && activeStepSpan) {
        const msg = event.message as any
        if (msg?.usage) {
          activeStepSpan.setAttributes({
            'gen_ai.usage.input_tokens': msg.usage.input ?? 0,
            'gen_ai.usage.output_tokens': msg.usage.output ?? 0
          })
        }
        // Capture assistant content text on the step span — main agent loop
        // bypasses tracedCompleteSimple, so without this the per-step
        // response is only reconstructable via the next step's request_payload.
        // Caller-supplied content can be quite large (multiple tool calls,
        // long reasoning), so it goes through the same redaction pipeline
        // (>4KB → blob ref).
        try {
          const content = Array.isArray(msg?.content) ? msg.content : null
          if (content && content.length > 0) {
            const { value: redacted } = redact(content, {
              sizeCapBytes: 4096,
              blobStore: tracer.blobs
            })
            activeStepSpan.addEvent('pipilot.chat.response_text', {
              body: JSON.stringify(redacted)
            } as Attributes)
          }
        } catch (err) {
          if (debug) console.warn('[Telemetry] response_text event failed:', err)
        }
        if (msg?.stopReason && (msg.stopReason === 'error' || msg.stopReason === 'aborted')) {
          activeStepSpan.setStatus({ code: SpanStatusCode.ERROR, message: msg.errorMessage })
        } else {
          activeStepSpan.setStatus({ code: SpanStatusCode.OK })
        }
        activeStepSpan.end()
        activeStepSpan = null
      }
    },

    recordSkillLoadOnActiveStep(skillName, trigger) {
      if (!activeStepSpan) return
      activeStepSpan.addEvent('pipilot.skill.load', { skillName, trigger })
    }
  }
}
