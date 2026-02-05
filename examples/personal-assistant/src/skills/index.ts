/**
 * Personal Assistant Skills
 *
 * App-specific skills for the personal-assistant example.
 * These skills provide procedural knowledge that can be lazily loaded
 * to optimize token usage.
 *
 * Token Savings Summary:
 * | Skill | Before | After (summary) | After (full) | Initial Savings |
 * |-------|--------|-----------------|--------------|-----------------|
 * | gmail | ~650 | ~80 | ~500 | 88% |
 * | calendar | ~180 | ~50 | ~350 | 72% |
 * | **Total** | ~830 | ~130 | ~850 | **84%** |
 */

export { gmailSkill } from './gmail-skill.js'
export { calendarSkill } from './calendar-skill.js'

// Re-export all skills as a collection
import { gmailSkill } from './gmail-skill.js'
import { calendarSkill } from './calendar-skill.js'

/**
 * All personal-assistant skills
 */
export const personalAssistantSkills = [
  gmailSkill,
  calendarSkill
]

/**
 * Skill lookup by ID
 */
export const skillsById = {
  'gmail-skill': gmailSkill,
  'calendar-skill': calendarSkill
} as const

/**
 * Get skill by ID
 */
export function getSkill(id: string) {
  return skillsById[id as keyof typeof skillsById]
}
