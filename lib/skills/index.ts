/**
 * Research Copilot Skills
 *
 * Re-exports the skill loader and provides metadata for UI display.
 */

import { loadAllSkills, loadBuiltinSkills, loadWorkspaceSkills, getSkillByName, buildSkillsCatalog } from './loader.js'
import type { SkillEntry, SkillCatalogItem } from './loader.js'

export { loadAllSkills, loadBuiltinSkills, loadWorkspaceSkills, getSkillByName, buildSkillsCatalog }
export type { SkillEntry, SkillCatalogItem }

/** Metadata for UI display */
export const researchPilotSkills = [
  { id: 'academic-writing-skill', name: 'Academic Writing' },
  { id: 'literature-skill', name: 'Literature Search' },
  { id: 'data-analysis-skill', name: 'Data Analysis' },
  // myRAM builtin skills
  { id: 'scientific-writing', name: 'Scientific Writing' },
  { id: 'scientific-visualization', name: 'Scientific Visualization' },
  { id: 'research-grants', name: 'Research Grants' },
  { id: 'matplotlib', name: 'Matplotlib' },
  { id: 'seaborn', name: 'Seaborn' },
  { id: 'scholar-evaluation', name: 'Scholar Evaluation' },
  { id: 'rewrite-humanize', name: 'Rewrite & Humanize' }
]

/** Skill lookup by ID */
export const skillsById = Object.fromEntries(
  researchPilotSkills.map((s) => [s.id, s])
) as Record<string, (typeof researchPilotSkills)[number]>

/** Get skill metadata by ID */
export function getSkill(id: string) {
  return skillsById[id]
}
