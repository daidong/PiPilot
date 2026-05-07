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
  /**
   * Set when the digest is materialized for a trace whose raw spans were
   * dropped (TraceStore tombstone) — analysis tools should NOT treat the
   * token / tool counts as authoritative for these rows.
   */
  droppedReason?: 'tombstoned' | 'evicted'
}

interface TraceState {
  rootSpan: ReadableSpan | null
  spans: Map<string, ReadableSpan> // by spanId
  toolCallsByCategory: Record<string, number>
  tokens: { input: number; output: number; cache_read: number; cache_creation: number }
  /** Last span-arrival time. Used by the eviction sweeper to drop rootless
   *  traces (e.g. wiki-bg sub-LLM calls that never see an invoke_agent span). */
  lastActivityMs: number
}

/**
 * Eviction window for rootless traces. Sub-LLM calls (wiki-bg, summarizer,
 * memory extractor) often run with `parent: ROOT_CONTEXT` and emit a single
 * `chat` span with no `invoke_agent` ancestor — without eviction those
 * entries linger in the in-memory map forever. 10 min is comfortably longer
 * than any single agent turn, so a real in-progress trace won't be evicted
 * mid-run.
 */
const ROOTLESS_EVICTION_MS = 10 * 60 * 1000
/** How often the sweeper runs. Cheap (Map.entries scan); 60s is fine. */
const SWEEP_INTERVAL_MS = 60 * 1000

export interface TraceDigestProcessorOptions {
  /** Predicate from the sibling TraceStore — true if this traceId was dropped. */
  isTombstoned?: (traceId: string) => boolean
  /** Test-only: disable the periodic sweeper. */
  disableSweepTimer?: boolean
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
  private readonly isTombstoned?: (traceId: string) => boolean
  private sweepTimer: NodeJS.Timeout | null = null
  private evictedCount = 0

  constructor(projectPath: string, options: TraceDigestProcessorOptions = {}) {
    this.projectPath = projectPath
    this.isTombstoned = options.isTombstoned
    if (!options.disableSweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepRootless(), SWEEP_INTERVAL_MS)
      if (typeof this.sweepTimer === 'object' && this.sweepTimer && 'unref' in this.sweepTimer) {
        ;(this.sweepTimer as { unref: () => void }).unref()
      }
    }
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
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        lastActivityMs: Date.now()
      }
      this.traces.set(traceId, state)
    } else {
      state.lastActivityMs = Date.now()
    }
    state.spans.set(ctx.spanId, span)

    const attrs = span.attributes as Record<string, unknown>
    const op = attrs['gen_ai.operation.name']

    // Aggregate tokens from chat AND main-loop step spans (G2, v0.13).
    // Pre-v0.13 only `chat` spans (sub-LLM via tracedCompleteSimple) were
    // counted, so digest tokens reflected sub-LLM only — not the actual
    // bulk of an agent run. The two surfaces are disjoint:
    //   - `chat` op       → sub-LLM (router, summarizer, wiki-bg, …)
    //   - `invoke_agent` step → main loop (one per pi-mono turn)
    // No double-counting because pi-ai itself emits no spans inside the
    // main loop. Step span carries the full usage as of v0.13 too (cache
    // attrs added in telemetry-adapter onto these spans).
    const isMainLoopStep =
      op === 'invoke_agent' && typeof span.name === 'string' && span.name.startsWith('invoke_agent step')
    if (op === 'chat' || isMainLoopStep) {
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    return Promise.resolve()
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  /** Test/diagnostic: number of rootless traces evicted by the sweeper. */
  get evictionCount(): number {
    return this.evictedCount
  }

  /** Test/diagnostic: current in-memory trace state count. */
  get pendingTraceCount(): number {
    return this.traces.size
  }

  /**
   * Drop in-memory state for traces that haven't seen activity for
   * ROOTLESS_EVICTION_MS. These are typically sub-LLM calls (wiki-bg,
   * memory extractor, summarizer) that ran with `parent: ROOT_CONTEXT` and
   * never produced an `invoke_agent` root — without eviction they leak
   * proportionally to the number of background calls.
   */
  private sweepRootless(): void {
    if (this.traces.size === 0) return
    const now = Date.now()
    const cutoff = now - ROOTLESS_EVICTION_MS
    for (const [traceId, state] of this.traces) {
      if (state.lastActivityMs < cutoff) {
        this.traces.delete(traceId)
        this.evictedCount++
      }
    }
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
    // If the sibling TraceStore tombstoned this trace (queue overflow,
    // manual drop, degraded write-failure), the raw spans were discarded.
    // Mark the digest row so analysis tools don't treat the aggregates as
    // authoritative — token counts will reflect only the spans that reached
    // this processor before the drop.
    if (this.isTombstoned?.(traceId)) {
      row.degraded = true
      row.droppedReason = 'tombstoned'
    }
    await appendJsonl(join(this.projectPath, PATHS.traceDigest), row, { onError: () => {} })
  }
}
