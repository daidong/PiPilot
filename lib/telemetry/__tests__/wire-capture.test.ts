/**
 * Tests for the wire-level capture path: tracedCompleteSimple's onPayload +
 * onResponse hooks (forwarded into pi-ai via SimpleStreamOptions).
 *
 * Real pi-ai providers (Anthropic, OpenAI, Google, etc.) all invoke
 * `options.onPayload(payload, model)` right before sending the HTTP request
 * and `options.onResponse(resp, model)` right after the headers come back.
 * The bundled `registerFauxProvider` only fires onResponse, so we register
 * our own minimal provider that mimics the production hook order.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerApiProvider,
  unregisterApiProviders,
  createAssistantMessageEventStream
} from '@mariozechner/pi-ai'
import type {
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
  AssistantMessageEventStream
} from '@mariozechner/pi-ai'
import { PipilotTracer } from '../tracer.js'
import { tracedCompleteSimple } from '../llm-trace.js'
import { PATHS } from '../../types.js'

// ─── Spy provider ─────────────────────────────────────────────────────────

interface SpyOptions {
  payload: unknown
  responseStatus?: number
  responseHeaders?: Record<string, string>
  assistantText?: string
  inputTokens?: number
  outputTokens?: number
}

const SOURCE_ID = 'pipilot-wire-test'

function installSpyProvider(api: string, spy: SpyOptions): { model: Model<string>; reset: () => void } {
  const stream = (model: Model<any>, _ctx: Context, options?: StreamOptions): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream()
    void (async () => {
      try {
        // Mimic real provider order: onPayload (right before HTTP) then onResponse.
        if (options?.onPayload) {
          const replaced = await options.onPayload(spy.payload, model)
          if (replaced !== undefined) {
            // Real providers honor replacement; we don't care here.
          }
        }
        if (options?.onResponse) {
          await options.onResponse(
            { status: spy.responseStatus ?? 200, headers: spy.responseHeaders ?? {} },
            model
          )
        }
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: spy.assistantText ?? 'ok' }],
          api: api as any,
          provider: 'spy-provider' as any,
          model: model.id,
          usage: {
            input: spy.inputTokens ?? 1,
            output: spy.outputTokens ?? 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: (spy.inputTokens ?? 1) + (spy.outputTokens ?? 1),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: Date.now()
        }
        out.push({ type: 'start', partial: message })
        out.push({ type: 'done', reason: 'stop', message })
        out.end(message)
      } catch (err) {
        out.end({
          ...({} as AssistantMessage),
          role: 'assistant',
          content: [],
          api: api as any,
          provider: 'spy' as any,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: (err as Error).message,
          timestamp: Date.now()
        })
      }
    })()
    return out
  }
  registerApiProvider(
    {
      api: api as any,
      stream: stream as any,
      streamSimple: stream as any
    },
    SOURCE_ID
  )
  const model: Model<string> = {
    id: `${api}-model`,
    name: 'Spy Model',
    api: api as any,
    provider: 'spy-provider' as any,
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096
  } as Model<string>
  return { model, reset: () => unregisterApiProviders(SOURCE_ID) }
}

function tempTracer() {
  const dir = mkdtempSync(join(tmpdir(), 'rp-wire-'))
  const t = new PipilotTracer({
    projectPath: dir,
    serviceVersion: '0.0.0-test',
    appBuildCommit: 'c1',
    projectId: 'P',
    sessionId: 'S'
  })
  return { dir, t }
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('onPayload captures wire payload as pipilot.chat.request_payload event', async () => {
  const { dir, t } = tempTracer()
  // Distinct API string per test so registry doesn't collide across runs.
  const { model, reset } = installSpyProvider('pipilot-test-wire-1', {
    payload: {
      model: 'whatever',
      messages: [{ role: 'user', content: 'hi' }],
      cache_control: { type: 'ephemeral' }
    }
  })
  try {
    await tracedCompleteSimple(
      model,
      { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
      undefined,
      { tracer: t, authMode: 'api-key', purpose: 'unit-test' }
    )
    await t.shutdown()

    const stamp = new Date().toISOString().slice(0, 10)
    const env = JSON.parse(
      readFileSync(join(dir, PATHS.traces, `spans.${stamp}.jsonl`), 'utf8').trim().split('\n')[0]!
    )
    const span = env.scopeSpans[0].spans[0]
    const wireEvent = (span.events as any[]).find((e) => e.name === 'pipilot.chat.request_payload')
    assert.ok(wireEvent, `expected pipilot.chat.request_payload, saw: ${(span.events as any[]).map((e) => e.name).join(',')}`)
    const body = JSON.parse(wireEvent.attributes.find((a: any) => a.key === 'body').value.stringValue)
    assert.deepEqual(body.cache_control, { type: 'ephemeral' })
  } finally {
    reset()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onResponse stamps http.response.* attributes including known rate-limit headers', async () => {
  const { dir, t } = tempTracer()
  const { model, reset } = installSpyProvider('pipilot-test-wire-2', {
    payload: { foo: 'bar' },
    responseStatus: 200,
    responseHeaders: {
      'request-id': 'req_abc123',
      'anthropic-ratelimit-input-tokens-remaining': '49000',
      'content-type': 'application/json'
    }
  })
  try {
    await tracedCompleteSimple(
      model,
      { systemPrompt: 's', messages: [{ role: 'user', content: 'q', timestamp: Date.now() }] },
      undefined,
      { tracer: t }
    )
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const env = JSON.parse(
      readFileSync(join(dir, PATHS.traces, `spans.${stamp}.jsonl`), 'utf8').trim().split('\n')[0]!
    )
    const span = env.scopeSpans[0].spans[0]
    const findAttr = (k: string) => span.attributes.find((a: any) => a.key === k)?.value
    assert.equal(findAttr('http.response.status_code')?.intValue, '200')
    assert.equal(findAttr('http.response.header.request-id')?.stringValue, 'req_abc123')
    assert.equal(
      findAttr('http.response.header.anthropic-ratelimit-input-tokens-remaining')?.stringValue,
      '49000'
    )
    // Filtering: content-type isn't in the wanted list, should NOT be on span.
    assert.equal(findAttr('http.response.header.content-type'), undefined)
  } finally {
    reset()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('caller-supplied onPayload still fires (chained, not overwritten)', async () => {
  const { dir, t } = tempTracer()
  const { model, reset } = installSpyProvider('pipilot-test-wire-3', {
    payload: { hello: 'world' }
  })
  try {
    let userHookFired = false
    let userPayloadSeen: unknown = null
    await tracedCompleteSimple(
      model,
      { systemPrompt: 's', messages: [{ role: 'user', content: 'q', timestamp: Date.now() }] },
      {
        onPayload: (p) => {
          userHookFired = true
          userPayloadSeen = p
          return undefined
        }
      },
      { tracer: t }
    )
    assert.equal(userHookFired, true, 'caller onPayload still invoked')
    assert.deepEqual(userPayloadSeen, { hello: 'world' })
    await t.shutdown()
  } finally {
    reset()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('large wire payload (>4KB) writes to BlobStore and references via contentHash', async () => {
  const { dir, t } = tempTracer()
  const big = 'x'.repeat(6000)
  const { model, reset } = installSpyProvider('pipilot-test-wire-4', {
    payload: { system: big, messages: [{ role: 'user', content: 'q' }] }
  })
  try {
    await tracedCompleteSimple(
      model,
      { systemPrompt: 's', messages: [{ role: 'user', content: 'q', timestamp: Date.now() }] },
      undefined,
      { tracer: t }
    )
    await t.shutdown()
    const stamp = new Date().toISOString().slice(0, 10)
    const env = JSON.parse(
      readFileSync(join(dir, PATHS.traces, `spans.${stamp}.jsonl`), 'utf8').trim().split('\n')[0]!
    )
    const span = env.scopeSpans[0].spans[0]
    const wireEvent = (span.events as any[]).find((e) => e.name === 'pipilot.chat.request_payload')!
    const body = JSON.parse(wireEvent.attributes.find((a: any) => a.key === 'body').value.stringValue)
    // Either top-level over-cap (whole payload in blob) or nested string in
    // `system` field. Either way the body now carries a sha256 ref.
    const ser = JSON.stringify(body)
    const m = ser.match(/sha256:([0-9a-f]{64})/)
    assert.ok(m, `expected blob ref in body: ${ser.slice(0, 200)}`)
    const blobPath = t.blobs.pathFor(m[1]!)
    const blobContent = readFileSync(blobPath, 'utf8')
    // Whatever was over-cap got blob'd — `big` should appear inside.
    assert.ok(blobContent.includes(big.slice(0, 100)), 'blob recoverable from disk')
  } finally {
    reset()
    rmSync(dir, { recursive: true, force: true })
  }
})
