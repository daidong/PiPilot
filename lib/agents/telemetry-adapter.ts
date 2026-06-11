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
  /**
   * Mark the start/end of a user turn (one root `invoke_agent` span). Call
   * from coordinator before/after `runChatBody()` inside `tracer.runInSpan`.
   * Used by the v0.12 wire-payload reduction policy: full
   * `pipilot.chat.request_payload` is only recorded on step 1 of each user
   * turn — steps 2..N add one assistant + one tool_result over step (N-1),
   * which is reconstructable from the response_text + tool.result events on
   * those steps.
   */
  markUserTurnStart(): void
  markUserTurnEnd(): void
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

/**
 * The per-step input delta recorded as `pipilot.chat.input_delta`: what entered
 * (and, on compaction, left) the model's context since the previous step.
 */
export interface InputDelta {
  /** Messages new in this step's input vs the previous step's. */
  appended: unknown[]
  /** Messages present last step but gone now — non-empty only on compaction. */
  removed: unknown[]
  /** Count of leading + trailing messages carried over unchanged. */
  carriedOver: number
}

/**
 * Provider message arrays carry volatile `cache_control` markers whose position
 * shifts between consecutive steps (the v0.12 reduction note calls this out as
 * "the only information actually lost"). Strip them so a marker move on an
 * otherwise-identical message doesn't masquerade as a content change and blow
 * up the diff.
 */
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = stripVolatile(val)
    }
    return out
  }
  return v
}

function messageKey(m: unknown): string {
  try { return JSON.stringify(stripVolatile(m)) } catch { return String(m) }
}

/**
 * The conversation array inside a provider wire payload. Providers name it
 * differently, so we probe the known keys in order:
 *   - `messages`  — Anthropic, OpenAI-compatible chat, Mistral, Bedrock
 *   - `input`     — OpenAI/Azure/Codex Responses API (what GPT runs send)
 *   - `contents`  — Google Gemini / Vertex
 * Returns the first one that is an array; `[]` otherwise (a string `input`,
 * or an unrecognized shape, yields no delta rather than a wrong one).
 */
function extractMessages(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  for (const key of ['messages', 'input', 'contents']) {
    if (Array.isArray(p[key])) return p[key] as unknown[]
  }
  return []
}

/**
 * Diff two provider payloads by their message arrays, trimming the common
 * leading prefix AND trailing suffix. Normal step growth → `appended` only.
 * Compaction (an early chunk replaced by a summary, the recent tail kept) →
 * `removed` (the dropped messages) + `appended` (the summary), with the
 * surviving tail correctly excluded from both. This is exactly "this step's
 * input minus last step's", so compaction is captured natively — no separate
 * compaction-event bookkeeping. `cache_control` marker shifts are normalized out.
 */
export function diffPayloadMessages(prev: unknown, curr: unknown): InputDelta {
  const a = extractMessages(prev).map(m => ({ raw: m, key: messageKey(m) }))
  const b = extractMessages(curr).map(m => ({ raw: m, key: messageKey(m) }))
  let p = 0
  const maxP = Math.min(a.length, b.length)
  while (p < maxP && a[p].key === b[p].key) p++
  let s = 0
  const maxS = Math.min(a.length, b.length) - p
  while (s < maxS && a[a.length - 1 - s].key === b[b.length - 1 - s].key) s++
  return {
    appended: b.slice(p, b.length - s).map(x => x.raw),
    removed: a.slice(p, a.length - s).map(x => x.raw),
    carriedOver: p + s
  }
}

