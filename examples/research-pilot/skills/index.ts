/**
 * Research Pilot Skills
 *
 * App-specific skills loaded from build-time inlined SKILL.md content.
 * No runtime filesystem reads — works in both unbundled ESM and bundled
 * (electron-vite) contexts without path resolution hacks.
 *
 * Source of truth: SKILL.md files in sibling directories.
 * To regenerate after editing SKILL.md:
 *   node examples/research-pilot/skills/generate-skill-content.mjs
 *
 * Token Savings Summary:
 * | Skill | Before | After (summary) | After (full) | Initial Savings |
 * |-------|--------|-----------------|--------------|-----------------|
 * | academic-writing | ~750 | ~80 | ~600 | 89% |
 * | literature | ~3,225 | ~100 | ~1,500 | 97% |
 * | data-analysis | ~2,825 | ~100 | ~1,400 | 96% |
 * | **Total** | ~6,800 | ~280 | ~3,500 | **96%** |
 */

import { parseExternalSkill } from '../../../src/skills/skill-file.js'
import type { Skill } from '../../../src/types/skill.js'
import { skillContent } from './_generated.js'

function parseSkill(dirName: string): Skill {
  const content = skillContent[dirName]
  if (!content) throw new Error(`No generated content for skill "${dirName}". Run: node examples/research-pilot/skills/generate-skill-content.mjs`)
  const { skill } = parseExternalSkill(content, { defaultId: dirName })
  return skill
}

export const academicWritingSkill: Skill = parseSkill('academic-writing')
export const literatureSkill: Skill = parseSkill('literature')
export const dataAnalysisSkill: Skill = parseSkill('data-analysis')

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
