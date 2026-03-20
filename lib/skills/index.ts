/**
 * Research Pilot Skills
 *
 * Skills metadata for UI display purposes.
 * Actual skill content is loaded by pi-mono from .pi/skills/ directory at runtime.
 */

export const researchPilotSkills = [
  { id: 'academic-writing-skill', name: 'Academic Writing' },
  { id: 'literature-skill', name: 'Literature Search' },
  { id: 'data-analysis-skill', name: 'Data Analysis' }
]

/**
 * Skill lookup by ID
 */
export const skillsById = {
  'academic-writing-skill': researchPilotSkills[0],
  'literature-skill': researchPilotSkills[1],
  'data-analysis-skill': researchPilotSkills[2]
} as const

/**
 * Get skill by ID
 */
export function getSkill(id: string) {
  return skillsById[id as keyof typeof skillsById]
}