export function createCoordinatorTelemetryAdapter(
  opts: CoordinatorTelemetryAdapterOptions
): CoordinatorTelemetryAdapter {
  const { tracer, getTurnId, getThinkingLevel, debug } = opts

  let activeStepSpan: Span | null = null
  let activeStepIndex = 0
  /**
   * Per-user-turn step counter (resets at every `markUserTurnStart`). Distinct
   * from `activeStepIndex`, which is session-monotonic and lives on
   * `pipilot.step.index`. This counter exists only to gate the wire-payload
   * recording: emit on step 1 of each user turn, suppress on steps 2..N.
   *
   * Why per-turn rather than session-monotonic: each user turn enters a fresh
   * agent loop whose first step has the only "novel" wire content for that
   * turn (system + tools + the new user message + prior history). Steps 2..N
   * differ from step 1 by exactly one assistant response + one tool_result,
   * both already captured as separate span events. Recording the full payload
   * on each step costs O(steps²) bytes for O(steps) novel content.
   */
  let stepIndexInUserTurn = 0
  const toolCallSpans = new Map<string, Span>()

  /**
   * The previous step's wire payload, kept across the whole session (not reset
   * per user turn) so every step after the very first carries a small, exact
   * input delta — including the first step of each user turn, whose delta is
   * just the new user message. Null only before the session's first onPayload.
   */
  let prevPayload: unknown = null

  /**
   * Build an onBlobError handler that records dangling-blob counts on the
   * supplied span. Without this, oversized payloads that fail to persist
   * (disk full, perms) still emit { contentHash } refs to bytes that don't
   * exist on disk, with no signal in the trace.
   */
  const blobErrorRecorder = (span: Span | null) => (err: unknown): void => {
    if (!span) return
    const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes
    const prev = typeof attrs?.['pipilot.blob.write_failed_count'] === 'number'
      ? (attrs['pipilot.blob.write_failed_count'] as number)
      : 0
    span.setAttribute('pipilot.blob.write_failed_count', prev + 1)
    const msg = err instanceof Error ? err.message : String(err)
    span.setAttribute('pipilot.blob.write_failed_message', msg)
  }

  return {
    async onPayload(payload) {
      if (!tracer || !activeStepSpan) return undefined
      // Advance the cross-step cursor first so it tracks every step even if
      // recording below throws.
      const prior = prevPayload
      prevPayload = payload
      try {
        // v0.12 wire-payload reduction: the FULL request payload is recorded
        // only on step 1 of each user turn — it's the per-turn anchor. Steps
        // 2..N would re-record the whole growing message-history array
        // (O(steps²) bytes for O(steps) of novel content), so instead each
        // step records just its input *delta* below.
        if (stepIndexInUserTurn === 1) {
          const { value: redactedPayload } = redact(payload, {
            sizeCapBytes: 4096,
            blobStore: tracer.blobs,
            onBlobError: blobErrorRecorder(activeStepSpan)
          })
          activeStepSpan.addEvent('pipilot.chat.request_payload', {
            body: JSON.stringify(redactedPayload)
          } as Attributes)
        }

        // Per-step input delta: what entered (and, on compaction, left) the
        // model's context since the previous step. The diff runs across the
        // whole session, so every step after the first carries a small, exact
        // delta — the basis for "what did this step actually see that the last
        // one didn't". Skipped on the session's first step (no prior payload);
        // that step's full input is the request_payload above.
        if (prior !== null) {
          const delta = diffPayloadMessages(prior, payload)
          if (delta.appended.length > 0 || delta.removed.length > 0) {
            const { value: redactedDelta } = redact(delta, {
              sizeCapBytes: 4096,
              blobStore: tracer.blobs,
              onBlobError: blobErrorRecorder(activeStepSpan)
            })
            activeStepSpan.addEvent('pipilot.chat.input_delta', {
              body: JSON.stringify(redactedDelta)
            } as Attributes)
          }
        }
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
        blobStore: tracer.blobs,
        onBlobError: blobErrorRecorder(span)
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
            blobStore: tracer.blobs,
            onBlobError: blobErrorRecorder(span)
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
        stepIndexInUserTurn++
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
          // Full usage on the step span (G2, v0.13). cache_read /
          // cache_creation were missing before — that meant trace digest
          // couldn't recover them when aggregating main-loop tokens, and
          // any cost re-derivation from trace data was off.
          activeStepSpan.setAttributes({
            'gen_ai.usage.input_tokens': msg.usage.input ?? 0,
            'gen_ai.usage.output_tokens': msg.usage.output ?? 0,
            'gen_ai.usage.cache_read.input_tokens': msg.usage.cacheRead ?? 0,
            'gen_ai.usage.cache_creation.input_tokens': msg.usage.cacheWrite ?? 0
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
              blobStore: tracer.blobs,
              onBlobError: blobErrorRecorder(activeStepSpan)
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
    },

    markUserTurnStart() {
      stepIndexInUserTurn = 0
    },

    markUserTurnEnd() {
      stepIndexInUserTurn = 0
    }
  }
}
