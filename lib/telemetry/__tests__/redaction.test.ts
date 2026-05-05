import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, scrubString, SCRUBBER_VERSION, DEFAULT_SIZE_CAP_BYTES } from '../redaction.js'

test('Stage 1: field-level deny list redacts apiKey/password/token regardless of value', () => {
  const r = redact({ apiKey: 'sk-not-a-real-key', password: 'hunter2', regular: 'fine' })
  const v = r.value as Record<string, unknown>
  assert.equal(v.apiKey, '<redacted:field>')
  assert.equal(v.password, '<redacted:field>')
  assert.equal(v.regular, 'fine')
  assert.equal(r.stats.fieldsRedactedCount, 2)
})

test('Stage 1: deny list is case-insensitive and substring-matched', () => {
  const r = redact({ APIKey: 'x', userToken: 'y', myAuthorizationHdr: 'z' })
  const v = r.value as Record<string, unknown>
  assert.equal(v.APIKey, '<redacted:field>')
  assert.equal(v.userToken, '<redacted:field>')
  assert.equal(v.myAuthorizationHdr, '<redacted:field>')
})

test('Stage 2: scrubs Anthropic key in a free-text string', () => {
  const r = scrubString('Use sk-ant-api03-abcdefghijklmnop1234 in headers')
  assert.match(r.scrubbed, /<redacted:anthropic-key>/)
  assert.equal(r.hits, 1)
})

test('Stage 2: scrubs OpenAI keys (legacy + project)', () => {
  const r1 = scrubString('OPENAI_API_KEY=sk-1234567890abcdefABCDEF1234567890abcdefABCDEF12')
  assert.match(r1.scrubbed, /<redacted:openai-key>/)
  const r2 = scrubString('use sk-proj-abcdefghijklmnopqrstuv1234567890')
  assert.match(r2.scrubbed, /<redacted:openai-key>/)
})

test('Stage 2: scrubs GitHub tokens', () => {
  const r = scrubString('token=ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCDEF')
  assert.match(r.scrubbed, /<redacted:github-token>/)
})

test('Stage 2: scrubs AWS access keys', () => {
  const r = scrubString('aws_access_key_id = AKIAIOSFODNN7EXAMPLE')
  assert.match(r.scrubbed, /<redacted:aws-access-key>/)
})

test('Stage 2: scrubs Bearer tokens (case-insensitive)', () => {
  const r = scrubString('Authorization: bearer abcdefghijklmnopqrstuv')
  assert.match(r.scrubbed, /<redacted:bearer-token>/)
})

test('Stage 2: scrubs JWTs', () => {
  const r = scrubString('cookie=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
  assert.match(r.scrubbed, /<redacted:jwt>/)
})

test('Stage 2: emails are NOT scrubbed (research utility)', () => {
  const r = scrubString('Contact alice@example.com about the dataset')
  assert.equal(r.scrubbed, 'Contact alice@example.com about the dataset')
  assert.equal(r.hits, 0)
})

test('Stage 3: replaces $HOME / /Users/<name> with ~', () => {
  const r = scrubString('Reading from /Users/alice/Documents/file.txt')
  assert.match(r.scrubbed, /^Reading from ~\/Documents\/file\.txt$/)
})

test('Stage 4: caps oversized string into blob ref', () => {
  const big = 'x'.repeat(DEFAULT_SIZE_CAP_BYTES + 100)
  const r = redact(big)
  const v = r.value as { truncated: true; contentHash: string; size: number; redactionLevel: string }
  assert.equal(v.truncated, true)
  assert.match(v.contentHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(v.size, DEFAULT_SIZE_CAP_BYTES + 100)
  assert.equal(v.redactionLevel, 'size-cap')
})

test('Stage 5: artifact ref shortcut', () => {
  const r = redact(
    {
      attachment: { artifactId: 'art-123', title: 'should be dropped', tags: ['a', 'b'] }
    },
    { isArtifactRef: (v) => typeof v === 'object' && v !== null && 'artifactId' in (v as object) }
  )
  const v = r.value as Record<string, unknown>
  assert.deepEqual(v.attachment, { artifactRef: 'art-123' })
})

test('Stage 6: data: image URLs replaced with content-hash ref', () => {
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(200)
  const r = redact(dataUrl)
  const v = r.value as { contentHash: string; mimeType: string; size: number }
  assert.match(v.contentHash, /^sha256:[0-9a-f]{64}$/)
  assert.match(v.mimeType, /^image\//)
})

test('Stage 6: large SVG replaced with content-hash ref', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">' + 'a'.repeat(2000) + '</svg>'
  const r = redact(svg)
  const v = r.value as { contentHash: string; mimeType: string }
  assert.match(v.contentHash, /^sha256:/)
  assert.equal(v.mimeType, 'image/svg+xml')
})

test('Stage 6: Buffer inputs are not inlined', () => {
  const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  const r = redact({ payload: buf })
  const v = r.value as { payload: { contentHash: string; size: number } }
  assert.match(v.payload.contentHash, /^sha256:/)
  assert.equal(v.payload.size, 4)
})

test('redact preserves null/undefined/numbers/booleans', () => {
  const r = redact({ a: null, b: undefined, n: 42, f: 3.14, t: true, big: 99n })
  const v = r.value as Record<string, unknown>
  assert.equal(v.a, null)
  assert.equal(v.b, undefined)
  assert.equal(v.n, 42)
  assert.equal(v.f, 3.14)
  assert.equal(v.t, true)
  assert.equal(v.big, 99n)
})

test('redact recurses into arrays and nested objects', () => {
  const r = redact({
    arr: [
      { apiKey: 'x', val: 1 },
      'use sk-ant-api03-abcdefghijklmnop1234',
      [{ token: 'y' }]
    ]
  })
  const v = r.value as { arr: Array<unknown> }
  const a0 = v.arr[0] as Record<string, unknown>
  assert.equal(a0.apiKey, '<redacted:field>')
  assert.equal(a0.val, 1)
  assert.match(v.arr[1] as string, /<redacted:anthropic-key>/)
  const inner = (v.arr[2] as Array<Record<string, unknown>>)[0]!
  assert.equal(inner.token, '<redacted:field>')
})

test('does not mutate input object', () => {
  const input = { apiKey: 'sk-secret', regular: 'ok' }
  redact(input)
  assert.equal(input.apiKey, 'sk-secret')
})

test('stats.scrubberVersion is the pinned constant', () => {
  const r = redact({ apiKey: 'x' })
  assert.equal(r.stats.scrubberVersion, SCRUBBER_VERSION)
})
