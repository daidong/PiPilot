/**
 * Skills Module
 *
 * Skills encapsulate procedural knowledge that can be lazily loaded
 * to optimize token usage in LLM interactions.
 *
 * @example
 * ```typescript
 * import { defineSkill, SkillManager, SkillRegistry } from './skills'
 *
 * const mySkill = defineSkill({
 *   id: 'my-skill',
 *   name: 'My Skill',
 *   shortDescription: 'Does something useful',
 *   instructions: {
 *     summary: 'Brief overview',
 *     procedures: 'Step-by-step guide',
 *     examples: 'Usage examples'
 *   },
 *   tools: ['my-tool'],
 *   loadingStrategy: 'lazy'
 * })
 *
 * const manager = new SkillManager()
 * manager.register(mySkill)
 * ```
 */

// Factory functions
export { defineSkill, extendSkill, mergeSkills } from './define-skill.js'

// Core classes
export { SkillManager } from './skill-manager.js'
export type { SkillManagerOptions } from './skill-manager.js'

export { SkillRegistry, globalSkillRegistry } from './skill-registry.js'
export type { SkillQuery, SkillMatch } from './skill-registry.js'

// Built-in skills
export {
  llmComputeSkill,
  gitWorkflowSkill,
  contextRetrievalSkill,
  builtinSkills,
  skillsById,
  getBuiltinSkill
} from './builtin/index.js'

// Re-export types from types/skill.ts for convenience
// Phase 3.1: SkillScripts removed (dead code)
export type {
  Skill,
  SkillConfig,
  SkillInstructions,
  SkillTokenEstimates,
  SkillLoadingStrategy,
  SkillLoadingConfig,
  SkillState,
  LoadedSkillContent,
  SkillManagerEvents
} from '../types/skill.js'
