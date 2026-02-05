/**
 * Skill Factory Function
 *
 * Creates validated Skill instances from configuration objects.
 * Similar to defineTool and definePack patterns.
 */

import type { Skill, SkillConfig, SkillTokenEstimates } from '../types/skill.js'

/**
 * Estimate token count from text content
 * Uses rough approximation: ~4 characters per token for English text
 */
function estimateTokens(text: string | undefined): number {
  if (!text) return 0
  // Rough estimate: 4 chars per token, accounting for whitespace
  return Math.ceil(text.length / 4)
}

/**
 * Calculate token estimates from instructions
 */
function calculateTokenEstimates(
  instructions: SkillConfig['instructions'],
  providedEstimates?: Partial<SkillTokenEstimates>
): SkillTokenEstimates {
  const summaryTokens = providedEstimates?.summary ?? estimateTokens(instructions.summary)

  const fullTokens = providedEstimates?.full ?? (
    estimateTokens(instructions.summary) +
    estimateTokens(instructions.procedures) +
    estimateTokens(instructions.examples) +
    estimateTokens(instructions.troubleshooting)
  )

  return {
    summary: summaryTokens,
    full: fullTokens
  }
}

/**
 * Core skill config properties needed for validation
 * Phase 3.1: scripts property removed (dead code)
 */
interface SkillConfigBase {
  id: string
  name: string
  shortDescription: string
  instructions: {
    summary: string
    procedures?: string
    examples?: string
    troubleshooting?: string
  }
}

/**
 * Validate skill configuration
 * Uses SkillConfigBase to avoid generic type issues with scripts property
 */
function validateSkillConfig(config: SkillConfigBase): void {
  if (!config.id) {
    throw new Error('Skill id is required')
  }

  if (!/^[a-z][a-z0-9-]*$/.test(config.id)) {
    throw new Error(
      `Skill id "${config.id}" must be kebab-case (lowercase letters, numbers, hyphens, starting with letter)`
    )
  }

  if (!config.name) {
    throw new Error('Skill name is required')
  }

  if (!config.shortDescription) {
    throw new Error('Skill shortDescription is required')
  }

  if (config.shortDescription.length > 100) {
    console.warn(
      `[defineSkill] Skill "${config.id}" shortDescription exceeds 100 chars (${config.shortDescription.length}). ` +
      'Consider shortening for better matching.'
    )
  }

  if (!config.instructions) {
    throw new Error('Skill instructions is required')
  }

  if (!config.instructions.summary) {
    throw new Error('Skill instructions.summary is required')
  }
}

/**
 * Create a validated Skill instance from configuration
 *
 * @example
 * ```typescript
 * const mySkill = defineSkill({
 *   id: 'my-skill',
 *   name: 'My Skill',
 *   shortDescription: 'Does something useful',
 *   instructions: {
 *     summary: 'Brief overview of the skill',
 *     procedures: 'Detailed step-by-step instructions',
 *     examples: '// Example usage code'
 *   },
 *   tools: ['my-tool'],
 *   loadingStrategy: 'lazy'
 * })
 * ```
 */
export function defineSkill(config: SkillConfig): Skill {
  // Validate configuration
  validateSkillConfig(config)

  // Calculate token estimates
  const estimatedTokens = calculateTokenEstimates(
    config.instructions,
    config.estimatedTokens
  )

  // Phase 3.1: scripts property removed (dead code - never executed)
  return {
    id: config.id,
    name: config.name,
    shortDescription: config.shortDescription,
    instructions: {
      summary: config.instructions.summary.trim(),
      procedures: config.instructions.procedures?.trim(),
      examples: config.instructions.examples?.trim(),
      troubleshooting: config.instructions.troubleshooting?.trim()
    },
    tools: config.tools ?? [],
    loadingStrategy: config.loadingStrategy ?? 'lazy',
    estimatedTokens,
    tags: config.tags ?? []
  }
}

/**
 * Extend an existing skill with additional configuration
 *
 * @example
 * ```typescript
 * const extendedSkill = extendSkill(baseSkill, {
 *   instructions: {
 *     examples: '// Additional examples'
 *   }
 * })
 * ```
 */
export function extendSkill(
  base: Skill,
  extension: Partial<SkillConfig>
): Skill {
  const mergedInstructions = {
    summary: extension.instructions?.summary ?? base.instructions.summary,
    procedures: extension.instructions?.procedures ?? base.instructions.procedures,
    examples: extension.instructions?.examples ?? base.instructions.examples,
    troubleshooting: extension.instructions?.troubleshooting ?? base.instructions.troubleshooting
  }

  // Calculate token estimates
  const estimatedTokens = calculateTokenEstimates(
    mergedInstructions,
    extension.estimatedTokens ?? base.estimatedTokens
  )

  // Validate the merged config
  // Phase 3.1: scripts property removed (dead code)
  const mergedConfig: SkillConfig = {
    id: extension.id ?? base.id,
    name: extension.name ?? base.name,
    shortDescription: extension.shortDescription ?? base.shortDescription,
    instructions: mergedInstructions,
    tools: extension.tools ?? base.tools,
    loadingStrategy: extension.loadingStrategy ?? base.loadingStrategy,
    estimatedTokens,
    tags: [...(base.tags ?? []), ...(extension.tags ?? [])]
  }

  validateSkillConfig(mergedConfig)

  return {
    id: mergedConfig.id,
    name: mergedConfig.name,
    shortDescription: mergedConfig.shortDescription,
    instructions: {
      summary: mergedConfig.instructions.summary.trim(),
      procedures: mergedConfig.instructions.procedures?.trim(),
      examples: mergedConfig.instructions.examples?.trim(),
      troubleshooting: mergedConfig.instructions.troubleshooting?.trim()
    },
    tools: mergedConfig.tools ?? [],
    loadingStrategy: mergedConfig.loadingStrategy ?? 'lazy',
    estimatedTokens,
    tags: mergedConfig.tags ?? []
  }
}

/**
 * Merge multiple skills into one
 * Useful for combining related skills
 *
 * @example
 * ```typescript
 * const combinedSkill = mergeSkills(
 *   'combined-skill',
 *   'Combined Skill',
 *   [skillA, skillB]
 * )
 * ```
 */
export function mergeSkills(
  id: string,
  name: string,
  skills: Skill[]
): Skill {
  if (skills.length === 0) {
    throw new Error('At least one skill is required for merging')
  }

  const summaries = skills.map(s => `### ${s.name}\n${s.instructions.summary}`).join('\n\n')
  const procedures = skills
    .filter(s => s.instructions.procedures)
    .map(s => `### ${s.name}\n${s.instructions.procedures}`)
    .join('\n\n')
  const examples = skills
    .filter(s => s.instructions.examples)
    .map(s => `### ${s.name}\n${s.instructions.examples}`)
    .join('\n\n')
  const troubleshooting = skills
    .filter(s => s.instructions.troubleshooting)
    .map(s => `### ${s.name}\n${s.instructions.troubleshooting}`)
    .join('\n\n')

  const allTools = [...new Set(skills.flatMap(s => s.tools ?? []))]
  const allTags = [...new Set(skills.flatMap(s => s.tags ?? []))]

  return defineSkill({
    id,
    name,
    shortDescription: `Combined skill: ${skills.map(s => s.name).join(', ')}`,
    instructions: {
      summary: summaries,
      procedures: procedures || undefined,
      examples: examples || undefined,
      troubleshooting: troubleshooting || undefined
    },
    tools: allTools,
    loadingStrategy: 'lazy',
    tags: allTags
  })
}
