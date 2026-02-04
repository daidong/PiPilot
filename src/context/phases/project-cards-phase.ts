/**
 * Project Cards Phase - RFC-009
 *
 * Assembles Project Card entities for context inclusion.
 *
 * Priority: 90 (same as old pinned phase)
 * Budget: reserved 2000 tokens (configurable via budget coordinator)
 *
 * Project Cards represent core decisions, constraints, and alignment.
 * They replace the old "pinned" semantics with clearer long-term memory intent.
 *
 * Migration: This phase supports both old 'pinned' tags and new 'project-card' tags
 * for backward compatibility during the transition period.
 */

import type { ContextPhase, ContextFragment, AssemblyContext } from '../../types/context-pipeline.js'
import type { MemoryItem } from '../../types/memory.js'
import type { EntityShape } from '../../types/memory-entity.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'
import { countTokens } from '../../utils/tokenizer.js'

/**
 * Configuration for Project Cards phase
 */
export interface ProjectCardsPhaseConfig {
  /** Maximum number of Project Cards to include (default: 20) */
  maxItems?: number
  /** Whether to also include items tagged as 'pinned' for backward compatibility (default: true) */
  includeLegacyPinned?: boolean
  /** Default shape for Project Cards when budget allows (default: 'card') */
  defaultShape?: EntityShape
}

/**
 * Create the Project Cards phase
 *
 * This phase queries memoryStorage for items tagged with 'project-card'
 * (and optionally 'pinned' for backward compatibility).
 */
export function createProjectCardsPhase(config: ProjectCardsPhaseConfig = {}): ContextPhase {
  const {
    maxItems = 20,
    includeLegacyPinned = true,
    defaultShape = 'card'
  } = config

  return {
    id: 'project-cards',
    priority: PHASE_PRIORITIES.pinned, // Same priority as old pinned phase
    budget: DEFAULT_BUDGETS.pinned,    // Same budget as old pinned phase

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime } = ctx
      const fragments: ContextFragment[] = []

      // Check if memory storage is available
      const memoryStorage = runtime.memoryStorage
      if (!memoryStorage) {
        return fragments
      }

      try {
        // Query for project-card tagged items
        const projectCardResult = await memoryStorage.list({
          tags: ['project-card'],
          status: 'active',
          limit: maxItems
        })

        // Optionally query for legacy 'pinned' items (backward compatibility)
        let legacyPinnedItems: MemoryItem[] = []
        if (includeLegacyPinned) {
          const pinnedResult = await memoryStorage.list({
            tags: ['pinned'],
            status: 'active',
            limit: maxItems
          })
          legacyPinnedItems = pinnedResult.items
        }

        // Merge and deduplicate by key
        const seenKeys = new Set<string>()
        const allItems: MemoryItem[] = []

        // Project Cards first (higher priority)
        for (const item of projectCardResult.items) {
          const fullKey = `${item.namespace}:${item.key}`
          if (!seenKeys.has(fullKey)) {
            seenKeys.add(fullKey)
            allItems.push(item)
          }
        }

        // Legacy pinned items (if not already included)
        for (const item of legacyPinnedItems) {
          const fullKey = `${item.namespace}:${item.key}`
          if (!seenKeys.has(fullKey)) {
            seenKeys.add(fullKey)
            allItems.push(item)
          }
        }

        if (allItems.length === 0) {
          return fragments
        }

        // Sort by priority (higher first)
        const sortedItems = allItems.sort((a, b) => {
          const priorityA = (a as MemoryItemWithPriority).priority ?? 50
          const priorityB = (b as MemoryItemWithPriority).priority ?? 50
          return priorityB - priorityA
        })

        // Add header
        const headerContent = '## Project Cards'
        fragments.push({
          source: 'project-cards:header',
          content: headerContent,
          tokens: countTokens(headerContent)
        })

        // Add each Project Card
        for (const item of sortedItems) {
          const content = formatProjectCard(item, defaultShape)
          fragments.push({
            source: `project-cards:${item.namespace}:${item.key}`,
            content,
            tokens: countTokens(content),
            metadata: {
              key: item.key,
              namespace: item.namespace,
              priority: (item as MemoryItemWithPriority).priority,
              shape: defaultShape,
              // Mark if this was from legacy pinned
              legacy: item.tags?.includes('pinned') && !item.tags?.includes('project-card')
            }
          })
        }
      } catch (error) {
        console.error('[ProjectCardsPhase] Failed to retrieve Project Cards:', error)
      }

      return fragments
    },

    // Only enable if memory storage is available
    enabled(ctx: AssemblyContext): boolean {
      return ctx.runtime.memoryStorage !== undefined
    }
  }
}

/**
 * Memory item with optional priority field
 */
interface MemoryItemWithPriority extends MemoryItem {
  priority?: number
}

/**
 * Format a Project Card for display
 *
 * Supports different shapes based on budget pressure:
 * - 'full': Complete content
 * - 'excerpt': First portion of content
 * - 'card': Summary card (default)
 * - 'index-line': Minimal one-line reference
 */
function formatProjectCard(item: MemoryItem, shape: EntityShape): string {
  const lines: string[] = []

  switch (shape) {
    case 'index-line':
      // Minimal reference line
      return `- ${item.namespace}:${item.key}`

    case 'card':
    case 'excerpt':
    case 'full':
    default:
      // Full format (shape degradation will be handled by shape-degrader)
      lines.push(`### ${item.key}`)

      if (item.valueText) {
        lines.push(item.valueText)
      } else if (typeof item.value === 'string') {
        lines.push(item.value)
      } else {
        lines.push('```json')
        lines.push(JSON.stringify(item.value, null, 2))
        lines.push('```')
      }
      break
  }

  return lines.join('\n')
}

// Re-export for backward compatibility
export { createProjectCardsPhase as createPinnedPhase }
export type { ProjectCardsPhaseConfig as PinnedPhaseConfig }
