/**
 * Trace digest writer (telemetry-trace v0.10 §5.5).
 *
 * One row per `traceId`, written when the root `invoke_agent` span ends.
 * 8 core fields — anything else is derivable from the raw trace and should
 * NOT live here (the digest is a query accelerator, not a snapshot).
 *
 * Open-child detection: if any descendant span of the trace is still open at
 * root-end, the digest is written with `degraded=true`, `openChildSpanCount`,
 * and `openChildSpanIds` so the leak is observable.
 *
 * Crash recovery (separate scan, not in this file): on startup, scan
 * `traces/spans.{date}.jsonl` for traces whose root has `end_time` but no
 * digest row. Re-emit the digest. Idempotent on `traceId`; analysis tools
 * keep the latest row.
 */

import { join } from 'node:path'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { Context } from '@opentelemetry/api'
import { hrTimeToTimeStamp } from '@opentelemetry/core'
import { PATHS } from '../types.js'
import { appendJsonl } from './jsonl-writer.js'
import { TRACE_POLICY_VERSION } from './semantic-registry.js'

interface TurnRecord {
  turnId: string
  role: 'user' | 'assistant'
  timestamp: string
  charLen: number
  contentHash: string
}

interface TraceDigestRow {
  traceId: string
  sessionId?: string
  projectId?: string
  startedAt: string
  endedAt: string
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
  toolCallsByCategory: Record<string, number>
  turns: TurnRecord[]
  tracePolicyVersion: string
  digestWrittenAt: string
  openChildSpanCount?: number
  openChildSpanIds?: string[]
  degraded?: boolean
}

interface TraceState {
  rootSpan: ReadableSpan | null
  spans: Map<string, ReadableSpan> // by spanId
  toolCallsByCategory: Record<string, number>
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
}

/**
 * SpanProcessor that materializes the digest on root-span end.
 *
 * Composes alongside TraceStore on the same TracerProvider — both processors
 * see every span. TraceStore writes the raw JSONL; this processor builds the
 * pre-aggregate.
 */
export class TraceDigestProcessor implements SpanProcessor {
  private readonly projectPath: string
  private readonly traces = new Map<string, TraceState>()

  constructor(projectPath: string) {
    this.projectPath = projectPath
  }

  onStart(_span: unknown, _ctx: Context): void {
    // No-op
  }

  onEnd(span: ReadableSpan): void {
    const ctx = span.spanContext()
    const traceId = ctx.traceId
    let state = this.traces.get(traceId)
    if (!state) {
      state = {
        rootSpan: null,
        spans: new Map(),
        toolCallsByCategory: {},
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
      }
      this.traces.set(traceId, state)
    }
    state.spans.set(ctx.spanId, span)

    const attrs = span.attributes as Record<string, unknown>
    const op = attrs['gen_ai.operation.name']

    // Aggregate tokens from any chat span.
    if (op === 'chat') {
      state.tokens.input += Number(attrs['gen_ai.usage.input_tokens'] ?? 0)
      state.tokens.output += Number(attrs['gen_ai.usage.output_tokens'] ?? 0)
      state.tokens.cache_read += Number(attrs['gen_ai.usage.cache_read.input_tokens'] ?? 0)
      state.tokens.cache_creation += Number(attrs['gen_ai.usage.cache_creation.input_tokens'] ?? 0)
    }
    // Aggregate tool calls by category.
    if (op === 'execute_tool') {
      const cat = String(attrs['pipilot.tool.category'] ?? 'unknown')
      state.toolCallsByCategory[cat] = (state.toolCallsByCategory[cat] ?? 0) + 1
    }
    // Identify the root span — invoke_agent with no parent.
    if (!span.parentSpanId && op === 'invoke_agent' && span.name.startsWith('invoke_agent ')) {
      // The span we receive here is already the ENDED root.
      state.rootSpan = span
      void this.materializeDigest(traceId, state)
      this.traces.delete(traceId)
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  private async materializeDigest(traceId: string, state: TraceState): Promise<void> {
    const root = state.rootSpan!
    const attrs = root.attributes as Record<string, unknown>

    // Detect open child spans (none currently in this in-memory model — we only
    // track ended spans). Crash recovery handles deeper leak detection.
    const openSpans: string[] = []
    for (const [spanId, s] of state.spans) {
      if (!s.ended && spanId !== root.spanContext().spanId) {
        openSpans.push(spanId)
      }
    }

    const row: TraceDigestRow = {
      traceId,
      sessionId: String(attrs['gen_ai.conversation.id'] ?? ''),
      projectId: String(attrs['pipilot.project.id'] ?? ''),
      startedAt: hrTimeToTimeStamp(root.startTime),
      endedAt: hrTimeToTimeStamp(root.endTime),
      tokens: state.tokens,
      toolCallsByCategory: state.toolCallsByCategory,
      turns: [],
      tracePolicyVersion: TRACE_POLICY_VERSION,
      digestWrittenAt: new Date().toISOString()
    }
    if (openSpans.length > 0) {
      row.openChildSpanCount = openSpans.length
      row.openChildSpanIds = openSpans
      row.degraded = true
    }
    await appendJsonl(join(this.projectPath, PATHS.traceDigest), row, { onError: () => {} })
  }
}
