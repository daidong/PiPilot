/**
 * TraceStore — bounded ring queue + trace-level atomic drop policy + tombstone sidecar
 * + degraded-mode handling + runtime disable (§5.1).
 *
 * Wraps `JsonlSpanExporter` and provides the queue-management discipline the spec
 * mandates. Implemented as an OTel SpanProcessor so it slots into a TracerProvider
 * naturally.
 *
 * Invariants:
 *   - Queue capacity (default 1024) is hard. Going over triggers trace-level drop.
 *   - Once a traceId is dropped, ALL future spans of that traceId are suppressed for
 *     the rest of the process lifetime (in-memory `Set<string>`).
 *   - The spans file stays pure OTLP/JSON; tombstones go to a sidecar file.
 *   - Disk-full / write error → degraded mode (logged; subsequent spans counted as dropped).
 *   - Runtime disable drains queue and short-circuits subsequent ingest.
 *   - Process exit: synchronous `flushNow()` with 5-second timeout.
 */

import { join } from 'node:path'
import type { Context } from '@opentelemetry/api'
import type { Span, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/core'
import { PATHS } from '../types.js'
import { JsonlSpanExporter } from './exporters/jsonl.js'
import { appendJsonl } from './jsonl-writer.js'
import { createTracingStateLogger, type TracingStateLogger } from './tracing-state.js'

export interface TraceStoreOptions {
  projectPath: string
  /** Default 1024. */
  bufferCapacity?: number
  /** Default 64 spans. Flush trigger when queue size hits this. */
  batchSize?: number
  /** Default 200ms. Flush trigger after idle period. */
  idleFlushMs?: number
  /** Optional clock override for testing. */
  now?: () => Date
  /** Inject custom exporter (testing). */
  exporter?: JsonlSpanExporter
  /** Inject tracing-state logger (testing). */
  tracingStateLogger?: TracingStateLogger
  /** Default false. When true, skip the background flush timer (tests drive flushNow manually). */
  disableTimer?: boolean
}

interface TombstoneRow {
  traceId: string
  kind: 'trace_dropped'
  reason: 'queue_full' | 'manual' | 'degraded'
  droppedAtSpanCount: number
  timestamp: string
}

function dateStampUtc(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * SpanProcessor + queue manager. The actual JSONL append happens via an
 * embedded JsonlSpanExporter; TraceStore just regulates flow into it.
 */
export class TraceStore implements SpanProcessor {
  private readonly projectPath: string
  private readonly capacity: number
  private readonly batchSize: number
  private readonly idleMs: number
  private readonly now: () => Date
  private readonly exporter: JsonlSpanExporter
  private readonly tracingState: TracingStateLogger

  /** FIFO of ended spans pending flush. Insertion order = arrival order. */
  private queue: ReadableSpan[] = []

  /** Per-trace ordering: traceId → first-arrival sequence number. */
  private traceFirstSeen: Map<string, number> = new Map()
  private nextTraceSeq = 0

  /** Permanent tombstone set. Once a traceId lands here, its spans are dropped. */
  private tombstoned: Set<string> = new Set()

  /** Per-trace count of spans already FLUSHED to disk (used in tombstone payload). */
  private flushedCountByTrace: Map<string, number> = new Map()

  private dropCounter = 0
  private degraded = false
  private disabled = false
  private flushTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private flushInFlight: Promise<void> | null = null

  constructor(opts: TraceStoreOptions) {
    this.projectPath = opts.projectPath
    this.capacity = opts.bufferCapacity ?? 1024
    this.batchSize = opts.batchSize ?? 64
    this.idleMs = opts.idleFlushMs ?? 200
    this.now = opts.now ?? (() => new Date())
    this.exporter =
      opts.exporter ??
      new JsonlSpanExporter({
        projectPath: this.projectPath,
        onError: (err) => this.enterDegraded(err)
      })
    this.tracingState = opts.tracingStateLogger ?? createTracingStateLogger(this.projectPath)
    if (!opts.disableTimer) {
      this.scheduleIdleFlush()
    }
  }

  // ----- SpanProcessor contract -----

  onStart(_span: Span, _parentContext: Context): void {
    // No-op: we ingest on end. Concurrency is handled by AsyncLocalStorage upstream.
  }

  onEnd(span: ReadableSpan): void {
    if (this.disabled) return
    const traceId = span.spanContext().traceId

    // Already-tombstoned trace? Suppress permanently.
    if (this.tombstoned.has(traceId)) {
      this.dropCounter++
      return
    }

    if (!this.traceFirstSeen.has(traceId)) {
      this.traceFirstSeen.set(traceId, this.nextTraceSeq++)
    }

    this.queue.push(span)

    // Capacity check: trace-level atomic drop (newest in-flight trace).
    if (this.queue.length > this.capacity) {
      this.dropNewestInFlightTrace('queue_full')
    }

    if (this.queue.length >= this.batchSize) {
      this.flushNow().catch(() => {})
    }
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    return this.flushNow()
      .then(async () => {
        // Flush partial-day stats on graceful shutdown so the daily ledger
        // doesn't lose the in-flight day.
        if (this.dailyBytes > 0 && this.currentDayStamp) {
          const row = {
            date: this.currentDayStamp,
            approxBytes: this.dailyBytes,
            partial: true,
            timestamp: new Date().toISOString()
          }
          await appendJsonl(join(this.projectPath, PATHS.traceStorageStats), row, {
            onError: () => {}
          })
        }
      })
      .then(() => this.exporter.shutdown())
  }

  forceFlush(): Promise<void> {
    return this.flushNow()
  }

  // ----- Public ops (used by ipc.ts on settings toggle / project close) -----

  /** Drain queue and stop processing. Used when `tracingMode = 'disabled'`. */
  async disable(reason: string = 'tracingMode=disabled'): Promise<void> {
    if (this.disabled) return
    this.disabled = true
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flushNow()
    void this.tracingState.append({
      kind: 'tracing-mode-change',
      fromState: 'enabled',
      toState: 'disabled',
      actor: 'user',
      reason
    })
  }

  /** Re-enable after a previous disable. */
  enable(reason: string = 'tracingMode=enabled'): void {
    if (!this.disabled) return
    this.disabled = false
    this.scheduleIdleFlush()
    void this.tracingState.append({
      kind: 'tracing-mode-change',
      fromState: 'disabled',
      toState: 'enabled',
      actor: 'user',
      reason
    })
  }

  get droppedCount(): number {
    return this.dropCounter
  }

  get isDegraded(): boolean {
    return this.degraded
  }

  get queueSize(): number {
    return this.queue.length
  }

  get tombstoneCount(): number {
    return this.tombstoned.size
  }

  // ----- Internals -----

  private scheduleIdleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.flushNow().catch(() => {})
      }
    }, this.idleMs)
    // Don't keep the event loop alive solely for the flush timer.
    if (typeof this.flushTimer === 'object' && this.flushTimer && 'unref' in this.flushTimer) {
      ;(this.flushTimer as { unref: () => void }).unref()
    }
  }

  /**
   * Pick the newest-in-flight trace and drop ALL of its queued spans + tombstone
   * the traceId. Must reduce queue size by ≥ 1 (otherwise we'd loop indefinitely).
   */
  private dropNewestInFlightTrace(reason: TombstoneRow['reason']): void {
    // Find traceIds currently in queue, ordered by arrival sequence (highest first).
    const traceIdsInQueue = new Set<string>()
    for (const s of this.queue) traceIdsInQueue.add(s.spanContext().traceId)
    if (traceIdsInQueue.size === 0) return

    let newestTraceId: string | null = null
    let newestSeq = -1
    for (const tid of traceIdsInQueue) {
      const seq = this.traceFirstSeen.get(tid) ?? -1
      if (seq > newestSeq) {
        newestSeq = seq
        newestTraceId = tid
      }
    }
    if (!newestTraceId) return

    // Tombstone now (suppresses future spans of this trace immediately).
    this.tombstoned.add(newestTraceId)

    // Drop queued spans of this trace.
    let droppedFromQueue = 0
    this.queue = this.queue.filter((s) => {
      if (s.spanContext().traceId === newestTraceId) {
        droppedFromQueue++
        return false
      }
      return true
    })
    this.dropCounter += droppedFromQueue

    // Tombstone row: payload notes how many spans of this trace were already flushed.
    const alreadyFlushed = this.flushedCountByTrace.get(newestTraceId) ?? 0
    const row: TombstoneRow = {
      traceId: newestTraceId,
      kind: 'trace_dropped',
      reason,
      droppedAtSpanCount: alreadyFlushed,
      timestamp: this.now().toISOString()
    }
    void this.writeTombstone(row)
    void this.tracingState.append({
      kind: 'trace-dropped',
      reason,
      detail: { traceId: newestTraceId, droppedFromQueue, alreadyFlushed }
    })
  }

  private tombstoneFilePath(): string {
    return join(this.projectPath, PATHS.traces, `tombstones.${dateStampUtc(this.now())}.jsonl`)
  }

  private async writeTombstone(row: TombstoneRow): Promise<void> {
    const ok = await appendJsonl(this.tombstoneFilePath(), row, {
      onError: (err) => this.enterDegraded(err)
    })
    if (!ok) this.enterDegraded(new Error('tombstone write failed'))
  }

  /**
   * Drain queue → exporter. Re-entrancy safe (in-flight promise is reused).
   */
  flushNow(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight
    if (this.queue.length === 0) return Promise.resolve()
    const batch = this.queue.splice(0, this.queue.length)

    // Update flushed counts so future tombstones can report `droppedAtSpanCount`.
    for (const s of batch) {
      const tid = s.spanContext().traceId
      this.flushedCountByTrace.set(tid, (this.flushedCountByTrace.get(tid) ?? 0) + 1)
    }

    // Approximate byte volume for storage-stats accounting (§5.6 / §12.2).
    // Cheap: count attribute keys + name length per span × ~64 bytes baseline.
    // The real number lives in the JSONL file; this is a runtime estimate so
    // operators can spot growth without re-scanning files.
    const approxBytes = batch.reduce((acc, s) => {
      const attrCount = Object.keys(s.attributes).length
      return acc + 64 + s.name.length + attrCount * 32 + s.events.length * 80
    }, 0)
    this.dailyBytes += approxBytes
    void this.maybeRollDailyStats()

    this.flushInFlight = new Promise<void>((resolve) => {
      this.exporter.export(batch, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          this.enterDegraded(result.error ?? new Error('exporter returned FAILED'))
        }
        this.flushInFlight = null
        resolve()
      })
    })
    return this.flushInFlight
  }

  /** Bytes accumulated for the current UTC day. Resets on day boundary. */
  private dailyBytes = 0
  private currentDayStamp = ''

  private async maybeRollDailyStats(): Promise<void> {
    const stamp = (() => {
      const d = this.now()
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    })()
    if (this.currentDayStamp === '') {
      this.currentDayStamp = stamp
      return
    }
    if (stamp === this.currentDayStamp) return
    // Day rolled over; flush yesterday's stats row and reset.
    const filePath = join(this.projectPath, PATHS.traceStorageStats)
    const row = {
      date: this.currentDayStamp,
      approxBytes: this.dailyBytes,
      timestamp: new Date().toISOString()
    }
    this.currentDayStamp = stamp
    this.dailyBytes = 0
    await appendJsonl(filePath, row, { onError: () => {} })
  }

  private enterDegraded(err: unknown): void {
    if (this.degraded) return
    this.degraded = true
    void this.tracingState.append({
      kind: 'trace-store-degraded-enter',
      actor: 'system',
      reason: err instanceof Error ? err.message : String(err)
    })
  }
}
