/**
 * Tests for artifact-ledger turnId plumbing.
 *
 * The artifact-ledger writer auto-pulls traceId/spanId from the active OTel
 * span. As of Phase T it also falls back to the turn id published on the
 * active OTel context (TURN_ID_KEY) when the caller omits it — but an explicit
 * turnId still wins, and these store-level callers thread it directly. These
 * tests pin three facts about the explicit path:
 *
 *   1. createArtifact: when CLIContext.turnId is set, the create row carries it.
 *   2. updateArtifact / deleteArtifact: when 4th-arg turnId is set, the row carries it.
 *   3. Back-compat: omitting turnId yields a row without the field (not "null").
 *
 * No agent, no LLM, no tracer wired and no surrounding turn context — pure
 * file-IO test against the ledger append path. The context-fallback path is
 * covered separately in lib/ledger/__tests__/ledgers.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createArtifact,
  updateArtifact,
  deleteArtifact
} from '../store.js'
import { PATHS, type CLIContext } from '../../types.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-ledger-turn-'))
}

function cleanupProject(project: string): void {
  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && (code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EBUSY')) {
      return
    }
    throw err
  }
}

function readLedger(project: string): Array<Record<string, unknown>> {
  const file = join(project, PATHS.ledgerArtifact)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
}

// readLedger may run before the fire-and-forget ledger write completes.
// All ledger writes are async + best-effort; for the test we wait briefly
// until the row appears, with a small bound so a real failure still fails.
async function waitForRows(project: string, expected: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const rows = readLedger(project)
    if (rows.length >= expected) return rows
    await new Promise(r => setTimeout(r, 20))
  }
  return readLedger(project)
}

function makeCtx(project: string, turnId?: string): CLIContext {
  return { sessionId: 'sess-A', projectPath: project, turnId }
}

test('createArtifact: ledger row carries turnId from CLIContext', async () => {
  const project = tmpProject()
  try {
    createArtifact(
      { type: 'note', title: 'Foo', content: 'bar', provenance: { source: 'agent' } },
      makeCtx(project, 'turn-abc')
    )
    const rows = await waitForRows(project, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].op, 'create')
    assert.equal(rows[0].turnId, 'turn-abc')
  } finally {
    cleanupProject(project)
  }
})

test('createArtifact: omitted turnId → ledger row has no turnId field', async () => {
  const project = tmpProject()
  try {
    createArtifact(
      { type: 'note', title: 'Foo', content: 'bar', provenance: { source: 'agent' } },
      makeCtx(project) // no turnId
    )
    const rows = await waitForRows(project, 1)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].op, 'create')
    // The writer strips undefined fields for tidiness, so the key must be absent.
    assert.equal('turnId' in rows[0], false)
  } finally {
    cleanupProject(project)
  }
})

test('updateArtifact: ledger edit row carries turnId argument', async () => {
  const project = tmpProject()
  try {
    const { artifact } = createArtifact(
      { type: 'note', title: 'Foo', content: 'bar', provenance: { source: 'agent' } },
      makeCtx(project, 'turn-create')
    )
    await waitForRows(project, 1)

    updateArtifact(project, artifact.id, { title: 'Foo v2' }, 'turn-update')
    const rows = await waitForRows(project, 2)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].turnId, 'turn-create')
    assert.equal(rows[1].op, 'edit')
    assert.equal(rows[1].turnId, 'turn-update')
  } finally {
    cleanupProject(project)
  }
})

test('updateArtifact: omitted turnId argument → no turnId on edit row', async () => {
  const project = tmpProject()
  try {
    const { artifact } = createArtifact(
      { type: 'note', title: 'Foo', content: 'bar', provenance: { source: 'agent' } },
      makeCtx(project) // no turnId
    )
    await waitForRows(project, 1)
    updateArtifact(project, artifact.id, { title: 'Foo v2' }) // no turnId arg
    const rows = await waitForRows(project, 2)
    assert.equal(rows.length, 2)
    assert.equal('turnId' in rows[1], false)
  } finally {
    cleanupProject(project)
  }
})

test('deleteArtifact: ledger delete row carries turnId argument', async () => {
  const project = tmpProject()
  try {
    const { artifact } = createArtifact(
      { type: 'note', title: 'Foo', content: 'bar', provenance: { source: 'agent' } },
      makeCtx(project, 'turn-create')
    )
    await waitForRows(project, 1)

    deleteArtifact(project, artifact.id, 'turn-delete')
    const rows = await waitForRows(project, 2)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].op, 'delete')
    assert.equal(rows[1].turnId, 'turn-delete')
  } finally {
    cleanupProject(project)
  }
})
