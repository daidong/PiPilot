/**
 * Tests for tracedFetch + recordReviewCompletion (P1.3b — diagram backends).
 *
 * Validates:
 *   - tracedFetch falls through to plain fetch when no tracer is bootstrapped
 *   - tracedFetch emits a chat span with GenAI semconv attrs when tracer exists
 *   - HTTP error status produces ERROR span status + error.type attribute
 *   - thrown fetch errors record the exception and rethrow
 *   - recordReviewCompletion is a no-op outside an active span
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context, trace, SpanKind } from '@opentelemetry/api'
import { tracedFetch, recordReviewCompletion } from '../http-trace.js'
import { PipilotTracer } from '../tracer.js'
import { PATHS } from '../../types.js'

// Mock fetch by stashing a function on globalThis. Restored after each test.
function withMockFetch<T>(impl: typeof fetch, fn: () => T): T {
  const orig = globalThis.fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = impl
  try {
    return fn()
  } finally {
    ;(globalThis as { fetch: typeof fetch }).fetch = orig
  }
}

function mkResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

test('tracedFetch falls through to plain fetch when no tracer is active', async () => {
  // No PipilotTracer constructed in this test → getActiveTracer() returns null.
  let called = 0
  const fakeFetch: typeof fetch = async () => {
    called++
    return mkResponse(200, '{}')
  }
  await withMockFetch(fakeFetch, async () => {
    const res = await tracedFetch('https://example.com', { method: 'POST' }, {
      spanName: 'chat test (diagram-review)'
    })
    assert.equal(res.status, 200)
  })
  assert.equal(called, 1)
})

test('tracedFetch emits a chat span with GenAI attrs when tracer is active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tracedfetch-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  try {
    const fakeFetch: typeof fetch = async () => mkResponse(200, '{"ok":true}')
    await withMockFetch(fakeFetch, async () => {
      // Wrap in a parent execute_tool span to mirror the diagram tool's
      // call chain — the tracedFetch span should attach as its child.
      const parent = t.startSpan('execute_tool generate_diagram', SpanKind.INTERNAL)
      const ctx = trace.setSpan(context.active(), parent)
      await context.with(ctx, async () => {
        await tracedFetch('https://api.test/v1/messages', { method: 'POST' }, {
          spanName: 'chat claude-opus-4-7 (diagram-review)',
          genAi: { operation: 'chat', provider: 'anthropic', requestModel: 'claude-opus-4-7' },
          authMode: 'anthropic-subscription',
          purpose: 'diagram-review'
        })
      })
      parent.end()
    })
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const spans = env.scopeSpans[0].spans as Array<{ name: string; parentSpanId?: string; spanId: string; attributes: Array<{ key: string; value: any }>; status: { code: number }; kind: number }>
    const chat = spans.find((s) => s.name.startsWith('chat claude-opus-4-7'))!
    const parent = spans.find((s) => s.name.startsWith('execute_tool'))!
    assert.ok(chat, 'chat span emitted')
    assert.equal(chat.parentSpanId, parent.spanId, 'chat is child of execute_tool')
    assert.equal(chat.kind, SpanKind.CLIENT)
    const findAttr = (k: string) => chat.attributes.find((a) => a.key === k)?.value
    assert.equal(findAttr('gen_ai.operation.name').stringValue, 'chat')
    assert.equal(findAttr('gen_ai.provider.name').stringValue, 'anthropic')
    assert.equal(findAttr('gen_ai.request.model').stringValue, 'claude-opus-4-7')
    assert.equal(findAttr('pipilot.auth.mode').stringValue, 'anthropic-subscription')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tracedFetch records HTTP error status onto the span', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tracedfetch-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  try {
    const fakeFetch: typeof fetch = async () => mkResponse(500, '{"error":"server"}')
    await withMockFetch(fakeFetch, async () => {
      await tracedFetch('https://api.test/v1/messages', { method: 'POST' }, {
        spanName: 'chat m (diagram-review)',
        genAi: { provider: 'anthropic', requestModel: 'm' }
      })
    })
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const span = env.scopeSpans[0].spans[0]
    // Span status: ERROR = 2 in OTel.
    assert.equal(span.status.code, 2)
    const errAttr = span.attributes.find((a: any) => a.key === 'error.type')?.value.stringValue
    assert.equal(errAttr, 'http_500')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tracedFetch records thrown fetch error and rethrows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tracedfetch-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  try {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNRESET')
    }
    await withMockFetch(fakeFetch, async () => {
      await assert.rejects(
        tracedFetch('https://api.test/v1/messages', { method: 'POST' }, {
          spanName: 'chat m'
        }),
        /ECONNRESET/
      )
    })
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const span = env.scopeSpans[0].spans[0]
    assert.equal(span.status.code, 2)
    assert.match(span.status.message ?? '', /ECONNRESET/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordReviewCompletion is a no-op outside an active span', () => {
  // Should not throw. There's no span on the active context, so nothing happens.
  recordReviewCompletion({ inputTokens: 100, outputTokens: 50, finishReason: 'stop' })
})

test('recordReviewCompletion stamps attrs on the active span', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tracedfetch-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  try {
    const span = t.startSpan('execute_tool foo')
    const ctx = trace.setSpan(context.active(), span)
    await context.with(ctx, async () => {
      recordReviewCompletion({
        inputTokens: 100,
        outputTokens: 50,
        responseModel: 'claude-opus-4-7',
        finishReason: 'end_turn'
      })
    })
    span.end()
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const file = join(dir, PATHS.traces, `spans.${stamp}.jsonl`)
    const env = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)
    const wrote = env.scopeSpans[0].spans[0]
    const findAttr = (k: string) => wrote.attributes.find((a: any) => a.key === k)?.value
    assert.equal(findAttr('gen_ai.usage.input_tokens').intValue, '100')
    assert.equal(findAttr('gen_ai.usage.output_tokens').intValue, '50')
    assert.equal(findAttr('gen_ai.response.model').stringValue, 'claude-opus-4-7')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
