/**
 * Research Pilot Agents
 *
 * Note: Writing functionality is now handled via academicWritingSkill.
 * The Coordinator loads the skill when writing intent is detected.
 * See: ../skills/academic-writing-skill.ts
 */

export { createCoordinator, createCoordinatorRunner, type CoordinatorConfig } from './coordinator.js'
export { createLiteratureAgent, type LiteratureSearchResult } from './literature-agent.js'
export { createDataAgent, dataAnalyzer } from './data-agent.js'
