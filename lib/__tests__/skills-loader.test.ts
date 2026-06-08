import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSkillSummary, loadBuiltinSkills, setBuiltinSkillsRoot } from '../skills/loader.js'

test('builtin skills consolidate research strategy and keep slides self-contained', () => {
  const skills = loadBuiltinSkills()
  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  assert.ok(byName.has('research-strategy'))
  assert.ok(!byName.has('brainstorming-research-ideas'))
  assert.ok(!byName.has('creative-thinking-for-research'))
  assert.ok(!byName.has('story-first-research-communication'))

  const academicSlides = byName.get('academic-marp-slides')
  assert.ok(academicSlides)
  assert.ok(!academicSlides.depends.includes('story-first-research-communication'))

  const researchStrategy = byName.get('research-strategy')
  assert.ok(researchStrategy)
  const summary = buildSkillSummary(researchStrategy)
  assert.match(summary, /Audit the premise before expanding the idea/)
  assert.match(summary, /Strongest objection/)
  assert.match(summary, /Default to a short first answer/)
  assert.match(summary, /needing verification/)
  assert.match(summary, /Do not rescue weak ideas/)
  assert.match(summary, /Fatal flaw/)
  assert.match(summary, /Reopen condition/)
})

test('frontmatter parsing tolerates CRLF line endings (Windows checkout)', () => {
  // GitHub windows-latest checks out text files with CRLF (core.autocrlf=true).
  // A \n-only frontmatter regex would silently drop every skill there.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-crlf-'))
  try {
    const md = [
      '---',
      'name: crlf-probe',
      'description: A skill saved with CRLF endings.',
      'depends: []',
      '---',
      '',
      '# Overview',
      '',
      'Body text after CRLF frontmatter.',
    ].join('\r\n')
    fs.mkdirSync(path.join(root, 'crlf-probe'), { recursive: true })
    fs.writeFileSync(path.join(root, 'crlf-probe', 'SKILL.md'), md)

    setBuiltinSkillsRoot(root)
    const skills = loadBuiltinSkills()
    const probe = skills.find((s) => s.name === 'crlf-probe')
    assert.ok(probe, 'CRLF skill should still load')
    assert.equal(probe.description, 'A skill saved with CRLF endings.')
    // Frontmatter must be stripped from the summary, not leak into it.
    const summary = buildSkillSummary(probe)
    assert.doesNotMatch(summary, /name: crlf-probe/)
    assert.match(summary, /Body text after CRLF frontmatter\./)
  } finally {
    setBuiltinSkillsRoot(null as unknown as string)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
