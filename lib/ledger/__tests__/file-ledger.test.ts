/**
 * File ledger: write-time provenance for raw files.
 *
 * recordFileWrite hashes an on-disk file and appends a `write` row that auto-
 * pulls the active tool-call id off the OTel context (TOOL_CALL_KEY), so the
 * producing tool is captured without the call site threading it. These tests
 * pin: (1) the toolCallId comes from the ambient context; (2) the content hash
 * and size are recorded; (3) outside any tool call, the row carries no creator.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { recordFileWrite } from '../file-ledger.js'
import { TOOL_CALL_KEY } from '../../telemetry/context-keys.js'
import { PATHS } from '../../types.js'

// The ambient TOOL_CALL_KEY fallback reads the active OTel context; install a
// real context manager so context.with() actually propagates (the default
// no-op manager makes it inert). Node isolates each test file in its own
// process, so this global stays local to this suite.
const ctxMgr = new AsyncLocalStorageContextManager()
ctxMgr.enable()
context.setGlobalContextManager(ctxMgr)

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-file-ledger-'))
  mkdirSync(join(dir, '.research-pilot/files'), { recursive: true })
  return dir
}
function readLedger(project: string): Array<Record<string, unknown>> {
  const file = join(project, PATHS.ledgerFile)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

test('recordFileWrite: row carries the toolCallId from the active context + hash + size', async () => {
  const dir = tempProject()
  try {
    const target = join(dir, 'cache', 'paper.tex')
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(target, 'hello world', 'utf-8')

    await context.with(context.active().setValue(TOOL_CALL_KEY, 'call-xyz'), () =>
      recordFileWrite(dir, target, { tool: 'fetch-fulltext' }))

    const rows = readLedger(dir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].op, 'write')
    // Stored project-relative (the same way the agent refers to in-project
    // files), not absolute — so the audit graph keys it to the same node that
    // read/grep create from their relative path args.
    assert.equal(rows[0].path, 'cache/paper.tex')
    assert.equal(rows[0].tool, 'fetch-fulltext')
    assert.equal(rows[0].toolCallId, 'call-xyz')
    assert.equal(rows[0].byteSize, 'hello world'.length)
    assert.match(String(rows[0].contentHash), /^sha256:[0-9a-f]{64}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFileWrite: outside any tool call → row has no toolCallId', async () => {
  const dir = tempProject()
  try {
    const target = join(dir, 'cache', 'paper.tex')
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(target, 'data', 'utf-8')

    // No surrounding tool-call context (e.g. background backfill).
    await recordFileWrite(dir, target, { tool: 'fetch-fulltext' })

    const rows = readLedger(dir)
    assert.equal(rows.length, 1)
    assert.equal('toolCallId' in rows[0], false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordFileWrite: a missing file still records the path (no hash), never throws', async () => {
  const dir = tempProject()
  try {
    const target = join(dir, 'cache', 'gone.tex')
    await recordFileWrite(dir, target, { tool: 'fetch-fulltext' })
    const rows = readLedger(dir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].path, 'cache/gone.tex')
    assert.equal('contentHash' in rows[0], false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
