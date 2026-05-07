/**
 * Trace store (P2.3) — in-memory accumulator of LiveSpanSummary events.
 *
 * Subscribes to `trace:live` IPC and accumulates spans keyed by `traceId`.
 * On mount, callers can `hydrate(traceId)` to pull the on-disk snapshot via
 * `trace:snapshot` (handles cold-start when the renderer joined mid-trace).
 *
 * Boundaries:
 *   - This store is a **derived view** over the trace stream. It doesn't own
 *     state — TraceStore on the main side is authoritative; everything here
 *     is reconstructable from disk via `telemetryTraceSnapshot`.
 *   - Bounded: the in-memory cache holds at most `MAX_TRACES` traces (default
 *     50, FIFO eviction). Older traces remain on disk and are re-fetched on
 *     demand.
 *   - RealtimeBuffer (the legacy in-memory activity log) is NOT replaced by
 *     this store yet. P2 ships both side-by-side. P2.5 documents the parity
 *     check; the cutover is a future-spec decision.
 */

import { create } from 'zustand'

interface RendererApi {
  onTraceLive?: (cb: (s: LiveSpanSummary) => void) => () => void
  telemetryTraceSnapshot?: (traceId: string) => Promise<TraceSnapshotPayload>
}

// Resolve at call time so tests can stub `window.api` after module init.
function getApi(): RendererApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as any).api as RendererApi | undefined
}

export interface LiveSpanSummary {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTime: string
  endTime: string
  durationMs: number
  statusCode: number
  statusMessage?: string
  attributes: Record<string, string | number | boolean>
  events: Array<{ name: string; timestamp: string }>
}

interface TraceSnapshotPayload {
  traceId: string
  spans: LiveSpanSummary[]
  dropped?: boolean
  dropReason?: string
  error?: string
}

interface TraceEntry {
  traceId: string
  spans: LiveSpanSummary[]
  /** True if a snapshot has been fetched (vs only live deltas). */
  hydrated: boolean
  dropped?: boolean
  dropReason?: string
  /** Monotonic sequence number — drives FIFO eviction and "newest first" ordering.
   *  Wall-clock ms is too coarse: bursts within a single ms collide, breaking
   *  the eviction order. */
  lastUpdated: number
}

const MAX_TRACES = 50

// Per-process monotonic counter — bumped on every span merge so eviction has
// strictly increasing values. Survives test fixtures (cleared via store.clear()
// only resets the Map, not the counter — that's fine; ordering still holds).
let _seq = 0
function nextSeq(): number {
  return ++_seq
}

interface TraceStoreState {
  traces: Map<string, TraceEntry>
  liveAttached: boolean
  attachLive: () => void
  detachLive: () => void
  /** Pull a trace's spans from disk (for traces that completed before mount). */
  hydrate: (traceId: string) => Promise<void>
  /** Get a snapshot of a trace (from in-memory cache only). */
  getTrace: (traceId: string) => TraceEntry | undefined
  /** All known trace ids, newest-first. */
  listTraceIds: () => string[]
  /** Reset everything (e.g., on project switch). */
  clear: () => void
}

let unsubscribeLive: (() => void) | null = null

function evictIfFull(traces: Map<string, TraceEntry>): Map<string, TraceEntry> {
  if (traces.size <= MAX_TRACES) return traces
  // Evict the oldest (smallest lastUpdated).
  const sorted = [...traces.entries()].sort((a, b) => a[1].lastUpdated - b[1].lastUpdated)
  const overflow = sorted.length - MAX_TRACES
  for (let i = 0; i < overflow; i++) {
    traces.delete(sorted[i]![0])
  }
  return traces
}

function mergeSpan(entry: TraceEntry | undefined, span: LiveSpanSummary): TraceEntry {
  if (!entry) {
    return {
      traceId: span.traceId,
      spans: [span],
      hydrated: false,
      lastUpdated: nextSeq()
    }
  }
  // Dedup by spanId — snapshot + live can deliver overlapping rows.
  const idx = entry.spans.findIndex((s) => s.spanId === span.spanId)
  if (idx >= 0) {
    entry.spans[idx] = span
  } else {
    entry.spans.push(span)
  }
  // Keep spans sorted by startTime so consumers can render a timeline.
  entry.spans.sort((a, b) => a.startTime.localeCompare(b.startTime))
  entry.lastUpdated = nextSeq()
  return entry
}

export const useTraceStore = create<TraceStoreState>((set, get) => ({
  traces: new Map<string, TraceEntry>(),
  liveAttached: false,

  attachLive: () => {
    if (get().liveAttached) return
    const api = getApi()
    if (!api?.onTraceLive) {
      // Renderer running outside Electron (test, preview) — skip silently.
      set({ liveAttached: true })
      return
    }
    unsubscribeLive = api.onTraceLive((summary) => {
      set((state) => {
        const next = new Map(state.traces)
        const merged = mergeSpan(next.get(summary.traceId), summary)
        next.set(summary.traceId, merged)
        return { traces: evictIfFull(next) }
      })
    })
    set({ liveAttached: true })
  },

  detachLive: () => {
    if (unsubscribeLive) {
      unsubscribeLive()
      unsubscribeLive = null
    }
    set({ liveAttached: false })
  },

  hydrate: async (traceId: string) => {
    const api = getApi()
    if (!api?.telemetryTraceSnapshot) return
    const payload = await api.telemetryTraceSnapshot(traceId).catch((): TraceSnapshotPayload => ({
      traceId,
      spans: [],
      error: 'snapshot ipc failed'
    }))
    set((state) => {
      const next = new Map(state.traces)
      const existing = next.get(traceId)
      const merged: TraceEntry = {
        traceId,
        spans: existing ? [...existing.spans] : [],
        hydrated: true,
        dropped: payload.dropped,
        dropReason: payload.dropReason,
        lastUpdated: nextSeq()
      }
      // Merge snapshot spans into the existing buffer — live events delivered
      // before hydration finished should not be lost.
      const seen = new Set(merged.spans.map((s) => s.spanId))
      for (const s of payload.spans) {
        if (!seen.has(s.spanId)) {
          merged.spans.push(s)
          seen.add(s.spanId)
        }
      }
      merged.spans.sort((a, b) => a.startTime.localeCompare(b.startTime))
      next.set(traceId, merged)
      return { traces: evictIfFull(next) }
    })
  },

  getTrace: (traceId: string) => get().traces.get(traceId),

  listTraceIds: () => {
    const entries = [...get().traces.entries()]
    entries.sort((a, b) => b[1].lastUpdated - a[1].lastUpdated)
    return entries.map(([id]) => id)
  },

  clear: () => {
    set({ traces: new Map<string, TraceEntry>() })
  }
}))
