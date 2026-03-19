/**
 * Research Pilot Skills
 *
 * App-specific skills for the research-pilot example.
 * Skills are loaded from SKILL.md files (portable Markdown format)
 * using the framework's parseExternalSkill() function.
 *
 * Token Savings Summary:
 * | Skill | Before | After (summary) | After (full) | Initial Savings |
 * |-------|--------|-----------------|--------------|-----------------|
 * | academic-writing | ~750 | ~80 | ~600 | 89% |
 * | literature | ~3,225 | ~100 | ~1,500 | 97% |
 * | data-analysis | ~2,825 | ~100 | ~1,400 | 96% |
 * | **Total** | ~6,800 | ~280 | ~3,500 | **96%** |
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExternalSkill } from '../../../src/skills/skill-file.js'
import type { Skill } from '../../../src/types/skill.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadSkillMd(subdir: string): Skill {
  const mdPath = join(__dirname, subdir, 'SKILL.md')
  const content = readFileSync(mdPath, 'utf-8')
  const { skill } = parseExternalSkill(content, { defaultId: subdir })
  return skill
}

export const academicWritingSkill: Skill = loadSkillMd('academic-writing')
export const literatureSkill: Skill = loadSkillMd('literature')
export const dataAnalysisSkill: Skill = loadSkillMd('data-analysis')

/**
 * All research-pilot skills
 */
export const researchPilotSkills = [
  academicWritingSkill,
  literatureSkill,
  dataAnalysisSkill
]

/**
 * Skill lookup by ID
 */
export const skillsById = {
  'academic-writing-skill': academicWritingSkill,
  'literature-skill': literatureSkill,
  'data-analysis-skill': dataAnalysisSkill
} as const

/**
 * Get skill by ID
 */
export function getSkill(id: string) {
  return skillsById[id as keyof typeof skillsById]
}
