import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { trace, context as otelContext, SpanKind } from '@opentelemetry/api'
import { TraceStore } from '../trace-store.js'
import { PATHS } from '../../types.js'

function makeStore(projectPath: string, opts: Partial<Parameters<typeof TraceStore.prototype.constructor>[0]> = {}) {
  const store = new TraceStore({
    projectPath,
    bufferCapacity: 4,
    batchSize: 100,
    idleFlushMs: 60_000,
    disableTimer: true,
    ...opts
  })
  const provider = new NodeTracerProvider({
    resource: new Resource({ 'service.name': 'research-copilot' }),
    spanProcessors: [store as any]
  })
  // Use provider.getTracer() directly — registering globally fails on the second
  // invocation in the same process (trace.setGlobalTracerProvider is once-only),
  // which silently routes spans to the previously-registered provider's store.
  const tracer = provider.getTracer('test')
  return { provider, store, tracer }
}

test('flushes queued spans to dated spans file via exporter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-store-'))
  const { provider, store, tracer } = makeStore(dir)
  try {
    // tracer captured from makeStore
    const span = tracer.startSpan('chat foo', { kind: SpanKind.CLIENT })
    span.end()
    await store.flushNow()
    await provider.forceFlush()
    const today = new Date()
    const stamp = today.toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    assert.ok(existsSync(file), `spans file at ${file}`)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const env = JSON.parse(lines[0]!)
    assert.equal(env.scopeSpans[0].spans[0].name, 'chat foo')
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('drops newest in-flight trace when queue overflows + writes tombstone sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-store-'))
  const { provider, store, tracer } = makeStore(dir,{ bufferCapacity: 4, batchSize: 999, disableTimer: true })
  try {
    // tracer captured from makeStore

    // Trace A: 2 spans
    const a1 = tracer.startSpan('a1')
    const a1Ctx = trace.setSpan(otelContext.active(), a1)
    const a2 = tracer.startSpan('a2', undefined, a1Ctx)
    a2.end()
    a1.end()

    // Trace B: 2 spans (this trace is "newest in-flight" once it starts)
    const b1 = tracer.startSpan('b1')
    const b1Ctx = trace.setSpan(otelContext.active(), b1)
    const b2 = tracer.startSpan('b2', undefined, b1Ctx)
    b2.end()
    b1.end()

    // Now queue holds 4 spans (A:2, B:2). Add a 5th that belongs to a NEW trace (C).
    // That triggers the trace-level drop. The newest in-flight trace is now C
    // (just arrived), so C's single span should be dropped and tombstoned.
    const c1 = tracer.startSpan('c1')
    c1.end()

    // After drop, queue should hold 4 spans (A + B), and tombstone for C should exist.
    assert.equal(store.queueSize, 4, 'A+B preserved, C dropped')
    assert.ok(store.tombstoneCount >= 1, 'at least one trace tombstoned')
    assert.ok(store.droppedCount >= 1)

    await store.flushNow()
    await provider.forceFlush()
    // Tombstone write is fire-and-forget; allow one tick for the async append.
    await new Promise((r) => setTimeout(r, 100))

    const stamp = new Date().toISOString().slice(0, 10)
    const tombFile = join(dir, PATHS.traces, `tombstones.${stamp}.jsonl`)
    assert.ok(existsSync(tombFile), 'tombstone sidecar exists')
    const lines = readFileSync(tombFile, 'utf8').trim().split('\n').filter(Boolean)
    assert.ok(lines.length > 0, 'tombstone has at least one row')
    const row = JSON.parse(lines[0]!)
    assert.equal(row.kind, 'trace_dropped')
    assert.equal(row.reason, 'queue_full')
    assert.match(row.traceId, /^[0-9a-f]{32}$/)
    assert.equal(typeof row.droppedAtSpanCount, 'number')

    // Spans file must NOT contain the C trace.
    const spansFile = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const spansContent = readFileSync(spansFile, 'utf8')
    assert.doesNotMatch(spansContent, /"name":"c1"/)
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('once tombstoned, future spans of that traceId are permanently suppressed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-store-'))
  const { provider, store, tracer } = makeStore(dir,{ bufferCapacity: 2, batchSize: 999, disableTimer: true })
  try {
    // tracer captured from makeStore
    // Fill queue with trace A (2 spans).
    const a1 = tracer.startSpan('a1')
    const aCtx = trace.setSpan(otelContext.active(), a1)
    const a2 = tracer.startSpan('a2', undefined, aCtx)
    a2.end()
    a1.end()
    // Add trace B → triggers drop of newest = B.
    const b1 = tracer.startSpan('b1')
    b1.end()
    const droppedTraceId = b1.spanContext().traceId

    // Try adding a child of B (continuation) — must be suppressed.
    const bCtx = trace.setSpan(otelContext.active(), b1)
    const b2 = tracer.startSpan('b2', undefined, bCtx)
    b2.end()
    assert.equal(b2.spanContext().traceId, droppedTraceId)

    await store.flushNow()
    await provider.forceFlush()
    const stamp = new Date().toISOString().slice(0, 10)
    const spansContent = readFileSync(join(dir, PATHS.traces, `spans.${stamp}.jsonl`), 'utf8')
    assert.doesNotMatch(spansContent, /"name":"b1"/)
    assert.doesNotMatch(spansContent, /"name":"b2"/)
    assert.match(spansContent, /"name":"a1"/)
    assert.match(spansContent, /"name":"a2"/)
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disable() drains queue and short-circuits future spans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-store-'))
  const { provider, store, tracer } = makeStore(dir,{ batchSize: 999, disableTimer: true })
  try {
    // tracer captured from makeStore
    const s1 = tracer.startSpan('keep')
    s1.end()
    await store.disable()
    const s2 = tracer.startSpan('drop-me')
    s2.end()
    assert.equal(store.queueSize, 0, 'queue empty after disable')
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8')
      assert.doesNotMatch(content, /"name":"drop-me"/)
    }
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tracingMode change is logged to tracing-state.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-store-'))
  const { provider, store, tracer } = makeStore(dir,{ batchSize: 999, disableTimer: true })
  try {
    await store.disable('test-disable')
    await new Promise((r) => setTimeout(r, 50))
    const log = readFileSync(join(dir, PATHS.tracingState), 'utf8')
    assert.match(log, /"kind":"tracing-mode-change"/)
    assert.match(log, /"toState":"disabled"/)
  } finally {
    await provider.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})
