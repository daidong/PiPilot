/**
 * Tests for the renderer-side import-store (RFC-006 PR-3).
 *
 * Stubs `window.api` so the store can interact with the importer IPC
 * surface without a real Electron preload bridge. Validates:
 *
 *   - status machine: idle → running → done (and idle → error)
 *   - the progress stream updates live counters correctly
 *   - reduceCounts is a pure function over a sequence of events
 *   - canceling the picker leaves status untouched
 *   - subscribeToProgress returns an unsub that detaches the listener
 *   - progress events are dropped when status !== 'running'
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Types mirror the public BibImportProgressEvent / BibImportResult shapes
// without importing the preload module (avoids a chicken-and-egg with
// Electron at test time).
interface FakeProgress {
  index: number
  total: number
  citeKey: string
  status: 'added' | 'merged' | 'merged-no-change' | 'duplicate-in-file' | 'failed'
  reason?: string
}

interface FakeResult {
  added: number
  merged: number
  mergedNoChange: number
  duplicateInFile: number
  failed: number
  failureDetails: Array<{ citeKey: string; reason: string }>
  importedPaperIds: string[]
  parserWarnings: string[]
}

// ─── Fake preload bridge ─────────────────────────────────────────────

let progressCallback: ((event: FakeProgress) => void) | null = null
let pendingPickResult: string | null = '/tmp/fake.bib'
let pendingFileResult: { success: true; result: FakeResult } | { success: false; error: string } = {
  success: true,
  result: {
    added: 0, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
    failureDetails: [], importedPaperIds: [], parserWarnings: [],
  },
}
let pendingStringResult: typeof pendingFileResult = pendingFileResult

// Tracks how many times each api method was called.
let pickCount = 0
let fileCount = 0
let stringCount = 0
let lastFilePath: string | null = null

const fakeApi = {
  pickBibtexFile: async () => {
    pickCount++
    return pendingPickResult
  },
  importBibtexFile: async (path: string) => {
    fileCount++
    lastFilePath = path
    return pendingFileResult
  },
  importBibtexString: async (_contents: string) => {
    stringCount++
    return pendingStringResult
  },
  onImportProgress: (cb: (event: FakeProgress) => void) => {
    progressCallback = cb
    return () => { progressCallback = null }
  },
}

;(globalThis as { window?: unknown }).window = { api: fakeApi }

import { useImportStore, reduceCounts } from '../import-store.ts'

const store = useImportStore

beforeEach(() => {
  store.getState().reset()
  progressCallback = null
  pendingPickResult = '/tmp/fake.bib'
  pendingFileResult = {
    success: true,
    result: {
      added: 0, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
      failureDetails: [], importedPaperIds: [], parserWarnings: [],
    },
  }
  pendingStringResult = pendingFileResult
  pickCount = 0
  fileCount = 0
  stringCount = 0
  lastFilePath = null
})

// ─── reduceCounts (pure) ─────────────────────────────────────────────

test('reduceCounts increments the right bucket per event', () => {
  const zero = {
    total: 0, processed: 0,
    added: 0, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
  }
  const after1 = reduceCounts(zero, { index: 0, total: 5, citeKey: 'a', status: 'added' })
  assert.equal(after1.processed, 1)
  assert.equal(after1.added, 1)
  assert.equal(after1.total, 5)
  assert.equal(after1.lastCiteKey, 'a')

  const after2 = reduceCounts(after1, { index: 1, total: 5, citeKey: 'b', status: 'merged' })
  assert.equal(after2.merged, 1)
  assert.equal(after2.processed, 2)

  const after3 = reduceCounts(after2, { index: 2, total: 5, citeKey: 'c', status: 'merged-no-change' })
  assert.equal(after3.mergedNoChange, 1)

  const after4 = reduceCounts(after3, { index: 3, total: 5, citeKey: 'd', status: 'duplicate-in-file' })
  assert.equal(after4.duplicateInFile, 1)

  const after5 = reduceCounts(after4, { index: 4, total: 5, citeKey: 'e', status: 'failed', reason: 'parser-error' })
  assert.equal(after5.failed, 1)
  assert.equal(after5.lastStatus, 'failed')
})

test('reduceCounts trusts the latest event\'s total (handles late parser reports)', () => {
  const zero = {
    total: 0, processed: 0,
    added: 0, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
  }
  const after1 = reduceCounts(zero, { index: 0, total: 10, citeKey: 'a', status: 'added' })
  assert.equal(after1.total, 10)
  const after2 = reduceCounts(after1, { index: 1, total: 9, citeKey: 'b', status: 'added' })
  assert.equal(after2.total, 9, 'newer total wins — parser may have skipped a malformed entry')
})

// ─── Status machine ─────────────────────────────────────────────────

test('startFromFile: idle → running → done', async () => {
  pendingFileResult = {
    success: true,
    result: {
      added: 3, merged: 1, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
      failureDetails: [], importedPaperIds: ['p1', 'p2', 'p3', 'p4'], parserWarnings: [],
    },
  }
  assert.equal(store.getState().status, 'idle')

  const promise = store.getState().startFromFile('/tmp/sample.bib')
  // Status should flip to 'running' synchronously (set() before await).
  assert.equal(store.getState().status, 'running')
  assert.equal(store.getState().sourcePath, '/tmp/sample.bib')

  await promise

  const s = store.getState()
  assert.equal(s.status, 'done')
  assert.equal(s.result?.added, 3)
  assert.equal(s.result?.importedPaperIds.length, 4)
  assert.equal(fileCount, 1)
  assert.equal(lastFilePath, '/tmp/sample.bib')
})

test('startFromFile: failure response transitions to error state', async () => {
  pendingFileResult = { success: false, error: 'BibTeX file is not valid UTF-8.' }
  await store.getState().startFromFile('/tmp/sample.bib')
  const s = store.getState()
  assert.equal(s.status, 'error')
  assert.match(s.error ?? '', /UTF-8/)
  assert.equal(s.result, null)
})

test('startFromPicker: returns silently when user cancels', async () => {
  pendingPickResult = null
  await store.getState().startFromPicker()
  // No file import attempted; state untouched.
  assert.equal(store.getState().status, 'idle')
  assert.equal(pickCount, 1)
  assert.equal(fileCount, 0)
})

test('startFromPicker: success path picks then imports', async () => {
  pendingPickResult = '/tmp/picked.bib'
  pendingFileResult = {
    success: true,
    result: {
      added: 1, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
      failureDetails: [], importedPaperIds: ['x'], parserWarnings: [],
    },
  }
  await store.getState().startFromPicker()
  assert.equal(store.getState().status, 'done')
  assert.equal(store.getState().sourcePath, '/tmp/picked.bib')
  assert.equal(lastFilePath, '/tmp/picked.bib')
})

test('startFromString: applies label as sourcePath', async () => {
  pendingStringResult = {
    success: true,
    result: {
      added: 1, merged: 0, mergedNoChange: 0, duplicateInFile: 0, failed: 0,
      failureDetails: [], importedPaperIds: ['x'], parserWarnings: [],
    },
  }
  await store.getState().startFromString('@article{x, title={X}}', 'pasted-from-clipboard')
  const s = store.getState()
  assert.equal(s.status, 'done')
  assert.equal(s.sourcePath, 'pasted-from-clipboard')
  assert.equal(stringCount, 1)
})

test('reset returns the store to a clean idle state', async () => {
  pendingFileResult = {
    success: true,
    result: {
      added: 5, merged: 2, mergedNoChange: 0, duplicateInFile: 1, failed: 0,
      failureDetails: [{ citeKey: 'bad', reason: 'parser-error' }],
      importedPaperIds: ['a', 'b', 'c', 'd', 'e'], parserWarnings: [],
    },
  }
  await store.getState().startFromFile('/tmp/sample.bib')
  assert.equal(store.getState().status, 'done')

  store.getState().reset()
  const s = store.getState()
  assert.equal(s.status, 'idle')
  assert.equal(s.result, null)
  assert.equal(s.error, null)
  assert.equal(s.sourcePath, undefined)
  assert.equal(s.counts.processed, 0)
})

// ─── Progress events ─────────────────────────────────────────────────
//
// We test the subscribe → emit → reduce path by flipping the store
// directly into 'running' and firing events at the registered
// callback. Going through `startFromFile` would race the import
// promise with synchronous event emission and add no coverage that
// the reduceCounts tests above don't already provide.

test('subscribeToProgress: events received while running update live counts', () => {
  const unsub = store.getState().subscribeToProgress()
  assert.ok(progressCallback, 'subscribe registered a callback')

  // Flip into running so the gate accepts events.
  store.setState({ status: 'running' })

  progressCallback!({ index: 0, total: 3, citeKey: 'a', status: 'added' })
  progressCallback!({ index: 1, total: 3, citeKey: 'b', status: 'merged' })
  progressCallback!({ index: 2, total: 3, citeKey: 'c', status: 'duplicate-in-file' })

  const live = store.getState().counts
  assert.equal(live.total, 3)
  assert.equal(live.processed, 3)
  assert.equal(live.added, 1)
  assert.equal(live.merged, 1)
  assert.equal(live.duplicateInFile, 1)
  assert.equal(live.lastCiteKey, 'c')
  assert.equal(live.lastStatus, 'duplicate-in-file')

  unsub()
})

test('subscribeToProgress: events arriving when idle are dropped', () => {
  store.getState().subscribeToProgress()
  // Store starts in 'idle' (beforeEach reset) — emitting must be a no-op.
  progressCallback!({ index: 0, total: 1, citeKey: 'a', status: 'added' })
  assert.equal(store.getState().counts.processed, 0)
})

test('subscribeToProgress: events arriving after done are dropped', () => {
  store.getState().subscribeToProgress()
  store.setState({ status: 'done' })
  progressCallback!({ index: 0, total: 1, citeKey: 'a', status: 'added' })
  assert.equal(store.getState().counts.processed, 0)
})

test('subscribeToProgress: unsub stops further updates', () => {
  store.setState({ status: 'running' })
  const unsub = store.getState().subscribeToProgress()
  progressCallback!({ index: 0, total: 1, citeKey: 'a', status: 'added' })
  assert.equal(store.getState().counts.processed, 1)

  unsub()
  // After unsub the fake bridge clears the callback (mirrors how the
  // real preload bridge implements ipcRenderer.removeListener).
  assert.equal(progressCallback, null)
})
