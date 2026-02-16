/**
 * YOLO Researcher Skills
 *
 * Local, app-owned procedural skills loaded by the yolo-researcher coordinator.
 */

export { academicWritingSkill } from './academic-writing-skill.js'
export { literatureSkill } from './literature-skill.js'
export { dataAnalysisSkill } from './data-analysis-skill.js'
export { experimentRequestSkill } from './experiment-request-skill.js'

// Re-export all skills as a collection
import { academicWritingSkill } from './academic-writing-skill.js'
import { literatureSkill } from './literature-skill.js'
import { dataAnalysisSkill } from './data-analysis-skill.js'
import { experimentRequestSkill } from './experiment-request-skill.js'

export const yoloResearcherSkills = [
  academicWritingSkill,
  literatureSkill,
  dataAnalysisSkill,
  experimentRequestSkill
]

/**
 * Skill lookup by ID
 */
export const skillsById = {
  'academic-writing-skill': academicWritingSkill,
  'literature-skill': literatureSkill,
  'data-analysis-skill': dataAnalysisSkill,
  'experiment-request-skill': experimentRequestSkill
} as const

/**
 * Get skill by ID
 */
export function getSkill(id: string) {
  return skillsById[id as keyof typeof skillsById]
}
