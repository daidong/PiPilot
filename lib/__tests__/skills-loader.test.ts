import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSkillSummary, loadBuiltinSkills } from '../skills/loader.js'

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
