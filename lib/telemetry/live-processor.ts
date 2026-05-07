/**
 * LiveSpanProcessor — fan-out of ended spans to in-process subscribers.
 *
 * Sits alongside TraceStore + TraceDigestProcessor on the TracerProvider.
 * Each ended span is reduced to a compact, serializable summary and pushed
 * to whatever callbacks are registered. Used by the Electron main process to
 * forward span events to the renderer over the `trace:live` IPC channel
 * (P2 §6.7).
 *
 * Design notes:
 * - The summary is **lossy by design**: the full OTLP/JSON envelope is only
 *   needed for forensic analysis. Live UI consumes timing, names, status,
 *   and a few flagged attributes — anything more would bloat IPC.
 * - Subscriber callbacks are sync; if a callback throws, the error is logged
 *   and dropped. The trace path must never block the agent (axiom A4).
 * - Subscribers can register/unregister at any time. Newly-registered
 *   subscribers do NOT receive replays — the in-memory queue is empty by
 *   construction (we only emit on onEnd). For remount recovery, callers use
 *   `trace:snapshot` (P2.2).
 */

import type { Context } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { hrTimeToTimeStamp } from '@opentelemetry/core'

export interface LiveSpanSummary {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** OTel SpanKind enum (0..5). */
  kind: number
  startTime: string
  endTime: string
  /** Duration in ms — derived from hrTime, suitable for UI. */
  durationMs: number
  /** OTel SpanStatusCode (0=UNSET, 1=OK, 2=ERROR). */
  statusCode: number
  statusMessage?: string
  /** Subset of attributes the live UI cares about. Add more as needs surface. */
  attributes: Record<string, string | number | boolean>
  /** Span events (compaction discards, skill loads, etc.) — names + timestamps only. */
  events: Array<{ name: string; timestamp: string }>
}

export type LiveSpanSubscriber = (summary: LiveSpanSummary) => void

/**
 * Attribute keys forwarded to live UI subscribers. Keep this list narrow —
 * everything else is grep-able from raw JSONL after the fact.
 */
const LIVE_ATTR_KEYS = [
  // GenAI semconv basics for chat-shaped spans
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.provider.name',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.tool.name',
  // PiPilot identity / context
  'pipilot.project.id',
  'pipilot.turn.id',
  'pipilot.tool.category',
  'pipilot.tool.error_class',
  'pipilot.auth.mode',
  'pipilot.matched_skills',
  'pipilot.active_skills',
  'pipilot.compaction.discarded_messages',
  'pipilot.resumption.bootstrap_orphans',
  'pipilot.resumption.summary_loaded',
  'pipilot.runtime.full_prompt_hash'
] as const

function pickAttributes(attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const k of LIVE_ATTR_KEYS) {
    const v = attrs[k]
    if (v === undefined) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else if (Array.isArray(v)) {
      // Stringify small arrays (matched_skills, active_skills, finish_reasons).
      out[k] = JSON.stringify(v)
    }
  }
  return out
}

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1_000_000
}

export class LiveSpanProcessor implements SpanProcessor {
  private subscribers = new Set<LiveSpanSubscriber>()

  /** Add a subscriber. Returns an unsubscribe function. */
  subscribe(cb: LiveSpanSubscriber): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  /** Remove all subscribers. Used during shutdown / project switch. */
  clear(): void {
    this.subscribers.clear()
  }

  onStart(_span: ReadableSpan, _ctx: Context): void {
    // Live UI cares about completed spans (with timing + status). We could
    // emit start events too, but that doubles fan-out volume for marginal
    // value — UIs interested in real-time progress already subscribe to
    // pi-agent-core onStream / onToolProgress events upstream.
  }

  onEnd(span: ReadableSpan): void {
    if (this.subscribers.size === 0) return
    const ctx = span.spanContext()
    const summary: LiveSpanSummary = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTime: hrTimeToTimeStamp(span.startTime),
      endTime: hrTimeToTimeStamp(span.endTime),
      durationMs: hrToMs(span.endTime) - hrToMs(span.startTime),
      statusCode: span.status.code,
      statusMessage: span.status.message,
      attributes: pickAttributes(span.attributes as Record<string, unknown>),
      events: span.events.map((e) => ({ name: e.name, timestamp: hrTimeToTimeStamp(e.time) }))
    }
    for (const cb of this.subscribers) {
      try {
        cb(summary)
      } catch (err) {
        // Subscriber failure must not propagate.
        // eslint-disable-next-line no-console
        console.warn('[LiveSpanProcessor] subscriber threw:', err)
      }
    }
  }

  shutdown(): Promise<void> {
    this.clear()
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
}
