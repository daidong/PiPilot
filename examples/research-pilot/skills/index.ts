/**
 * Research Pilot Skills
 *
 * App-specific skills for the research-pilot example.
 * These skills provide procedural knowledge that can be lazily loaded
 * to optimize token usage.
 *
 * Token Savings Summary:
 * | Skill | Before | After (summary) | After (full) | Initial Savings |
 * |-------|--------|-----------------|--------------|-----------------|
 * | academic-writing | ~750 | ~80 | ~600 | 89% |
 * | literature | ~3,225 | ~100 | ~1,500 | 97% |
 * | data-analysis | ~2,825 | ~100 | ~1,400 | 96% |
 * | **Total** | ~6,800 | ~280 | ~3,500 | **96%** |
 */

export { academicWritingSkill } from './academic-writing-skill.js'
export { literatureSkill } from './literature-skill.js'
export { dataAnalysisSkill } from './data-analysis-skill.js'

// Re-export all skills as a collection
import { academicWritingSkill } from './academic-writing-skill.js'
import { literatureSkill } from './literature-skill.js'
import { dataAnalysisSkill } from './data-analysis-skill.js'

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
