/**
 * Tests for BlobStore + redaction integration.
 *
 * The store is async-queue since v0.11 — `writeIfMissing` returns sync with
 * the content hash, but the disk write happens on a setImmediate-scheduled
 * drain. Tests that assert on-disk presence MUST `await store.flush()` first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from '../blob-store.js'
import { redact } from '../redaction.js'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rp-blob-'))
  mkdirSync(join(d, '.research-pilot/blobs'), { recursive: true })
  return d
}

test('BlobStore writes content under {prefix}/{full-sha256}', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const r = store.writeIfMissing('hello world')
    assert.equal(r.size, 11)
    assert.equal(r.isNew, true)
    assert.match(r.hash, /^[0-9a-f]{64}$/)
    // Drain the async write before checking disk.
    await store.flush()
    const path = store.pathFor(r.hash)
    assert.ok(existsSync(path), `blob file at ${path}`)
    assert.equal(readFileSync(path, 'utf8'), 'hello world')
    // Path is sharded by 2-char prefix. Normalize separators for Windows
    // where path uses `\` rather than `/`.
    assert.ok(path.replace(/\\/g, '/').includes(`/blobs/${r.hash.slice(0, 2)}/${r.hash}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore is idempotent — same content returns isNew=false', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const a = store.writeIfMissing('content x')
    const b = store.writeIfMissing('content x')
    assert.equal(a.hash, b.hash)
    assert.equal(a.isNew, true)
    // Second call sees the hash in pendingHashes and dedups without
    // re-enqueueing — even though the first write hasn't drained yet.
    assert.equal(b.isNew, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore handles Buffer + Uint8Array', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const a = store.writeIfMissing(Buffer.from([1, 2, 3, 4]))
    const b = store.writeIfMissing(new Uint8Array([1, 2, 3, 4]))
    assert.equal(a.hash, b.hash, 'Buffer + Uint8Array dedup correctly')
    assert.equal(a.size, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore.pathFor accepts both `sha256:...` prefix and bare hex', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const hash = 'a'.repeat(64)
    assert.equal(store.pathFor(hash), store.pathFor('sha256:' + hash))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore: async write failure surfaces via onError after flush', async () => {
  const dir = tempDir()
  try {
    // Make the blobs dir a file so mkdir would fail mid-drain.
    const blobsDir = join(dir, '.research-pilot/blobs')
    rmSync(blobsDir, { recursive: true, force: true })
    writeFileSync(blobsDir, 'i am a file, not a dir')
    const store = new BlobStore(dir)
    const errors: unknown[] = []
    const r = store.writeIfMissing('whatever', (err) => errors.push(err))
    assert.match(r.hash, /^[0-9a-f]{64}$/)
    // isNew=true: we enqueued the write. Failure happens on the drain tick.
    assert.equal(r.isNew, true)
    await store.flush()
    assert.ok(errors.length >= 1, 'async write failure invokes onError after flush')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore: queue saturation drops writes and fires onError synchronously', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    // 64 MB queue cap. Two ~40 MB writes with unique content → second is dropped.
    const a = 'a'.repeat(40 * 1024 * 1024)
    const b = 'b'.repeat(40 * 1024 * 1024)
    const errors: unknown[] = []
    const r1 = store.writeIfMissing(a, (err) => errors.push(err))
    const r2 = store.writeIfMissing(b, (err) => errors.push(err))
    assert.equal(r1.isNew, true, 'first fits in the queue')
    assert.equal(r2.isNew, false, 'second is dropped (saturation)')
    assert.equal(errors.length, 1, 'onError fires synchronously on saturation')
    assert.match(
      String((errors[0] as Error).message),
      /saturated/,
      'error message names the cause'
    )
    assert.equal(store.droppedWriteCount, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore: concurrent same-content calls collapse to one queued write', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const big = 'x'.repeat(5000)
    // 50 spans, same prompt template — should NOT enqueue 50 writes.
    const results = []
    for (let i = 0; i < 50; i++) results.push(store.writeIfMissing(big))
    assert.equal(results[0]!.isNew, true)
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i]!.isNew, false, `call ${i} dedups against pendingHashes`)
    }
    await store.flush()
    // Exactly one file on disk.
    const hash = results[0]!.hash
    const shardDir = join(dir, '.research-pilot/blobs', hash.slice(0, 2))
    assert.equal(readdirSync(shardDir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BlobStore.flush is a no-op when the queue is empty', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    await store.flush()  // empty queue
    store.writeIfMissing('a')
    await store.flush()
    await store.flush()  // already drained
    assert.equal(store.pendingBytes, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── redaction integration ──────────────────────────────────────────────

test('redact: when blobStore is provided, over-cap content is persisted', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    // 5KB string > default 4KB cap.
    const big = 'x'.repeat(5000)
    const { value } = redact(big, { blobStore: store })
    const ref = value as { truncated: true; contentHash: string; size: number }
    assert.equal(ref.truncated, true)
    assert.equal(ref.size, 5000)
    assert.match(ref.contentHash, /^sha256:[0-9a-f]{64}$/)
    // Bytes are recoverable from disk after the queue drains.
    await store.flush()
    const path = store.pathFor(ref.contentHash)
    assert.ok(existsSync(path))
    assert.equal(readFileSync(path, 'utf8').length, 5000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact: without blobStore, ref still emitted but bytes are lost (back-compat)', () => {
  const big = 'y'.repeat(5000)
  const { value } = redact(big)
  const ref = value as { truncated: true; contentHash: string }
  assert.equal(ref.truncated, true)
  assert.match(ref.contentHash, /^sha256:[0-9a-f]{64}$/)
  // Nothing on disk — caller didn't supply a sink.
})

test('redact: large object (>4KB serialized) writes to blob', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const obj = { messages: Array.from({ length: 100 }, (_, i) => ({ idx: i, text: 'lorem ipsum '.repeat(10) })) }
    const { value } = redact(obj, { blobStore: store })
    const ref = value as { truncated: true; contentHash: string; size: number }
    assert.equal(ref.truncated, true)
    assert.ok(ref.size > 4096)
    await store.flush()
    assert.ok(existsSync(store.pathFor(ref.contentHash)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact: image data: URL writes binary content to blob', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(2000)
    const { value } = redact(dataUrl, { blobStore: store })
    const ref = value as { contentHash: string; mimeType: string; size: number }
    assert.match(ref.contentHash, /^sha256:[0-9a-f]{64}$/)
    assert.match(ref.mimeType, /^image\//)
    await store.flush()
    assert.ok(existsSync(store.pathFor(ref.contentHash)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact: small content (<4KB) does NOT touch the blob store', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const small = 'just a small string'
    redact(small, { blobStore: store })
    // No sharded subdirs created beyond the root (which existed at temp setup).
    const blobsRoot = join(dir, '.research-pilot/blobs')
    assert.ok(existsSync(blobsRoot))
    // Find any sha256 dirs (length 2 hex). Should be 0.
const entries = readdirSync(blobsRoot)
    const shardDirs = entries.filter((e: string) => /^[0-9a-f]{2}$/.test(e))
    assert.equal(shardDirs.length, 0, 'small content does not write to blob store')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact: same content twice → blob written once (dedup via content-addressing)', async () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const big = 'z'.repeat(5000)
    const r1 = redact(big, { blobStore: store }).value as { contentHash: string }
    const r2 = redact(big, { blobStore: store }).value as { contentHash: string }
    assert.equal(r1.contentHash, r2.contentHash)
    await store.flush()
    // Only one file under the shard.
    const hash = r1.contentHash.replace('sha256:', '')
    const shardDir = join(dir, '.research-pilot/blobs', hash.slice(0, 2))
assert.equal(readdirSync(shardDir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
