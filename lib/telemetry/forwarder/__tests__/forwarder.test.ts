/**
 * Tests for the OTLP forwarder.
 *
 * Uses a fake fetch to avoid network dependency. Each test creates a temp
 * project with synthetic spans.{date}.jsonl files and asserts:
 *   - replayAll posts every envelope, persists cursor, idempotent on re-run
 *   - cursor resumes from where it left off
 *   - HTTP errors are surfaced and don't advance cursor
 *   - tombstone-tolerant: malformed JSONL lines are skipped, not fatal
 *   - --no-cursor disables persistence
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayAll, follow } from '../forwarder.js'

function todayUtc(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function fakeEnvelope(spanName: string, traceId = 'a'.repeat(32)): string {
  return JSON.stringify({
    schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'research-copilot' } }] },
    scopeSpans: [
      {
        scope: { name: 'pipilot' },
        schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
        spans: [
          {
            traceId,
            spanId: 'b'.repeat(16),
            name: spanName,
            kind: 1,
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '2000000000',
            attributes: [],
            events: [],
            status: { code: 0 }
          }
        ]
      }
    ]
  })
}

function makeProject(spans: Record<string, string[]>): string {
  // spans: { 'YYYY-MM-DD': [envelope, envelope, ...] }
  const dir = mkdtempSync(join(tmpdir(), 'rp-fwd-'))
  mkdirSync(join(dir, '.research-pilot/traces'), { recursive: true })
  for (const [date, envelopes] of Object.entries(spans)) {
    const file = join(dir, '.research-pilot/traces', `spans.${date}.jsonl`)
    writeFileSync(file, envelopes.map((e) => e + '\n').join(''))
  }
  return dir
}

interface FakeReq {
  url: string
  body: string
  headers: Record<string, string>
}

function makeFakeFetch(behavior: { status?: number; throwError?: string } = {}) {
  const requests: FakeReq[] = []
  const status = behavior.status ?? 200
  const fakeFetch: typeof fetch = async (input, init) => {
    if (behavior.throwError) throw new Error(behavior.throwError)
    let body = ''
    if (typeof init?.body === 'string') body = init.body
    else if (init?.body instanceof Uint8Array) body = `<binary ${(init.body as Uint8Array).length} bytes>`
    requests.push({
      url: typeof input === 'string' ? input : input.toString(),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>
    })
    return new Response(status === 200 ? '{}' : 'error', {
      status,
      headers: { 'content-type': 'application/json' }
    }) as Response
  }
  return { fakeFetch, requests }
}

// ─── replayAll ────────────────────────────────────────────────────────

test('replayAll posts every envelope across multiple days (json mode)', async () => {
  const dir = makeProject({
    '2026-05-04': [fakeEnvelope('a'), fakeEnvelope('b')],
    '2026-05-05': [fakeEnvelope('c'), fakeEnvelope('d'), fakeEnvelope('e')]
  })
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    const r = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      encoding: 'json',
      fetchImpl: fakeFetch,
      verbosity: 'quiet'
    })
    assert.equal(r.envelopesPosted, 5)
    assert.equal(r.filesProcessed, 2)
    assert.equal(r.errors, 0)
    // Each batch is one POST since all 5 fit in default batch=100.
    assert.equal(requests.length, 2)
    // Body shape: { resourceSpans: [...] }
    const first = JSON.parse(requests[0]!.body)
    assert.ok(Array.isArray(first.resourceSpans))
    assert.equal(first.resourceSpans.length, 2)
    assert.equal(requests[0]!.headers['Content-Type'], 'application/json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll: default encoding is proto (Content-Type application/x-protobuf)', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a'), fakeEnvelope('b')] })
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fakeFetch,
      verbosity: 'quiet'
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.headers['Content-Type'], 'application/x-protobuf')
    // Body is binary — JSON.parse should fail.
    assert.throws(() => JSON.parse(requests[0]!.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll is idempotent: second run posts nothing when nothing new', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a'), fakeEnvelope('b')] })
  const { fakeFetch: fetch1, requests: req1 } = makeFakeFetch()
  const { fakeFetch: fetch2, requests: req2 } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fetch1,
      verbosity: 'quiet'
    })
    assert.equal(req1.length, 1)
    // Second run.
    const r2 = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fetch2,
      verbosity: 'quiet'
    })
    assert.equal(r2.envelopesPosted, 0)
    assert.equal(req2.length, 0, 'no new POSTs when cursor is current')
    // Cursor file present.
    assert.ok(existsSync(join(dir, '.research-pilot/traces/.forward-cursor.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll resumes from cursor after appending new envelopes', async () => {
  const date = todayUtc()
  const dir = makeProject({ [date]: [fakeEnvelope('a')] })
  const { fakeFetch: f1, requests: r1 } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      encoding: 'json',
      fetchImpl: f1,
      verbosity: 'quiet'
    })
    assert.equal(r1.length, 1)
    // Append two more envelopes.
    const file = join(dir, '.research-pilot/traces', `spans.${date}.jsonl`)
    appendFileSync(file, fakeEnvelope('b') + '\n' + fakeEnvelope('c') + '\n')
    const { fakeFetch: f2, requests: r2 } = makeFakeFetch()
    const out = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      encoding: 'json',
      fetchImpl: f2,
      verbosity: 'quiet'
    })
    assert.equal(out.envelopesPosted, 2, 'only the two new envelopes are posted')
    assert.equal(r2.length, 1)
    const body = JSON.parse(r2[0]!.body)
    assert.equal(body.resourceSpans.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll: HTTP error counts as errors and does NOT advance cursor', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a'), fakeEnvelope('b')] })
  const { fakeFetch: failing, requests: failed } = makeFakeFetch({ status: 500 })
  try {
    const r = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: failing,
      verbosity: 'quiet'
    })
    assert.equal(r.envelopesPosted, 0)
    assert.equal(r.errors, 2)
    assert.equal(failed.length, 1)
    // Cursor must NOT have been advanced for this date (file may or may not
    // exist — either is fine; what matters is that the date entry isn't set).
    const cursorFile = join(dir, '.research-pilot/traces/.forward-cursor.json')
    if (existsSync(cursorFile)) {
      const cursor = JSON.parse(readFileSync(cursorFile, 'utf8').toString())
      const hashed = Object.keys(cursor)[0]
      if (hashed) {
        assert.equal(cursor[hashed]['2026-05-05'], undefined, 'cursor not advanced on error')
      }
    }
    // Re-run with success: re-POSTs everything.
    const { fakeFetch: ok, requests: okReq } = makeFakeFetch()
    const r2 = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: ok,
      verbosity: 'quiet'
    })
    assert.equal(r2.envelopesPosted, 2)
    assert.equal(okReq.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll skips malformed JSONL lines without aborting', async () => {
  const dir = makeProject({})
  const file = join(dir, '.research-pilot/traces', `spans.2026-05-05.jsonl`)
  writeFileSync(file, fakeEnvelope('a') + '\n' + 'not json {{{\n' + fakeEnvelope('b') + '\n')
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    const r = await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      encoding: 'json',
      fetchImpl: fakeFetch,
      verbosity: 'quiet'
    })
    // Two envelopes successfully parsed; malformed line dropped.
    const body = JSON.parse(requests[0]!.body)
    assert.equal(body.resourceSpans.length, 2)
    assert.equal(r.errors, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll: --no-cursor mode does not persist cursor', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a')] })
  const { fakeFetch } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fakeFetch,
      persistCursor: false,
      verbosity: 'quiet'
    })
    assert.equal(existsSync(join(dir, '.research-pilot/traces/.forward-cursor.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replayAll forwards custom headers', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a')] })
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fakeFetch,
      headers: { Authorization: 'Bearer xyz', 'X-Project': 'test' },
      verbosity: 'quiet'
    })
    assert.equal(requests[0]!.headers.Authorization, 'Bearer xyz')
    assert.equal(requests[0]!.headers['X-Project'], 'test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('per-endpoint cursor: same project, two endpoints, each tracks independently', async () => {
  const dir = makeProject({ '2026-05-05': [fakeEnvelope('a'), fakeEnvelope('b')] })
  const { fakeFetch: f1, requests: r1 } = makeFakeFetch()
  const { fakeFetch: f2, requests: r2 } = makeFakeFetch()
  try {
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      encoding: 'json',
      fetchImpl: f1,
      verbosity: 'quiet'
    })
    await replayAll({
      projectPath: dir,
      endpoint: 'http://localhost:4318/v1/traces', // different endpoint
      encoding: 'json',
      fetchImpl: f2,
      verbosity: 'quiet'
    })
    assert.equal(r1.length, 1, 'first endpoint posted once')
    assert.equal(r2.length, 1, 'second endpoint posted once (independent cursor)')
    const body = JSON.parse(r2[0]!.body)
    assert.equal(body.resourceSpans.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── follow ────────────────────────────────────────────────────────────

test('follow: starts up, processes existing rows, then stops cleanly', async () => {
  const date = todayUtc()
  const dir = makeProject({ [date]: [fakeEnvelope('initial')] })
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    const handle = await follow({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fakeFetch,
      verbosity: 'quiet',
      keepAlive: false
    })
    // Initial replayAll inside follow() should have posted the existing row.
    assert.ok(handle.result.envelopesPosted >= 1)
    await handle.stop()
    // Calling stop a second time is a no-op.
    await handle.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('follow: detects a new line appended to today\'s file', async () => {
  const date = todayUtc()
  const dir = makeProject({ [date]: [fakeEnvelope('initial')] })
  const { fakeFetch, requests } = makeFakeFetch()
  try {
    const handle = await follow({
      projectPath: dir,
      endpoint: 'http://localhost:6006/v1/traces',
      fetchImpl: fakeFetch,
      verbosity: 'quiet',
      keepAlive: false
    })
    const baselineRequests = requests.length
    // Append a new envelope.
    const file = join(dir, '.research-pilot/traces', `spans.${date}.jsonl`)
    appendFileSync(file, fakeEnvelope('new') + '\n')
    // Wait for poll tick (1s) plus a margin.
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(requests.length > baselineRequests, 'new POST observed after append')
    await handle.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
