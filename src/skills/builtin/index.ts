/**
 * Built-in Skills
 *
 * Pre-defined skills for common agent capabilities.
 * These replace promptFragment content in packs for lazy loading.
 */

export { llmComputeSkill } from './llm-compute-skill.js'
export { gitWorkflowSkill } from './git-workflow-skill.js'
export { contextRetrievalSkill } from './context-retrieval-skill.js'
export { resourcefulPhilosophySkill } from './resourceful-philosophy-skill.js'

// Re-export all skills as a collection
import { llmComputeSkill } from './llm-compute-skill.js'
import { gitWorkflowSkill } from './git-workflow-skill.js'
import { contextRetrievalSkill } from './context-retrieval-skill.js'
import { resourcefulPhilosophySkill } from './resourceful-philosophy-skill.js'

/**
 * All built-in skills
 */
export const builtinSkills = [
  llmComputeSkill,
  gitWorkflowSkill,
  contextRetrievalSkill,
  resourcefulPhilosophySkill
]

/**
 * Skill lookup by ID
 */
export const skillsById = {
  'llm-compute-skill': llmComputeSkill,
  'git-workflow-skill': gitWorkflowSkill,
  'context-retrieval-skill': contextRetrievalSkill,
  'resourceful-philosophy': resourcefulPhilosophySkill
} as const

/**
 * Get skill by ID
 */
export function getBuiltinSkill(id: string) {
  return skillsById[id as keyof typeof skillsById]
}
