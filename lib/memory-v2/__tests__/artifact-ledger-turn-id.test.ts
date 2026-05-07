/**
 * Tests for artifact-ledger turnId plumbing.
 *
 * The artifact-ledger writer auto-pulls traceId/spanId from the active OTel
 * span, but turnId is not on the span (it's on a tracer-managed attribute,
 * which OTel doesn't expose for read). So callers must pass turnId
 * explicitly. These tests pin three facts:
 *
 *   1. createArtifact: when CLIContext.turnId is set, the create row carries it.
 *   2. updateArtifact / deleteArtifact: when 4th-arg turnId is set, the row carries it.
 *   3. Back-compat: omitting turnId yields a row without the field (not "null").
 *
 * No agent, no LLM, no tracer wired — pure file-IO test against the ledger
 * append path.
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
    rmSync(project, { recursive: true, force: true })
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
    rmSync(project, { recursive: true, force: true })
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
    rmSync(project, { recursive: true, force: true })
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
    rmSync(project, { recursive: true, force: true })
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
    rmSync(project, { recursive: true, force: true })
  }
})
