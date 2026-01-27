/**
 * System Phase - Assembles system prompt and pack prompt fragments
 *
 * Priority: 100 (highest)
 * Budget: reserved 2000 tokens
 *
 * This phase includes:
 * - Core system prompt (identity, constraints)
 * - Pack prompt fragments from all loaded packs
 */

import type { ContextPhase, ContextFragment, AssemblyContext } from '../../types/context-pipeline.js'
import type { Pack } from '../../types/pack.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'

/**
 * Configuration for system phase
 */
export interface SystemPhaseConfig {
  /** Core system prompt / identity */
  systemPrompt?: string
  /** Loaded packs (for prompt fragments) */
  packs?: Pack[]
  /** Additional constraints */
  constraints?: string[]
}

/**
 * Create the system phase
 */
export function createSystemPhase(config: SystemPhaseConfig = {}): ContextPhase {
  const { systemPrompt, packs = [], constraints = [] } = config

  return {
    id: 'system',
    priority: PHASE_PRIORITIES.system,
    budget: DEFAULT_BUDGETS.system,

    async assemble(_ctx: AssemblyContext): Promise<ContextFragment[]> {
      const fragments: ContextFragment[] = []

      // Add core system prompt
      if (systemPrompt) {
        const content = systemPrompt
        fragments.push({
          source: 'system:identity',
          content,
          tokens: estimateTokens(content)
        })
      }

      // Add constraints
      if (constraints.length > 0) {
        const content = [
          '## Constraints',
          '',
          ...constraints.map(c => `- ${c}`)
        ].join('\n')

        fragments.push({
          source: 'system:constraints',
          content,
          tokens: estimateTokens(content)
        })
      }

      // Add pack prompt fragments
      for (const pack of packs) {
        if (pack.promptFragment) {
          fragments.push({
            source: `pack:${pack.id}`,
            content: pack.promptFragment,
            tokens: estimateTokens(pack.promptFragment),
            metadata: { packId: pack.id }
          })
        }
      }

      return fragments
    }
  }
}

/**
 * Estimate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3)
}
