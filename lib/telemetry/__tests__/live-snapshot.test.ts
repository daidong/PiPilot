/**
 * Tests for LiveSpanProcessor (P2.1) + loadTraceSnapshot (P2.2).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context, trace, SpanKind } from '@opentelemetry/api'
import { PipilotTracer } from '../tracer.js'
import { loadTraceSnapshot } from '../snapshot.js'
import type { LiveSpanSummary } from '../live-processor.js'
import { PATHS } from '../../types.js'

function mkTracer() {
  const dir = mkdtempSync(join(tmpdir(), 'rp-live-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  return { dir, t }
}

test('LiveSpanProcessor fans out summary on every onEnd', async () => {
  const { dir, t } = mkTracer()
  try {
    const received: LiveSpanSummary[] = []
    const unsub = t.live.subscribe((s) => received.push(s))

    const root = t.startSpan('invoke_agent test', SpanKind.INTERNAL)
    root.setAttribute('gen_ai.operation.name', 'invoke_agent')
    const ctx = trace.setSpan(context.active(), root)
    await context.with(ctx, async () => {
      const child = t.rawTracer().startSpan('chat m', { kind: SpanKind.CLIENT })
      child.setAttribute('gen_ai.operation.name', 'chat')
      child.setAttribute('gen_ai.usage.input_tokens', 100)
      child.setAttribute('gen_ai.usage.output_tokens', 50)
      child.end()
    })
    root.end()

    assert.equal(received.length, 2, 'two spans fanned out')
    const chat = received.find((s) => s.name === 'chat m')!
    assert.equal(chat.attributes['gen_ai.usage.input_tokens'], 100)
    assert.equal(chat.attributes['gen_ai.usage.output_tokens'], 50)
    assert.match(chat.startTime, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(chat.endTime, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(chat.durationMs >= 0)
    assert.equal(chat.statusCode, 0)
    assert.equal(chat.kind, SpanKind.CLIENT)

    unsub()
    const dummy = t.startSpan('post-unsub')
    dummy.end()
    assert.equal(received.length, 2, 'no more events after unsub')

    await t.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LiveSpanProcessor swallows subscriber exceptions', async () => {
  const { dir, t } = mkTracer()
  try {
    let goodCalls = 0
    t.live.subscribe(() => {
      throw new Error('boom')
    })
    t.live.subscribe(() => {
      goodCalls++
    })
    const span = t.startSpan('foo')
    span.end()
    assert.equal(goodCalls, 1, 'good subscriber still called after bad one threw')
    await t.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LiveSpanProcessor.clear() drops all subscribers', async () => {
  const { dir, t } = mkTracer()
  try {
    let calls = 0
    t.live.subscribe(() => { calls++ })
    t.live.clear()
    const span = t.startSpan('foo')
    span.end()
    assert.equal(calls, 0)
    await t.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadTraceSnapshot reads spans for a traceId from disk', async () => {
  const { dir, t } = mkTracer()
  try {
    const root = t.startSpan('invoke_agent m', SpanKind.INTERNAL)
    root.setAttribute('gen_ai.operation.name', 'invoke_agent')
    const traceId = root.spanContext().traceId
    const ctx = trace.setSpan(context.active(), root)
    await context.with(ctx, async () => {
      const child = t.rawTracer().startSpan('chat m', { kind: SpanKind.CLIENT })
      child.setAttribute('gen_ai.usage.input_tokens', 42)
      child.end()
    })
    root.end()
    await t.shutdown()

    const snapshot = loadTraceSnapshot(dir, traceId)
    assert.equal(snapshot.traceId, traceId)
    assert.equal(snapshot.dropped, undefined)
    assert.equal(snapshot.spans.length, 2)
    const names = snapshot.spans.map((s) => s.name).sort()
    assert.deepEqual(names, ['chat m', 'invoke_agent m'])
    const chat = snapshot.spans.find((s) => s.name === 'chat m')!
    assert.equal(chat.attributes['gen_ai.usage.input_tokens'], 42)
    // Spans sorted by startTime
    const startTimes = snapshot.spans.map((s) => s.startTime)
    assert.deepEqual([...startTimes].sort(), startTimes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadTraceSnapshot returns dropped=true when traceId is tombstoned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-snap-tomb-'))
  try {
    mkdirSync(join(dir, PATHS.traces), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const fakeTraceId = '0123456789abcdef0123456789abcdef'
    writeFileSync(
      join(dir, PATHS.traces, `tombstones.${stamp}.jsonl`),
      JSON.stringify({ traceId: fakeTraceId, kind: 'trace_dropped', reason: 'queue_full', timestamp: new Date().toISOString() }) + '\n'
    )
    const snap = loadTraceSnapshot(dir, fakeTraceId)
    assert.equal(snap.dropped, true)
    assert.equal(snap.dropReason, 'queue_full')
    assert.equal(snap.spans.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadTraceSnapshot returns empty when traceId not found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-snap-miss-'))
  try {
    const snap = loadTraceSnapshot(dir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(snap.spans.length, 0)
    assert.equal(snap.dropped, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
