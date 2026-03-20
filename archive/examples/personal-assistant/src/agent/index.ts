/**
 * Personal Assistant — library entry point.
 *
 * Re-exports the coordinator factory so the desktop shell (and any other
 * consumer) can simply `import { createCoordinator } from '@personal-assistant'`.
 */

export { createCoordinator } from './agents/coordinator.js'
export type { CoordinatorConfig } from './agents/coordinator.js'

// Skills (migrated from coordinator-module-* prompts)
export { gmailSkill, calendarSkill, personalAssistantSkills } from '../skills/index.js'
