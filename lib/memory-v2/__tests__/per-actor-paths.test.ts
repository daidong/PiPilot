/**
 * RFC-013 §9 conflict prevention — per-actor artifact placement.
 *
 * In a SHARED project new artifacts carry `provenance.actor` and land under a
 * `<typeDir>/<displayName-slug>/…` subdir so collaborators never collide on the
 * same path. The path stays a pure function of the artifact (actor travels in
 * the file), so update/delete/index recompute it without storage. Solo/legacy
 * artifacts (no actor) stay flat (back-compat).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { primaryFileRel, writeArtifactToFile } from '../artifact-writer.js'
import { createArtifact, updateArtifact } from '../store.js'
import { rebuildIndex } from '../indexer.js'
import type { NoteArtifact, PaperArtifact, CLIContext } from '../../types.js'

// ── primaryFileRel: pure path derivation ─────────────────────────────────────

test('primaryFileRel: actor → per-actor subdir; no actor → flat', () => {
  const note: NoteArtifact = {
    id: 'n1', type: 'note', title: 'T', tags: [], content: 'c',
    provenance: { source: 'agent', sessionId: 's' }, createdAt: '', updatedAt: '',
  }
  assert.equal(primaryFileRel(note), 'rp-artifacts/notes/n1.md')
  assert.equal(
    primaryFileRel({ ...note, provenance: { ...note.provenance, actor: { id: 'a', displayName: 'Alice Chen' } } }),
    'rp-artifacts/notes/alice-chen/n1.md'
  )

  const paper: PaperArtifact = {
    id: 'p1', type: 'paper', title: 'P', tags: [], citeKey: 'Smith2020',
    provenance: { source: 'import', sessionId: 'u', actor: { id: 'b', displayName: 'Bob' } },
    createdAt: '', updatedAt: '',
  }
  // Paper filenames carry a stable id fragment so same-citeKey papers don't collide.
  assert.equal(primaryFileRel(paper), 'rp-artifacts/papers/bob/Smith2020-p1.bib')
})

// ── paper path uniqueness: same citeKey must not overwrite ────────────────────

const mkPaper = (id: string, citeKey: string): PaperArtifact => ({
  id, type: 'paper', title: id, tags: [], citeKey,
  provenance: { source: 'import', sessionId: 'u' }, createdAt: '', updatedAt: '',
})

test('paper files: same citeKey, distinct ids → distinct files, neither overwritten', () => {
  const dir = makeProject({ shared: false })
  try {
    const a = mkPaper('aaaa1111', 'smith2020')
    const b = mkPaper('bbbb2222', 'smith2020') // same citeKey, different paper
    const relA = writeArtifactToFile(dir, a)
    const relB = writeArtifactToFile(dir, b)
    assert.notEqual(relA, relB, 'distinct paths despite a shared citeKey')
    assert.ok(existsSync(join(dir, relA)) && existsSync(join(dir, relB)), 'both .bib files survive')
    assert.equal(rebuildIndex(dir).filter(x => x.type === 'paper').length, 2, 'both papers indexed')
  } finally {
    cleanup(dir)
  }
})

test('paper files: a legacy <citeKey>.bib (same id) converges to the id-fragment name', () => {
  const dir = makeProject({ shared: false })
  try {
    mkdirSync(join(dir, 'rp-artifacts', 'papers'), { recursive: true })
    writeFileSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.bib'), '@article{smith2020,}\n')
    writeFileSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.rp.yaml'), 'id: aaaa1111\n')
    const rel = writeArtifactToFile(dir, mkPaper('aaaa1111', 'smith2020'))
    assert.ok(existsSync(join(dir, rel)), 'new id-fragment file written')
    assert.ok(!existsSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.bib')), 'own legacy file removed')
  } finally {
    cleanup(dir)
  }
})

test('updateArtifact: changing a paper citeKey moves the file and removes the old (no orphan)', () => {
  const dir = makeProject({ shared: false })
  try {
    const p = mkPaper('aaaa1111', 'old2020')
    writeArtifactToFile(dir, p)
    rebuildIndex(dir) // make it findable via the index
    const oldRel = primaryFileRel(p)
    assert.ok(existsSync(join(dir, oldRel)), 'old citeKey file present')

    const upd = updateArtifact(dir, 'aaaa1111', { citeKey: 'new2021' } as Record<string, unknown>)
    assert.ok(upd, 'update found the paper')
    const newRel = primaryFileRel(upd!.artifact)
    assert.notEqual(oldRel, newRel, 'path changed with the citeKey')
    assert.ok(existsSync(join(dir, newRel)), 'new citeKey file written')
    assert.ok(!existsSync(join(dir, oldRel)), 'old citeKey file removed (no orphan)')
    assert.equal(rebuildIndex(dir).filter(a => a.type === 'paper').length, 1, 'exactly one paper remains')
  } finally {
    cleanup(dir)
  }
})

test('paper files: a DIFFERENT paper sharing the citeKey is NOT removed (id-guarded)', () => {
  const dir = makeProject({ shared: false })
  try {
    mkdirSync(join(dir, 'rp-artifacts', 'papers'), { recursive: true })
    writeFileSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.bib'), '@article{smith2020,}\n')
    writeFileSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.rp.yaml'), 'id: someoneelse\n')
    writeArtifactToFile(dir, mkPaper('aaaa1111', 'smith2020'))
    assert.ok(existsSync(join(dir, 'rp-artifacts', 'papers', 'smith2020.bib')), 'a different paper at the legacy name is preserved')
  } finally {
    cleanup(dir)
  }
})

// ── createArtifact: stamps actor + lands in subdir when shared ────────────────

function makeProject(opts: {
  shared: boolean
  displayName?: string
  actorId?: string
  members?: Array<{ actorId?: string; displayName: string }>
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-pa-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  const cfg: Record<string, unknown> = {
    name: 'P', questions: [], userCorrections: [], createdAt: '', updatedAt: '',
  }
  if (opts.shared) cfg.share = { host: 'github', repo: 'o/r' }
  if (opts.members) cfg.members = opts.members
  writeFileSync(join(dir, '.research-pilot', 'project.json'), JSON.stringify(cfg))
  if (opts.displayName) {
    writeFileSync(join(dir, '.research-pilot', 'identity.json'), JSON.stringify({ id: opts.actorId ?? 'act1', displayName: opts.displayName }))
  }
  return dir
}
const ctx = (projectPath: string): CLIContext => ({ projectPath, sessionId: 's' })
// Teardown can race index/file writes under full-suite I/O load → tolerate ENOTEMPTY.
const cleanup = (dir: string): void => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } }

test('createArtifact in a SHARED project: actor stamped, file under per-actor subdir, stable across update + indexable', () => {
  const dir = makeProject({ shared: true, displayName: 'Alice Chen' })
  try {
    const rec = createArtifact({ type: 'note', title: 'Hi', content: 'body' }, ctx(dir))
    const expected = join(dir, 'rp-artifacts', 'notes', 'alice-chen', `${rec.artifact.id}.md`)

    assert.equal(rec.artifact.provenance.actor?.displayName, 'Alice Chen', 'actor stamped')
    assert.ok(existsSync(expected), 'file written under rp-artifacts/notes/alice-chen/')
    assert.ok(!existsSync(join(dir, 'rp-artifacts', 'notes', `${rec.artifact.id}.md`)), 'not also written flat')

    // Update writes the SAME path (no duplicate/orphan), content changes.
    const upd = updateArtifact(dir, rec.artifact.id, { content: 'body2' })
    assert.ok(upd, 'update found the artifact')
    assert.ok(existsSync(expected), 'still at the per-actor path after update')
    assert.match(readFileSync(expected, 'utf-8'), /body2/)

    // The recursive index walk picks it up from the subdir.
    const all = rebuildIndex(dir)
    assert.ok(all.some(a => a.id === rec.artifact.id), 'per-actor artifact is indexed')
  } finally {
    cleanup(dir)
  }
})

test('slug dedup: a roster name collision suffixes the per-actor dir', () => {
  // Two collaborators both named "Alex" → my dir gets a stable id suffix so our
  // per-actor subdirs never merge (§6.1).
  const dir = makeProject({
    shared: true,
    displayName: 'Alex',
    actorId: 'act1',
    members: [{ actorId: 'act2', displayName: 'Alex' }], // the other Alex
  })
  try {
    const rec = createArtifact({ type: 'note', title: 'Hi', content: 'body' }, ctx(dir))
    assert.equal(rec.artifact.provenance.actor?.slug, 'alex-act1', 'slug suffixed with id fragment')
    assert.ok(existsSync(join(dir, 'rp-artifacts', 'notes', 'alex-act1', `${rec.artifact.id}.md`)))
    // No collision when names are distinct → clean slug (covered by the shared test above).
  } finally {
    cleanup(dir)
  }
})

test('createArtifact in an UNSHARED project: no actor, flat path (back-compat)', () => {
  const dir = makeProject({ shared: false })
  try {
    const rec = createArtifact({ type: 'note', title: 'Hi', content: 'body' }, ctx(dir))
    assert.equal(rec.artifact.provenance.actor, undefined, 'no actor stamped when unshared')
    assert.ok(existsSync(join(dir, 'rp-artifacts', 'notes', `${rec.artifact.id}.md`)), 'flat path under rp-artifacts/')
  } finally {
    cleanup(dir)
  }
})
