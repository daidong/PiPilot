import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  createArtifactLedgerWriter,
  createMemoryLedgerWriter,
  createUserResponseSignalsWriter,
  createViewLogWriter
} from '../index.js'
import { TURN_ID_KEY } from '../../telemetry/context-keys.js'
import { PATHS } from '../../types.js'

// The Phase T turnId fallback reads the active OTel context. In the running
// app a context manager is installed by PipilotTracer's constructor; install
// one here so `context.with()` actually propagates values. (The default no-op
// manager makes context.with() inert, which would make the fallback
// unreachable — a test artifact, not a production behavior.) Node's test
// runner isolates each file in its own process, so this global is local to
// this suite.
const ctxMgr = new AsyncLocalStorageContextManager()
ctxMgr.enable()
context.setGlobalContextManager(ctxMgr)

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-ledger-'))
  mkdirSync(join(dir, '.research-pilot/artifacts'), { recursive: true })
  mkdirSync(join(dir, '.research-pilot/memory-v2'), { recursive: true })
  return dir
}

test('artifact ledger writes a row with required fields', async () => {
  const dir = tempProject()
  try {
    const w = createArtifactLedgerWriter(dir)
    const ok = await w.append({
      artifactId: 'a-1',
      version: 1,
      op: 'create',
      type: 'note',
      path: 'notes/test.md',
      contentHash: 'sha256:deadbeef',
      initiator: 'user'
    })
    assert.equal(ok, true)
    const content = readFileSync(join(dir, PATHS.ledgerArtifact), 'utf8')
    const row = JSON.parse(content.trim())
    assert.equal(row.artifactId, 'a-1')
    assert.equal(row.op, 'create')
    assert.equal(row.versionBefore, null)
    assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory ledger writes a row with provenance', async () => {
  const dir = tempProject()
  try {
    const w = createMemoryLedgerWriter(dir)
    const ok = await w.append({
      memoryId: 'm-1',
      op: 'create',
      scope: 'project',
      type: 'extracted-claim',
      provenance: { source: 'extraction' }
    })
    assert.equal(ok, true)
    const row = JSON.parse(readFileSync(join(dir, PATHS.ledgerMemory), 'utf8').trim())
    assert.equal(row.memoryId, 'm-1')
    assert.equal(row.scope, 'project')
    assert.equal(row.provenance.source, 'extraction')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('user-response signals ledger writes raw facts only', async () => {
  const dir = tempProject()
  try {
    const w = createUserResponseSignalsWriter(dir)
    const ok = await w.append({
      turnId: 'u-100',
      messageContentHash: 'sha256:cafe',
      messageCharLen: 42,
      referencedArtifactIds: ['paper.md@v3']
    })
    assert.equal(ok, true)
    const row = JSON.parse(readFileSync(join(dir, PATHS.userResponseSignals), 'utf8').trim())
    assert.equal(row.turnId, 'u-100')
    assert.deepEqual(row.referencedArtifactIds, ['paper.md@v3'])
    // Spec §8.3: no `signal`/`confidence`/`approval` fields.
    assert.equal('signal' in row, false)
    assert.equal('confidence' in row, false)
    assert.equal('approval' in row, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('view log ledger writes a passive view event', async () => {
  const dir = tempProject()
  try {
    const w = createViewLogWriter(dir)
    const ok = await w.append({
      viewId: 'v-1',
      projectId: 'PROJ',
      sessionId: 'SESS',
      target: { kind: 'artifact', id: 'a-7' },
      op: 'view',
      durationMs: 8200
    })
    assert.equal(ok, true)
    const row = JSON.parse(readFileSync(join(dir, PATHS.viewLog), 'utf8').trim())
    assert.equal(row.target.kind, 'artifact')
    assert.equal(row.op, 'view')
    assert.equal(row.durationMs, 8200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact ledger appends multiple rows in order', async () => {
  const dir = tempProject()
  try {
    const w = createArtifactLedgerWriter(dir)
    await w.append({
      artifactId: 'a-1',
      version: 1,
      op: 'create',
      type: 'note',
      path: 'a.md',
      contentHash: 'sha256:1',
      initiator: 'user'
    })
    await w.append({
      artifactId: 'a-1',
      version: 2,
      op: 'edit',
      type: 'note',
      path: 'a.md',
      contentHash: 'sha256:2',
      initiator: 'assistant',
      versionBefore: 1
    })
    const lines = readFileSync(join(dir, PATHS.ledgerArtifact), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]!).version, 1)
    assert.equal(JSON.parse(lines[1]!).version, 2)
    assert.equal(JSON.parse(lines[1]!).versionBefore, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Phase T: turnId fallback from the active OTel turn context ──────────────

test('artifact ledger: turnId falls back to the active turn context', async () => {
  const dir = tempProject()
  try {
    const w = createArtifactLedgerWriter(dir)
    await context.with(context.active().setValue(TURN_ID_KEY, 'turn-ctx-1'), () =>
      w.append({
        artifactId: 'a-1',
        version: 1,
        op: 'create',
        type: 'note',
        path: 'a.md',
        contentHash: 'sha256:1',
        initiator: 'assistant'
        // no explicit turnId
      })
    )
    const row = JSON.parse(readFileSync(join(dir, PATHS.ledgerArtifact), 'utf8').trim())
    assert.equal(row.turnId, 'turn-ctx-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact ledger: explicit turnId wins over the context value', async () => {
  const dir = tempProject()
  try {
    const w = createArtifactLedgerWriter(dir)
    await context.with(context.active().setValue(TURN_ID_KEY, 'turn-ctx-1'), () =>
      w.append({
        artifactId: 'a-1',
        version: 1,
        op: 'create',
        type: 'note',
        path: 'a.md',
        contentHash: 'sha256:1',
        initiator: 'assistant',
        turnId: 'turn-explicit'
      })
    )
    const row = JSON.parse(readFileSync(join(dir, PATHS.ledgerArtifact), 'utf8').trim())
    assert.equal(row.turnId, 'turn-explicit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory ledger: turnId falls back to the active turn context', async () => {
  const dir = tempProject()
  try {
    const w = createMemoryLedgerWriter(dir)
    await context.with(context.active().setValue(TURN_ID_KEY, 'turn-ctx-2'), () =>
      w.append({
        memoryId: 'm-1',
        op: 'create',
        scope: 'project',
        type: 'user',
        provenance: { source: 'tool-output' }
        // no explicit turnId
      })
    )
    const row = JSON.parse(readFileSync(join(dir, PATHS.ledgerMemory), 'utf8').trim())
    assert.equal(row.turnId, 'turn-ctx-2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory ledger: no turn context → row has no turnId field', async () => {
  const dir = tempProject()
  try {
    const w = createMemoryLedgerWriter(dir)
    // No surrounding turn context; the writer must not invent a turnId.
    await w.append({
      memoryId: 'm-1',
      op: 'create',
      scope: 'project',
      type: 'user',
      provenance: { source: 'tool-output' }
    })
    const row = JSON.parse(readFileSync(join(dir, PATHS.ledgerMemory), 'utf8').trim())
    assert.equal('turnId' in row, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
