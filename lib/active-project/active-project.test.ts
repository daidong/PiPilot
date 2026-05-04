/**
 * Active-project / canonical-paper resolver tests.
 *
 * Run with: npx tsx lib/active-project/active-project.test.ts
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stripLatexComments } from './comments.js'
import { isLatexRoot, walkDeps, toWorkspaceRel, looksArchived } from './latex-deps.js'
import { getCanonicalPaper, isCanonicalPath } from './index.js'

const successes: string[] = []
async function runCase(name: string, fn: () => Promise<void> | void): Promise<void> {
  const start = Date.now()
  try {
    await fn()
    successes.push(`✓ ${name} (${Date.now() - start}ms)`)
  } catch (err) {
    console.error(`✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'active-project-test-'))
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  const dir = abs.substring(0, abs.lastIndexOf('/'))
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(abs, content, 'utf-8')
}

// ---------------------------------------------------------------------------
// comments.ts
// ---------------------------------------------------------------------------

await runCase('stripLatexComments — line comment', () => {
  const out = stripLatexComments('hello % this is a comment\nworld')
  assert.equal(out, 'hello \nworld')
})

await runCase('stripLatexComments — escaped percent stays literal', () => {
  const out = stripLatexComments('100\\% increase')
  assert.equal(out, '100\\% increase')
})

await runCase('stripLatexComments — odd backslashes (\\\\%) is a comment marker', () => {
  // `\\` is a backslash literal; the next `%` IS a comment marker.
  const out = stripLatexComments('a\\\\% comment\nb')
  assert.equal(out, 'a\\\\\nb')
})

await runCase('stripLatexComments — block comment', () => {
  const src = 'before\\begin{comment}\n  \\input{old}\n  hidden text\n\\end{comment}after'
  const out = stripLatexComments(src)
  assert.equal(out.includes('\\input{old}'), false)
  assert.equal(out.includes('hidden text'), false)
  assert.equal(out.includes('before'), true)
  assert.equal(out.includes('after'), true)
})

// ---------------------------------------------------------------------------
// latex-deps.ts — root detection
// ---------------------------------------------------------------------------

await runCase('isLatexRoot — happy path', () => {
  const c = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}'
  assert.equal(isLatexRoot(c), true)
})

await runCase('isLatexRoot — missing begin{document}', () => {
  const c = '\\documentclass{article}\nHi'
  assert.equal(isLatexRoot(c), false)
})

await runCase('isLatexRoot — subfile is not a root', () => {
  const c = '\\documentclass[../main.tex]{subfiles}\n\\begin{document}\nHi\n\\end{document}'
  assert.equal(isLatexRoot(c), false)
})

await runCase('isLatexRoot — commented-out documentclass not a root', () => {
  const c = '% \\documentclass{article}\n% \\begin{document}\nNothing here'
  assert.equal(isLatexRoot(c), false)
})

await runCase('looksArchived — common patterns', () => {
  assert.equal(looksArchived('_old/main.tex'), true)
  assert.equal(looksArchived('paper-7/_scratch/v3.tex'), true)
  assert.equal(looksArchived('backup/main.tex'), true)
  assert.equal(looksArchived('paper-7/main.tex'), false)
  assert.equal(looksArchived('figures/old_figure.png'), false) // file name 'old_*' is not archived dir
})

// ---------------------------------------------------------------------------
// latex-deps.ts — walkDeps
// ---------------------------------------------------------------------------

await runCase('walkDeps — single-file paper, no deps', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.texFiles], ['main.tex'])
    assert.equal(out.bibFiles.size, 0)
    assert.equal(out.images.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — recursive \\input', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\input{sections/method}\n\\end{document}')
    write(root, 'intro.tex', 'Intro \\input{shared/notation}')
    write(root, 'sections/method.tex', 'Method')
    write(root, 'shared/notation.tex', 'Notation')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.texFiles].sort(), [
      'intro.tex', 'main.tex', 'sections/method.tex', 'shared/notation.tex'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — \\bibliography and \\addbibresource', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n\\bibliography{refs1,refs2}\n\\addbibresource{biblatex.bib}\n\\end{document}')
    write(root, 'refs1.bib', '@article{a, ...}')
    write(root, 'refs2.bib', '@article{b, ...}')
    write(root, 'biblatex.bib', '@article{c, ...}')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.bibFiles].sort(), ['biblatex.bib', 'refs1.bib', 'refs2.bib'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — \\includegraphics with extension probing', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n' +
      '\\includegraphics{fig1}\n' +
      '\\includegraphics[width=0.5\\textwidth]{figures/fig2}\n' +
      '\\includegraphics{absolute_with_ext.png}\n' +
      '\\end{document}')
    write(root, 'fig1.pdf', '%PDF-1.4 fake')
    write(root, 'figures/fig2.png', 'fake png')
    write(root, 'absolute_with_ext.png', 'fake png')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.images].sort(), [
      'absolute_with_ext.png', 'fig1.pdf', 'figures/fig2.png'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — \\graphicspath search dirs', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n' +
      '\\graphicspath{{img/}{figures/}}\n' +
      '\\begin{document}\n\\includegraphics{chart}\n\\end{document}')
    write(root, 'figures/chart.pdf', 'fake pdf')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.images], ['figures/chart.pdf'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — commented \\includegraphics is NOT picked up', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n' +
      '% \\includegraphics{old_fig}\n' +
      '\\includegraphics{live_fig}\n' +
      '\\end{document}')
    write(root, 'old_fig.png', 'old')
    write(root, 'live_fig.png', 'live')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.images], ['live_fig.png'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — refusing to escape projectPath via ../', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n\\input{../outside_file}\n\\end{document}')
    // No outside_file.tex exists; even if it did we wouldn't follow it.
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.texFiles], ['main.tex'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('walkDeps — \\lstinputlisting and \\verbatiminput', () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n\\begin{document}\n' +
      '\\lstinputlisting[language=Python]{code/snippet.py}\n' +
      '\\verbatiminput{logs/run.log}\n' +
      '\\end{document}')
    write(root, 'code/snippet.py', 'print("hi")')
    write(root, 'logs/run.log', 'log line')
    const out = walkDeps(root, 'main.tex')
    assert.deepEqual([...out.otherAssets].sort(), ['code/snippet.py', 'logs/run.log'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// index.ts — getCanonicalPaper end-to-end
// ---------------------------------------------------------------------------

await runCase('getCanonicalPaper — non-LaTeX project returns null', async () => {
  const root = makeProject()
  try {
    write(root, 'README.md', '# project\n')
    write(root, 'data/x.csv', 'a,b\n1,2\n')
    const result = await getCanonicalPaper(root)
    assert.equal(result, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('getCanonicalPaper — typical paper with mixed deps', async () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\n' +
      '\\graphicspath{{figures/}}\n' +
      '\\begin{document}\n' +
      '\\input{intro}\n' +
      '\\includegraphics{fig1}\n' +
      '\\bibliography{refs}\n' +
      '\\end{document}')
    write(root, 'intro.tex', 'Intro')
    write(root, 'figures/fig1.pdf', 'pdf')
    write(root, 'refs.bib', '@article{a, ...}')
    // Add a scratch file that should NOT be in canonical:
    write(root, '_old/draft_v2.tex',
      '\\documentclass{article}\\begin{document}old\\end{document}')
    write(root, 'figures/unused_fig.png', 'unused')

    const result = await getCanonicalPaper(root)
    assert.notEqual(result, null)
    assert.equal(result!.rootPath, 'main.tex')
    assert.deepEqual([...result!.texFiles].sort(), ['intro.tex', 'main.tex'])
    assert.deepEqual([...result!.bibFiles], ['refs.bib'])
    assert.deepEqual([...result!.images], ['figures/fig1.pdf'])
    assert.equal(result!.allFiles.size, 4) // main, intro, refs, fig1

    // The scratch tex and unused fig must NOT appear in canonical.
    assert.equal(result!.allFiles.has('_old/draft_v2.tex'), false)
    assert.equal(result!.allFiles.has('figures/unused_fig.png'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('getCanonicalPaper — multiple roots, prefers non-archived', async () => {
  const root = makeProject()
  try {
    write(root, 'paper.tex',
      '\\documentclass{article}\\begin{document}live\\end{document}')
    write(root, '_old/main.tex',
      '\\documentclass{article}\\begin{document}archived\\end{document}')
    const result = await getCanonicalPaper(root)
    assert.equal(result?.rootPath, 'paper.tex')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('getCanonicalPaper — multiple roots, hintPath wins', async () => {
  const root = makeProject()
  try {
    write(root, 'paper-a.tex',
      '\\documentclass{article}\\begin{document}A\\end{document}')
    write(root, 'paper-b.tex',
      '\\documentclass{article}\\begin{document}B\\end{document}')
    const result = await getCanonicalPaper(root, { hintPath: 'paper-b.tex' })
    assert.equal(result?.rootPath, 'paper-b.tex')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('getCanonicalPaper — root filename other than main.tex', async () => {
  const root = makeProject()
  try {
    write(root, 'arxiv_submission_v3_FINAL.tex',
      '\\documentclass{article}\\begin{document}hi\\end{document}')
    const result = await getCanonicalPaper(root)
    assert.equal(result?.rootPath, 'arxiv_submission_v3_FINAL.tex')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('isCanonicalPath — absolute path normalization', async () => {
  const root = makeProject()
  try {
    write(root, 'main.tex',
      '\\documentclass{article}\\begin{document}\\input{intro}\\end{document}')
    write(root, 'intro.tex', 'Intro')
    const result = await getCanonicalPaper(root)
    assert.notEqual(result, null)
    assert.equal(isCanonicalPath(result!, root, 'intro.tex'), true)
    assert.equal(isCanonicalPath(result!, root, join(root, 'intro.tex')), true)
    assert.equal(isCanonicalPath(result!, root, 'other.tex'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await runCase('toWorkspaceRel — basic forms', () => {
  assert.equal(toWorkspaceRel('/proj', '/proj/a/b.tex'), 'a/b.tex')
  assert.equal(toWorkspaceRel('/proj', 'a/b.tex'), 'a/b.tex')
  assert.equal(toWorkspaceRel('/proj', './a/b.tex'), 'a/b.tex')
})

console.log(successes.join('\n'))
console.log(`\nAll ${successes.length} cases passed.`)
