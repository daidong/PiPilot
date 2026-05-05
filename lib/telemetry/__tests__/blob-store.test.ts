/**
 * Tests for BlobStore + redaction integration.
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

test('BlobStore writes content under {prefix}/{full-sha256}', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const r = store.writeIfMissing('hello world')
    assert.equal(r.size, 11)
    assert.equal(r.isNew, true)
    assert.match(r.hash, /^[0-9a-f]{64}$/)
    const path = store.pathFor(r.hash)
    assert.ok(existsSync(path), `blob file at ${path}`)
    assert.equal(readFileSync(path, 'utf8'), 'hello world')
    // Path is sharded by 2-char prefix
    assert.ok(path.includes(`/blobs/${r.hash.slice(0, 2)}/${r.hash}`))
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

test('BlobStore swallows write errors via onError callback', () => {
  const dir = tempDir()
  try {
    // Make the blobs dir a file so mkdirSync fails.
    const blobsDir = join(dir, '.research-pilot/blobs')
    rmSync(blobsDir, { recursive: true, force: true })
    writeFileSync(blobsDir, 'i am a file, not a dir')
    const store = new BlobStore(dir)
    const errors: unknown[] = []
    const r = store.writeIfMissing('whatever', (err) => errors.push(err))
    // Hash + size still computed — just isNew=false because write failed.
    assert.match(r.hash, /^[0-9a-f]{64}$/)
    assert.equal(r.isNew, false)
    assert.ok(errors.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── redaction integration ──────────────────────────────────────────────

test('redact: when blobStore is provided, over-cap content is persisted', () => {
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
    // Bytes are recoverable from disk.
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

test('redact: large object (>4KB serialized) writes to blob', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const obj = { messages: Array.from({ length: 100 }, (_, i) => ({ idx: i, text: 'lorem ipsum '.repeat(10) })) }
    const { value } = redact(obj, { blobStore: store })
    const ref = value as { truncated: true; contentHash: string; size: number }
    assert.equal(ref.truncated, true)
    assert.ok(ref.size > 4096)
    assert.ok(existsSync(store.pathFor(ref.contentHash)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact: image data: URL writes binary content to blob', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(2000)
    const { value } = redact(dataUrl, { blobStore: store })
    const ref = value as { contentHash: string; mimeType: string; size: number }
    assert.match(ref.contentHash, /^sha256:[0-9a-f]{64}$/)
    assert.match(ref.mimeType, /^image\//)
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

test('redact: same content twice → blob written once (dedup via content-addressing)', () => {
  const dir = tempDir()
  try {
    const store = new BlobStore(dir)
    const big = 'z'.repeat(5000)
    const r1 = redact(big, { blobStore: store }).value as { contentHash: string }
    const r2 = redact(big, { blobStore: store }).value as { contentHash: string }
    assert.equal(r1.contentHash, r2.contentHash)
    // Only one file under the shard.
    const hash = r1.contentHash.replace('sha256:', '')
    const shardDir = join(dir, '.research-pilot/blobs', hash.slice(0, 2))
assert.equal(readdirSync(shardDir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
