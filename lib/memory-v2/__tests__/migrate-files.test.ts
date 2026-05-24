/**
 * Tests for the RFC-014 files-as-carrier migration: legacy JSON → workspace
 * files, backup, marker, idempotency, and read-equivalence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PATHS, type Artifact, type Provenance } from '../../types.js'
import { migrateToFilesAsCarrier, isFilesModelMigrated } from '../migrate-files.js'
import { listArtifacts } from '../store.js'

const prov: Provenance = { source: 'agent', sessionId: 's' }

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipilot-migrate-'))
  for (const p of [PATHS.notes, PATHS.papers, PATHS.data, PATHS.webContent, PATHS.toolOutputs]) {
    mkdirSync(join(dir, p), { recursive: true })
  }
  return dir
}

function writeLegacy(projectPath: string, dirRel: string, a: Artifact): void {
  writeFileSync(join(projectPath, dirRel, `${a.id}.json`), JSON.stringify(a, null, 2), 'utf-8')
}

test('migration converts legacy JSON to files, backs up, sets marker, preserves reads', () => {
  const proj = tmpProject()
  try {
    const note: Artifact = {
      id: 'n1', type: 'note', title: 'Note One', tags: ['t'], provenance: prov,
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z', content: 'hello'
    } as Artifact
    const paper: Artifact = {
      id: 'p1', type: 'paper', title: 'Paper One', tags: [], provenance: { source: 'import', sessionId: 'u' },
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z',
      citeKey: 'one2025', bibtex: '', doi: '10.1/a', authors: ['Jane Doe'], abstract: 'abs', year: 2025
    } as Artifact
    const data: Artifact = {
      id: 'd1', type: 'data', title: 'data.csv', tags: [], provenance: prov,
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z', filePath: 'data/data.csv'
    } as Artifact
    writeLegacy(proj, PATHS.notes, note)
    writeLegacy(proj, PATHS.papers, paper)
    writeLegacy(proj, PATHS.data, data)

    assert.equal(isFilesModelMigrated(proj), false)
    const res = migrateToFilesAsCarrier(proj)
    assert.equal(res.migrated, 3)
    assert.equal(isFilesModelMigrated(proj), true)

    // new files exist (one file per paper) under the distinctive rp-artifacts/ dir
    assert.ok(existsSync(join(proj, 'rp-artifacts', 'notes', 'n1.md')), 'note .md written')
    assert.ok(existsSync(join(proj, 'rp-artifacts', 'papers', 'one2025.bib')), 'per-paper .bib written')
    assert.ok(existsSync(join(proj, 'rp-artifacts', 'papers', 'one2025.rp.yaml')), 'per-paper sidecar written')
    assert.ok(existsSync(join(proj, 'data', 'data.csv.rp.yaml')), 'data sidecar written')

    // legacy JSON removed
    assert.equal(existsSync(join(proj, PATHS.notes, 'n1.json')), false, 'legacy note removed')
    assert.equal(existsSync(join(proj, PATHS.papers, 'p1.json')), false, 'legacy paper removed')

    // backup exists
    assert.ok(existsSync(join(proj, PATHS.root, 'artifacts-legacy', 'notes', 'n1.json')), 'backup kept')

    // reads equivalent (by id)
    const all = listArtifacts(proj)
    const ids = all.map(a => a.id).sort()
    assert.deepEqual(ids, ['d1', 'n1', 'p1'])
    const n = all.find(a => a.id === 'n1')!
    assert.equal(n.title, 'Note One')
    assert.equal((n as any).content, 'hello')
    const p = all.find(a => a.id === 'p1')!
    assert.equal(p.title, 'Paper One')
    assert.equal((p as any).citeKey, 'one2025')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('migration is idempotent (second run is a no-op)', () => {
  const proj = tmpProject()
  try {
    writeLegacy(proj, PATHS.notes, {
      id: 'n1', type: 'note', title: 'N', tags: [], provenance: prov,
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z', content: 'x'
    } as Artifact)
    assert.equal(migrateToFilesAsCarrier(proj).migrated, 1)
    const second = migrateToFilesAsCarrier(proj)
    assert.equal(second.skipped, true)
    assert.equal(second.migrated, 0)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})
