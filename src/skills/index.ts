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
export { ExternalSkillLoader } from './external-skill-loader.js'
export type {
  ExternalSkillLoaderOptions,
  ExternalSkillSourceConfig,
  ExternalSkillSourceType,
  LoadedExternalSkill,
  LoadedSkillScript,
  SkillScriptRunner
} from './external-skill-loader.js'
export {
  parseExternalSkill,
  renderExternalSkillMarkdown,
  updateFrontmatter
} from './skill-file.js'
export type { ExternalSkillFrontmatter, ParsedExternalSkill } from './skill-file.js'

export { SkillInstaller } from './skill-installer.js'
export type { SkillInstallResult, InstalledSkillInfo, SkillInstallerOptions } from './skill-installer.js'
export { SkillRegistry, globalSkillRegistry } from './skill-registry.js'
export type { SkillQuery, SkillMatch } from './skill-registry.js'

// Built-in skills
export {
  llmComputeSkill,
  gitWorkflowSkill,
  contextRetrievalSkill,
  resourcefulPhilosophySkill,
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
  SkillManagerEvents,
  SkillTelemetryConfig,
  SkillTelemetryMode,
  SkillTelemetrySink,
  SkillScriptMetadata,
  SkillRegistrationOptions,
  SkillTokenSavings
} from '../types/skill.js'
