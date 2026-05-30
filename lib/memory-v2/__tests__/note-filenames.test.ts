/**
 * Note / tool-output files are named by their TITLE (`<title-slug>-<idFrag>.md`),
 * like papers — not by a bare UUID. The title lives in front-matter, so the
 * filename is purely for the human browsing `rp-artifacts/notes/`; the index
 * keys on rp.id, so entries survive any rename.
 *
 * Covers: title-based primaryFileRel (incl. CJK / empty / long / collisions),
 * rename-on-title-edit, and the one-time convergeManagedMdFilenames migration.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { primaryFileRel, legacyMdFileRel } from '../artifact-writer.js'
import { createArtifact, updateArtifact, ensureAgentMd } from '../store.js'
import { rebuildIndex, scanWorkspaceArtifacts } from '../indexer.js'
import { markdownArtifactToText } from '../artifact-files.js'
import { convergeManagedMdFilenames, isNoteFilenamesConverged } from '../migrate-files.js'
import { AGENT_MD_ID, type NoteArtifact, type ToolOutputArtifact, type CLIContext } from '../../types.js'

const soloProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-nf-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  writeFileSync(
    join(dir, '.research-pilot', 'project.json'),
    JSON.stringify({ name: 'P', questions: [], userCorrections: [], createdAt: '', updatedAt: '' }),
  )
  return dir
}
const ctx = (projectPath: string): CLIContext => ({ projectPath, sessionId: 's' })
const cleanup = (dir: string): void => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } }

const mkNote = (id: string, title: string, actor?: { id: string; displayName: string; slug?: string }): NoteArtifact => ({
  id, type: 'note', title, tags: [], content: `body of ${id}`,
  provenance: { source: 'user', sessionId: 's', ...(actor ? { actor } : {}) },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

// ── primaryFileRel: title-based naming ───────────────────────────────────────

test('primaryFileRel: notes are `<title-slug>-<idFrag>.md` (spaces→_, CJK kept)', () => {
  assert.equal(primaryFileRel(mkNote('aaaa1111', 'Reliability Sweep Results')), 'rp-artifacts/notes/Reliability_Sweep_Results-aaaa1111.md')
  assert.equal(primaryFileRel(mkNote('bbbb2222', '可靠性复现结果')), 'rp-artifacts/notes/可靠性复现结果-bbbb2222.md')
})

test('primaryFileRel: empty title falls back to `note`; long title truncates to 60', () => {
  assert.equal(primaryFileRel(mkNote('cccc3333', '   ')), 'rp-artifacts/notes/note-cccc3333.md')
  const rel = primaryFileRel(mkNote('ffff6666', 'x'.repeat(120)))
  const stem = rel.split('/').pop()!.replace(/-ffff6666\.md$/, '')
  assert.equal(stem.length, 60, 'slug truncated to 60 chars')
})

test('primaryFileRel: same title + distinct ids → distinct files (idFrag disambiguates)', () => {
  assert.notEqual(primaryFileRel(mkNote('dddd4444', 'Plan')), primaryFileRel(mkNote('eeee5555', 'Plan')))
})

test('primaryFileRel: tool-output is title-named too', () => {
  const to: ToolOutputArtifact = {
    id: 'tttt0001', type: 'tool-output', title: 'Run Log', tags: [], toolName: 'bash',
    provenance: { source: 'agent', sessionId: 's' }, createdAt: '', updatedAt: '',
  }
  assert.equal(primaryFileRel(to), 'rp-artifacts/tool-output/Run_Log-tttt0001.md')
})

// ── agent.md singleton: NOT title-renamed (regression) ──────────────────────

test('primaryFileRel: the pinned agent.md keeps its fixed `agent-md.md` name', () => {
  const agentMd = mkNote(AGENT_MD_ID, 'agent.md')
  assert.equal(primaryFileRel(agentMd), 'rp-artifacts/notes/agent-md.md')
  // legacyRel === newRel → the convergence migration leaves it untouched.
  assert.equal(legacyMdFileRel(agentMd), primaryFileRel(agentMd))
})

test('ensureAgentMd: idempotent — no title-slugged duplicate, user content preserved', () => {
  const dir = soloProject()
  try {
    ensureAgentMd(dir)
    const abs = join(dir, 'rp-artifacts', 'notes', 'agent-md.md')
    assert.ok(existsSync(abs), 'agent.md created at its canonical name')
    writeFileSync(abs, readFileSync(abs, 'utf-8') + '\nUSER INSTRUCTION\n', 'utf-8')

    ensureAgentMd(dir)        // simulates the next project open
    convergeManagedMdFilenames(dir)  // and the filename migration

    const mdFiles = readdirSync(join(dir, 'rp-artifacts', 'notes')).filter(f => f.endsWith('.md'))
    assert.deepEqual(mdFiles, ['agent-md.md'], 'exactly one agent.md file, no slugged duplicate')
    assert.match(readFileSync(abs, 'utf-8'), /USER INSTRUCTION/, 'user content not clobbered')
  } finally {
    cleanup(dir)
  }
})

// ── rename-on-title-edit ─────────────────────────────────────────────────────

test('updateArtifact: editing a note title renames the file (no orphan, still one note)', () => {
  const dir = soloProject()
  try {
    const rec = createArtifact({ type: 'note', title: 'First Title', content: 'body' }, ctx(dir))
    rebuildIndex(dir)
    const oldRel = primaryFileRel(rec.artifact)
    assert.ok(existsSync(join(dir, oldRel)), 'created at the first-title path')

    const upd = updateArtifact(dir, rec.artifact.id, { title: 'Second Title' } as Record<string, unknown>)
    assert.ok(upd, 'update found the note')
    const newRel = primaryFileRel(upd!.artifact)
    assert.notEqual(oldRel, newRel, 'path tracks the new title')
    assert.ok(existsSync(join(dir, newRel)), 'new-title file written')
    assert.ok(!existsSync(join(dir, oldRel)), 'old-title file removed (no orphan)')
    assert.equal(rebuildIndex(dir).filter(a => a.type === 'note').length, 1, 'exactly one note remains')
  } finally {
    cleanup(dir)
  }
})

// ── migration: legacy <id>.md → title-named ──────────────────────────────────

test('convergeManagedMdFilenames: renames legacy <id>.md, content intact, indexable, idempotent', () => {
  const dir = soloProject()
  try {
    const note = mkNote('aaaa1111', 'My Plan')
    const legacyRel = legacyMdFileRel(note)!
    assert.equal(legacyRel, 'rp-artifacts/notes/aaaa1111.md')
    mkdirSync(join(dir, dirname(legacyRel)), { recursive: true })
    writeFileSync(join(dir, legacyRel), markdownArtifactToText(note), 'utf-8')

    const renamed = convergeManagedMdFilenames(dir)
    assert.equal(renamed, 1, 'one file renamed')
    const newRel = primaryFileRel(note)
    assert.equal(newRel, 'rp-artifacts/notes/My_Plan-aaaa1111.md')
    assert.ok(existsSync(join(dir, newRel)), 'title-named file present')
    assert.ok(!existsSync(join(dir, legacyRel)), 'legacy id-named file gone')
    assert.match(readFileSync(join(dir, newRel), 'utf-8'), /body of aaaa1111/, 'content preserved')
    assert.ok(scanWorkspaceArtifacts(dir).some(a => a.id === 'aaaa1111'), 'still found by id')
    assert.ok(isNoteFilenamesConverged(dir), 'marker set')
    assert.equal(convergeManagedMdFilenames(dir), 0, 'marker gates the re-run (idempotent)')
  } finally {
    cleanup(dir)
  }
})

test('convergeManagedMdFilenames: shared project renames within the per-actor subdir', () => {
  const dir = soloProject()
  try {
    const note = mkNote('cccc9999', 'Shared Note', { id: 'act9', displayName: 'Alice Chen', slug: 'alice-chen' })
    const legacyRel = legacyMdFileRel(note)!
    assert.equal(legacyRel, 'rp-artifacts/notes/alice-chen/cccc9999.md')
    mkdirSync(join(dir, dirname(legacyRel)), { recursive: true })
    writeFileSync(join(dir, legacyRel), markdownArtifactToText(note), 'utf-8')

    convergeManagedMdFilenames(dir)
    const newRel = primaryFileRel(note)
    assert.ok(newRel.startsWith('rp-artifacts/notes/alice-chen/'), 'stays under the per-actor subdir')
    assert.ok(existsSync(join(dir, newRel)) && !existsSync(join(dir, legacyRel)), 'renamed in place')
  } finally {
    cleanup(dir)
  }
})
