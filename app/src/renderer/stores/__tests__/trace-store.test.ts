/**
 * Tests for the renderer-side trace-store (P2.3).
 *
 * Stubs `window.api` so the store can subscribe / hydrate without a real
 * Electron preload bridge. Validates: live span accumulation, dedup,
 * sort order, hydration merge, FIFO eviction, clear/detach.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

interface FakeSummary {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTime: string
  endTime: string
  durationMs: number
  statusCode: number
  attributes: Record<string, string | number | boolean>
  events: Array<{ name: string; timestamp: string }>
}

let liveCallback: ((s: FakeSummary) => void) | null = null
const snapshotResponses = new Map<string, { traceId: string; spans: FakeSummary[]; dropped?: boolean; dropReason?: string }>()
const fakeApi = {
  onTraceLive: (cb: (s: FakeSummary) => void) => {
    liveCallback = cb
    return () => { liveCallback = null }
  },
  telemetryTraceSnapshot: async (traceId: string) =>
    snapshotResponses.get(traceId) ?? { traceId, spans: [] }
}

;(globalThis as { window?: unknown }).window = { api: fakeApi }

// Single import — the store's module-level state is reset between tests by
// calling clear() + detachLive() in beforeEach. The query-string cache-busting
// trick doesn't work with tsx's loader, so we share one store across tests.
import { useTraceStore } from '../trace-store.ts'
const store = useTraceStore

beforeEach(() => {
  // Reset shared mutable state.
  store.getState().clear()
  store.getState().detachLive()
  liveCallback = null
  snapshotResponses.clear()
})

function span(traceId: string, spanId: string, name: string, startMs: number, durMs = 10): FakeSummary {
  const start = new Date(startMs).toISOString()
  const end = new Date(startMs + durMs).toISOString()
  return {
    traceId, spanId, name,
    kind: 1,
    startTime: start, endTime: end,
    durationMs: durMs,
    statusCode: 0,
    attributes: {},
    events: []
  }
}

test('live spans accumulate into a trace entry, dedup by spanId, sorted by startTime', async () => {
  store.getState().attachLive()

  const tid = 'a'.repeat(32)
  liveCallback!(span(tid, 's2', 'second', 2000))
  liveCallback!(span(tid, 's1', 'first', 1000))
  // Duplicate spanId with updated end-time (e.g., span re-emitted)
  liveCallback!(span(tid, 's2', 'second-updated', 2000, 50))

  const trace = store.getState().getTrace(tid)
  assert.ok(trace)
  assert.equal(trace.spans.length, 2, 'dedup by spanId')
  assert.equal(trace.spans[0].name, 'first', 'sorted by startTime asc')
  assert.equal(trace.spans[1].name, 'second-updated', 'duplicate replaced')

  store.getState().detachLive()
})

test('detachLive stops further accumulation', async () => {
  store.getState().attachLive()
  store.getState().detachLive()
  // After detach, callback is null — invoking it would NPE; we just assert
  // no entries land via further attempts on the store.
  const tid = 'b'.repeat(32)
  // Simulate a stray event before detach took effect: should be safe no-op
  // because liveCallback was nulled in the unsubscribe.
  assert.equal(liveCallback, null)
  assert.equal(store.getState().getTrace(tid), undefined)
})

test('hydrate merges snapshot spans without losing live deltas', async () => {
  store.getState().attachLive()

  const tid = 'c'.repeat(32)
  // Live event arrives first (mid-trace mount scenario)
  liveCallback!(span(tid, 'live-1', 'live-only', 5000))

  // Snapshot returns earlier spans the live channel missed
  snapshotResponses.set(tid, {
    traceId: tid,
    spans: [span(tid, 'snap-1', 'snap-old', 1000), span(tid, 'snap-2', 'snap-mid', 3000)]
  })
  await store.getState().hydrate(tid)

  const trace = store.getState().getTrace(tid)!
  assert.equal(trace.hydrated, true)
  assert.equal(trace.spans.length, 3)
  assert.equal(trace.spans.map((s: any) => s.spanId).join(','), 'snap-1,snap-2,live-1')
})

test('hydrate marks trace dropped when tombstoned', async () => {
  const tid = 'd'.repeat(32)
  snapshotResponses.set(tid, { traceId: tid, spans: [], dropped: true, dropReason: 'queue_full' })
  await store.getState().hydrate(tid)
  const trace = store.getState().getTrace(tid)!
  assert.equal(trace.dropped, true)
  assert.equal(trace.dropReason, 'queue_full')
  assert.equal(trace.spans.length, 0)
})

test('FIFO eviction caps the in-memory cache', async () => {
  store.getState().attachLive()
  // Push 60 traces; cap is 50.
  for (let i = 0; i < 60; i++) {
    const tid = i.toString(16).padStart(32, '0')
    liveCallback!(span(tid, 'root', 'r', 1000 + i))
    // Tiny tick so lastUpdated differs (Date.now() resolution may coalesce).
    await new Promise((r) => setImmediate(r))
  }
  const ids = store.getState().listTraceIds()
  assert.equal(ids.length, 50)
  // Newest-first ordering
  assert.equal(ids[0], (59).toString(16).padStart(32, '0'))
})

test('clear() drops all in-memory state', async () => {
  store.getState().attachLive()
  liveCallback!(span('e'.repeat(32), 's1', 'n', 1))
  assert.equal(store.getState().listTraceIds().length, 1)
  store.getState().clear()
  assert.equal(store.getState().listTraceIds().length, 0)
})

test('listTraceIds returns newest-first by lastUpdated', async () => {
  store.getState().attachLive()
  const ta = 'a'.repeat(32)
  const tb = 'b'.repeat(32)
  liveCallback!(span(ta, 's1', 'a', 1))
  await new Promise((r) => setImmediate(r))
  liveCallback!(span(tb, 's1', 'b', 2))
  await new Promise((r) => setImmediate(r))
  liveCallback!(span(ta, 's2', 'a2', 3))
  // Most recent update was on ta → first in the list
  assert.deepEqual(store.getState().listTraceIds(), [ta, tb])
})
