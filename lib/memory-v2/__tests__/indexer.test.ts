/**
 * Tests for the RFC-014 workspace indexer: legacy-JSON parity, new-format file
 * recognition, dedup, and persisted shard read/rebuild.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { PATHS, type NoteArtifact, type PaperArtifact, type DataArtifact, type Provenance } from '../../types.js'
import {
  scanWorkspaceArtifacts,
  rebuildIndex,
  readIndex,
  getArtifacts,
  isIndexBuilt
} from '../indexer.js'
import {
  markdownArtifactToText,
  paperToBibEntry,
  paperToSidecarEntry,
  dataArtifactToSidecar
} from '../artifact-files.js'

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipilot-indexer-'))
  for (const p of [PATHS.notes, PATHS.papers, PATHS.data, PATHS.webContent, PATHS.toolOutputs]) {
    mkdirSync(join(dir, p), { recursive: true })
  }
  return dir
}

const prov: Provenance = { source: 'agent', sessionId: 's', extractedFrom: 'agent-response' }

function legacyNote(id: string, title: string): NoteArtifact {
  return {
    id, type: 'note', title, tags: [], provenance: prov,
    createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z',
    content: 'legacy body'
  }
}

test('scan skips heavy/tool dirs — managed files in .venv/node_modules/build are ignored', () => {
  const dir = tmpProject()
  try {
    const seed = (sub: string, id: string) => {
      const d = join(dir, sub)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `${id}.md`), markdownArtifactToText(legacyNote(id, id)))
    }
    seed('.venv/lib', 'venv-note')
    seed('node_modules/pkg', 'nm-note')
    seed('build', 'build-note')
    seed('rp-artifacts/notes', 'real') // a normal location

    const ids = scanWorkspaceArtifacts(dir).map(a => a.id)
    assert.ok(ids.includes('real'), 'a note in a normal dir is indexed')
    assert.ok(!ids.includes('venv-note'), '.venv skipped')
    assert.ok(!ids.includes('nm-note'), 'node_modules skipped')
    assert.ok(!ids.includes('build-note'), 'build skipped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scan finds legacy JSON artifacts (read parity)', () => {
  const proj = tmpProject()
  try {
    const note = legacyNote('legacy-1', 'Legacy Note')
    writeFileSync(join(proj, PATHS.notes, 'legacy-1.json'), JSON.stringify(note), 'utf-8')
    const found = scanWorkspaceArtifacts(proj)
    assert.equal(found.length, 1)
    assert.equal(found[0].id, 'legacy-1')
    assert.equal(found[0].title, 'Legacy Note')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('scan finds new-format .md notes anywhere in the workspace', () => {
  const proj = tmpProject()
  try {
    const note: NoteArtifact = { ...legacyNote('md-1', 'Md Note'), content: '# hi' }
    mkdirSync(join(proj, 'Alice Chen', 'notes'), { recursive: true })
    writeFileSync(join(proj, 'Alice Chen', 'notes', 'mynote.md'), markdownArtifactToText(note), 'utf-8')
    const found = scanWorkspaceArtifacts(proj)
    assert.equal(found.length, 1)
    assert.equal(found[0].id, 'md-1')
    assert.equal((found[0] as NoteArtifact).content, '# hi')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('plain .md without rp front-matter is ignored', () => {
  const proj = tmpProject()
  try {
    writeFileSync(join(proj, 'README.md'), '# Readme\n\nhello', 'utf-8')
    assert.equal(scanWorkspaceArtifacts(proj).length, 0)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('scan finds papers from references.bib + sidecar', () => {
  const proj = tmpProject()
  try {
    const paper: PaperArtifact = {
      id: 'p-1', type: 'paper', title: 'A Paper', tags: ['x'], provenance: { source: 'import', sessionId: 'u' },
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z',
      citeKey: 'smith2025', bibtex: '', doi: '10.1/x', authors: ['Jane Smith'], abstract: 'abs', year: 2025, venue: 'NeurIPS'
    }
    mkdirSync(join(proj, 'papers'), { recursive: true })
    writeFileSync(join(proj, 'papers', 'smith2025.bib'), paperToBibEntry(paper), 'utf-8')
    writeFileSync(join(proj, 'papers', 'smith2025.rp.yaml'), stringifyYaml(paperToSidecarEntry(paper)), 'utf-8')
    const found = scanWorkspaceArtifacts(proj)
    assert.equal(found.length, 1)
    const p = found[0] as PaperArtifact
    assert.equal(p.id, 'p-1')
    assert.equal(p.citeKey, 'smith2025')
    assert.deepEqual(p.authors, ['Jane Smith'])
    assert.equal(p.year, 2025)
    assert.deepEqual(p.tags, ['x'])
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('scan finds data from <datafile>.rp.yaml sidecar', () => {
  const proj = tmpProject()
  try {
    const data: DataArtifact = {
      id: 'd-1', type: 'data', title: 'exp.csv', tags: [], provenance: prov,
      createdAt: '2026-05-24T10:00:00.000Z', updatedAt: '2026-05-24T10:00:00.000Z',
      filePath: 'data/exp.csv', mimeType: 'text/csv'
    }
    mkdirSync(join(proj, 'data'), { recursive: true })
    writeFileSync(join(proj, 'data', 'exp.csv'), 'a,b\n1,2\n', 'utf-8')
    writeFileSync(join(proj, 'data', 'exp.csv.rp.yaml'), stringifyYaml(dataArtifactToSidecar(data)), 'utf-8')
    const found = scanWorkspaceArtifacts(proj)
    assert.equal(found.length, 1)
    const d = found[0] as DataArtifact
    assert.equal(d.id, 'd-1')
    assert.equal(d.filePath, 'data/exp.csv')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('new-format wins over legacy JSON on id collision', () => {
  const proj = tmpProject()
  try {
    writeFileSync(join(proj, PATHS.notes, 'dup.json'), JSON.stringify(legacyNote('dup', 'Legacy Title')), 'utf-8')
    const newer: NoteArtifact = { ...legacyNote('dup', 'New Title'), content: 'new' }
    mkdirSync(join(proj, 'notes'), { recursive: true })
    writeFileSync(join(proj, 'notes', 'dup.md'), markdownArtifactToText(newer), 'utf-8')
    const found = scanWorkspaceArtifacts(proj)
    assert.equal(found.length, 1)
    assert.equal(found[0].title, 'New Title')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('rebuildIndex persists shards; readIndex returns them; getArtifacts lazy-builds', () => {
  const proj = tmpProject()
  try {
    writeFileSync(join(proj, PATHS.notes, 'a.json'), JSON.stringify(legacyNote('a', 'A')), 'utf-8')
    // before any build:
    assert.equal(isIndexBuilt(proj), false)
    assert.equal(readIndex(proj), null)
    // lazy build via getArtifacts:
    const got = getArtifacts(proj)
    assert.equal(got.length, 1)
    assert.equal(isIndexBuilt(proj), true)
    // readIndex now returns persisted shards:
    const cached = readIndex(proj)
    assert.ok(cached)
    assert.equal(cached!.length, 1)
    assert.equal(cached![0].id, 'a')
    // rebuild is idempotent:
    assert.equal(rebuildIndex(proj).length, 1)
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})
