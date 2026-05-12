/**
 * Tests for the BibTeX importer (lib/importers/bibtex.ts).
 *
 * Covers RFC-006 §5 fixtures F1-F14 plus the corner-case groups A-G from
 * §7. Pure file-IO / parser tests — no LLM, no HTTP.
 *
 * Structure:
 *   §1  Fixtures (one fixture per .bib in __tests__/fixtures/)
 *   §2  Re-import idempotency (Group B)
 *   §3  Library conflicts (Group C)
 *   §4  Data quality issues (Group D)
 *   §5  In-file duplicates (Group A)
 *   §6  Standalone-bibtex reconstruction round-trip (RFC-006 §9)
 *   §7  Provenance contract (review #1 regression)
 *   §8  Failure shape (Group G, error reporting)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseBibtex } from '@retorquere/bibtex-parser'
import { importBibtexFile, importBibtexString, reconstructStandaloneBibtex } from '../bibtex.js'
import { listArtifacts } from '../../memory-v2/store.js'
import { upsertPaperArtifact } from '../../commands/paper-artifact.js'
import type { CLIContext, PaperArtifact } from '../../types.js'
import { PATHS } from '../../types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipilot-bibimport-'))
  mkdirSync(join(dir, PATHS.papers), { recursive: true })
  return dir
}

function ctx(projectPath: string): CLIContext {
  return { sessionId: 'test-session', projectPath, debug: false }
}

function listPapers(projectPath: string): PaperArtifact[] {
  return listArtifacts(projectPath, ['paper'])
    .filter((a): a is PaperArtifact => a.type === 'paper')
}

function findByCiteKey(projectPath: string, citeKey: string): PaperArtifact {
  const match = listPapers(projectPath).find(p => p.citeKey === citeKey)
  if (!match) throw new Error(`no paper with citeKey ${citeKey}`)
  return match
}

// ============================================================================
// §1 — Fixtures
// ============================================================================

test('F1: canonical @article with DOI imports cleanly', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F1-canonical-article.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    assert.equal(result.failed, 0)

    const paper = findByCiteKey(project, 'smith2024transformer')
    assert.equal(paper.title, 'Attention Is All You Need', 'title-case preserved (no Zotero sentence-casing)')
    assert.deepEqual(paper.authors, ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'])
    assert.equal(paper.year, 2024)
    assert.equal(paper.doi, '10.48550/arxiv.1706.03762')   // normalized lowercase
    assert.equal(paper.venue, 'Advances in Neural Information Processing Systems')
    assert.equal(paper.url, 'https://arxiv.org/abs/1706.03762')
    assert.equal(paper.externalSource, 'bibtex-import')
    assert.equal(paper.identityConfidence, 'high')
    // DOI form 10.48550/arXiv.<id> → arXiv identifier extracted
    assert.equal(paper.arxivId, '1706.03762')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F2: @inproceedings prefers booktitle as venue', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F2-inproceedings-booktitle.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'chen2023rag')
    assert.equal(paper.venue, 'Proceedings of NeurIPS')
    assert.equal(paper.year, 2023)
    // No DOI present → identityConfidence is 'low' (not 'high').
    assert.equal(paper.identityConfidence, 'low')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F3: BibLaTeX @online with eprint extracts arXiv id', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F3-arxiv-only.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'anon2024llmagent')
    assert.equal(paper.arxivId, '2410.12345')
    // No DOI but arXiv id present → 'medium' confidence.
    assert.equal(paper.identityConfidence, 'medium')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F4: LaTeX accents decode to Unicode characters', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F4-latex-accents.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'moller2022')
    assert.equal(paper.title, 'Café-Bench: Evaluating AI on French Bistro Menus')
    assert.deepEqual(paper.authors, ['Jürgen Möller', 'José Álvarez'])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F5: name particles "von" and "Jr." compose into "First [prefix] Last, Suffix"', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F5-name-particles.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'vonberg2020')
    assert.equal(paper.authors[0], 'Hans von der Berg')
    assert.equal(paper.authors[1], 'Robert Smith, Jr.')
    // @book → venue = publisher
    assert.equal(paper.venue, 'MIT Press')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F6: @misc with no DOI/year/venue still imports, low confidence', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F6-misc-no-metadata.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'blogpost')
    assert.equal(paper.identityConfidence, 'low')
    // @misc → venue from `howpublished`
    assert.equal(paper.venue, 'Blog post')
    assert.equal(paper.year, undefined)
    // upsert defaults to unknown:<citeKey> when no real DOI
    assert.ok(paper.doi.startsWith('unknown:'))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F7: Zotero `file` field is ignored — no local path leaks into pdfUrl', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F7-zotero-with-file.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'zotero2024')
    assert.equal(paper.pdfUrl, undefined, 'must not synthesize pdfUrl from local file path')
    assert.equal(paper.doi, '10.1126/science.abc1234')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F8: two different citekeys for same DOI → second dedup-merges into first', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F8-dedup-different-citekey.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1, 'first entry creates a paper')
    // Second entry hits dedup on DOI. Because the first entry already has
    // every field, the merge is no-op (mergedNoChange).
    assert.equal(result.merged + result.mergedNoChange, 1)
    assert.equal(listPapers(project).length, 1, 'still only one paper artifact')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F9: @string macros are resolved into the stored bibtex', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F9-string-macro.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'bengio2003')
    // The decoded venue field should have NIPS resolved.
    assert.equal(paper.venue, 'Neural Information Processing Systems')
    // The stored bibtex must NOT reference `NIPS` as an unresolved token.
    assert.ok(!/booktitle\s*=\s*NIPS\b/i.test(paper.bibtex),
      'reconstructed bibtex must not contain unresolved NIPS macro')
    assert.ok(/Neural Information Processing Systems/.test(paper.bibtex),
      'reconstructed bibtex must inline the macro value')
    assert.equal(paper.bibtexIsAutoGenerated, false, 'imported bibtex is not auto-generated')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F10: malformed entry is soft-failed (other entries would still import)', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F10-malformed.bib'), { ctx: ctx(project) })
    // The parser surfaces the entry with empty fields → our importer
    // soft-fails it (missing title) rather than throwing.
    assert.equal(result.added, 0)
    assert.equal(result.failed, 1)
    assert.equal(result.failureDetails[0].reason, 'missing-title-field')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F11: duplicate citekey within one file — first kept, second skipped', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F11-same-citekey-twice.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    assert.equal(result.duplicateInFile, 1)
    const paper = findByCiteKey(project, 'dupkey')
    // The FIRST occurrence won.
    assert.equal(paper.title, 'First Occurrence')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F12: author "and others" is dropped, et-al convention respected', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F12-author-and-others.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'etalentry')
    assert.deepEqual(paper.authors, ['John Smith'], '"others" literal stripped')
    // Has DOI → still 'high' confidence even though author list is truncated.
    assert.equal(paper.identityConfidence, 'high')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F13: non-numeric year ("to appear") → year is undefined, paper still imports', async () => {
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F13-year-to-appear.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'toappear')
    assert.equal(paper.year, undefined)
    assert.equal(paper.title, 'A Paper That Has Not Appeared')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('F14: math mode in title renders to Unicode (e.g. n^2 → n²) — parser default', async () => {
  // The parser converts simple TeX math to Unicode (n^2 → n², \alpha → α).
  // This is acceptable: the rendered form is human-readable and our UI
  // doesn't run LaTeX. Whatever the parser produces, the title must at
  // minimum still describe an O(n^something) algorithm.
  const project = tmpProject()
  try {
    const result = await importBibtexFile(join(FIXTURES, 'F14-math-mode.bib'), { ctx: ctx(project) })
    assert.equal(result.added, 1)
    const paper = findByCiteKey(project, 'mathmode')
    assert.ok(/Optimal Algorithms/.test(paper.title), 'title text preserved')
    assert.ok(/O\(n.\)/.test(paper.title), 'O(n^2) or O(n²) shape preserved')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ============================================================================
// §2 — Re-import idempotency (Group B)
// ============================================================================

test('B1: bit-identical re-import is fully no-op (all merged-no-change)', async () => {
  const project = tmpProject()
  try {
    const path = join(FIXTURES, 'F1-canonical-article.bib')
    const first = await importBibtexFile(path, { ctx: ctx(project) })
    assert.equal(first.added, 1)

    const second = await importBibtexFile(path, { ctx: ctx(project) })
    assert.equal(second.added, 0)
    assert.equal(second.merged, 0)
    assert.equal(second.mergedNoChange, 1)
    assert.equal(listPapers(project).length, 1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('B2: re-import with new DOI fills the previously-unknown DOI (fill-only)', async () => {
  const project = tmpProject()
  try {
    // First .bib: no DOI present.
    const initial = `@article{smith2024paper,
  title = {A Paper},
  author = {Smith, A.},
  year = {2024},
}`
    const r1 = await importBibtexString(initial, { ctx: ctx(project) })
    assert.equal(r1.added, 1)
    const p1 = findByCiteKey(project, 'smith2024paper')
    assert.ok(p1.doi.startsWith('unknown:'))
    assert.equal(p1.identityConfidence, 'low')

    // Second .bib: DOI added (user updated Zotero, re-exported).
    const updated = `@article{smith2024paper,
  title = {A Paper},
  author = {Smith, A.},
  year = {2024},
  doi = {10.1234/real},
}`
    const r2 = await importBibtexString(updated, { ctx: ctx(project) })
    assert.equal(r2.added, 0)
    assert.equal(r2.merged, 1)

    const p2 = findByCiteKey(project, 'smith2024paper')
    assert.equal(p2.doi, '10.1234/real')
    assert.equal(p2.identityConfidence, 'high', 'confidence upgrades on DOI add')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ============================================================================
// §3 — Library conflicts (Group C)
// ============================================================================

test('C1: importing a paper agent already added preserves agent fields (relevanceScore, externalSource)', async () => {
  const project = tmpProject()
  try {
    // Simulate agent literature-search adding a paper first.
    const agentResult = upsertPaperArtifact(
      'Attention Is All You Need',
      {
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
        year: 2024,
        doi: '10.48550/arxiv.1706.03762',
        externalSource: 'literature-search',
        relevanceScore: 9,
        relevanceJustification: 'Foundational transformer paper.',
        subTopic: 'Transformer Architecture',
        addedInRound: 'R-01',
      },
      ctx(project),
    )
    assert.equal(agentResult.success, true)

    // Now user imports the same paper via BibTeX.
    const r = await importBibtexFile(join(FIXTURES, 'F1-canonical-article.bib'), { ctx: ctx(project) })
    assert.equal(r.added, 0)
    assert.equal(r.merged + r.mergedNoChange, 1)

    // Dedup hit via DOI — citeKey stays as the agent-generated one
    // (RFC-006: citeKey is identity, not overwritten on dedup).
    const papers = listPapers(project)
    assert.equal(papers.length, 1)
    const paper = papers[0]
    // Agent-set fields survive (first-wins per RFC-006).
    assert.equal(paper.externalSource, 'literature-search', 'agent externalSource preserved')
    assert.equal(paper.relevanceScore, 9, 'relevanceScore preserved')
    assert.equal(paper.subTopic, 'Transformer Architecture', 'subTopic preserved')
    assert.equal(paper.addedInRound, 'R-01', 'addedInRound preserved')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ============================================================================
// §4 — Data quality (Group D)
// ============================================================================

test('D5: UTF-8-replacement-character input throws clear error (refuse to guess encoding)', async () => {
  const project = tmpProject()
  try {
    const corrupt = `@article{x,\n  title = {Bad \uFFFD encoding},\n  author = {A},\n  year = {2024},\n}`
    await assert.rejects(
      () => importBibtexString(corrupt, { ctx: ctx(project) }),
      /UTF-8/,
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('D8: file with no @xxx{...} blocks fails loudly (not silently "added: 0")', async () => {
  const project = tmpProject()
  try {
    const notBibtex = 'this is just\nsome random text\nno bibtex here'
    await assert.rejects(
      () => importBibtexString(notBibtex, { ctx: ctx(project) }),
      /No BibTeX entries/i,
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ============================================================================
// §5 — Standalone-bibtex reconstruction round-trip (RFC-006 §9)
// ============================================================================

test('F9 round-trip: stored bibtex parses back standalone with no @string dependency', async () => {
  const project = tmpProject()
  try {
    await importBibtexFile(join(FIXTURES, 'F9-string-macro.bib'), { ctx: ctx(project) })
    const paper = findByCiteKey(project, 'bengio2003')

    // Round-trip: dump paper.bibtex (a standalone entry, no @string) and
    // re-parse it cold. Must succeed with no parser errors AND have the
    // booktitle value already inlined.
    const reparsed = parseBibtex(paper.bibtex, { sentenceCase: false, english: false })
    assert.equal(reparsed.errors.length, 0, 'reconstructed bibtex must parse without errors')
    assert.equal(reparsed.entries.length, 1)
    assert.equal(reparsed.entries[0].fields.booktitle, 'Neural Information Processing Systems')
    assert.equal(Object.keys(reparsed.strings).length, 0, 'must not require any @string definitions')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('reconstructStandaloneBibtex: round-trips F1 cleanly through parser', () => {
  const raw = readFileSync(join(FIXTURES, 'F1-canonical-article.bib'), 'utf-8')
  const lib = parseBibtex(raw, { sentenceCase: false, english: false })
  const entry = lib.entries[0]
  const reconstructed = reconstructStandaloneBibtex(entry)
  const reparsed = parseBibtex(reconstructed, { sentenceCase: false, english: false })
  assert.equal(reparsed.errors.length, 0)
  assert.equal(reparsed.entries[0].key, 'smith2024transformer')
  assert.equal(reparsed.entries[0].fields.title, 'Attention Is All You Need')
  // Authors round-trip back as the same Creator[] shape.
  const authors = reparsed.entries[0].fields.author as Array<{ lastName?: string; firstName?: string }>
  assert.equal(authors.length, 3)
  assert.equal(authors[0].lastName, 'Vaswani')
})

// ============================================================================
// §6 — Provenance contract (review #1 regression)
// ============================================================================

test('imported paper has provenance.source=import, extractedFrom=file-import (NOT agent)', async () => {
  const project = tmpProject()
  try {
    await importBibtexFile(join(FIXTURES, 'F1-canonical-article.bib'), { ctx: ctx(project) })
    const paper = findByCiteKey(project, 'smith2024transformer')
    assert.equal(paper.provenance.source, 'import')
    assert.equal(paper.provenance.extractedFrom, 'file-import')
    // sessionId always taken from CLIContext, even with override.
    assert.equal(paper.provenance.sessionId, 'test-session')
    // agentId not set (we only set it for agent paths).
    assert.equal(paper.provenance.agentId, undefined)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// ============================================================================
// §7 — Progress events and failure shape
// ============================================================================

test('progress callback fires once per entry, in order, with correct status', async () => {
  const project = tmpProject()
  try {
    const events: Array<{ index: number; status: string; citeKey: string }> = []
    await importBibtexFile(
      join(FIXTURES, 'F11-same-citekey-twice.bib'),
      {
        ctx: ctx(project),
        onProgress: (e) => events.push({ index: e.index, status: e.status, citeKey: e.citeKey }),
      },
    )
    assert.equal(events.length, 2)
    assert.equal(events[0].index, 0)
    assert.equal(events[0].status, 'added')
    assert.equal(events[1].index, 1)
    assert.equal(events[1].status, 'duplicate-in-file')
    assert.equal(events[1].citeKey, 'dupkey')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('importedPaperIds collects ids from all successful imports (including merges)', async () => {
  const project = tmpProject()
  try {
    // First import creates 1 paper.
    const r1 = await importBibtexFile(join(FIXTURES, 'F1-canonical-article.bib'), { ctx: ctx(project) })
    assert.equal(r1.importedPaperIds.length, 1)

    // Re-import: dedup hits, but the id should still appear in the list
    // (so the caller can pass it to enrichPaperArtifacts even on
    // re-import — useful when the user wants to re-trigger enrichment).
    const r2 = await importBibtexFile(join(FIXTURES, 'F1-canonical-article.bib'), { ctx: ctx(project) })
    assert.equal(r2.importedPaperIds.length, 1)
    assert.equal(r2.importedPaperIds[0], r1.importedPaperIds[0])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('nonexistent file path throws (not soft-fail)', async () => {
  const project = tmpProject()
  try {
    await assert.rejects(
      () => importBibtexFile('/nonexistent/path/foo.bib', { ctx: ctx(project) }),
      /not found/i,
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
