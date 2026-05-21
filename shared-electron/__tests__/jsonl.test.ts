import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { countJsonlRows, readJsonlPageFromEnd } from '../jsonl.js'

function withJsonl(lines: unknown[], fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rp-jsonl-'))
  try {
    const file = join(dir, 'rows.jsonl')
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
    fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readJsonlPageFromEnd reads the newest page in chronological order', () => {
  withJsonl(Array.from({ length: 50 }, (_, id) => ({ id })), (file) => {
    assert.deepEqual(readJsonlPageFromEnd<{ id: number }>(file, 0, 5).map((row) => row.id), [45, 46, 47, 48, 49])
  })
})

test('readJsonlPageFromEnd applies offset from the end', () => {
  withJsonl(Array.from({ length: 50 }, (_, id) => ({ id })), (file) => {
    assert.deepEqual(readJsonlPageFromEnd<{ id: number }>(file, 10, 5).map((row) => row.id), [35, 36, 37, 38, 39])
  })
})

test('readJsonlPageFromEnd returns empty when offset is beyond the file', () => {
  withJsonl([{ id: 1 }, { id: 2 }], (file) => {
    assert.deepEqual(readJsonlPageFromEnd(file, 10, 5), [])
  })
})

test('readJsonlPageFromEnd preserves a long unicode row spanning chunks', () => {
  const long = 'prefix-' + '研究🚀'.repeat(20_000)
  withJsonl([{ id: 1, text: long }], (file) => {
    assert.deepEqual(readJsonlPageFromEnd<{ id: number; text: string }>(file, 0, 1), [{ id: 1, text: long }])
  })
})

test('countJsonlRows counts rows without parsing payloads', () => {
  withJsonl([{ id: 1 }, { id: 2 }, { id: 3 }], (file) => {
    assert.equal(countJsonlRows(file), 3)
  })
})
