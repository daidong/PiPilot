/**
 * Pinned Phase (legacy) - Assembles pinned memory items
 *
 * Priority/Budget: aligned with project-cards defaults
 *
 * This phase retrieves memory items tagged with 'pinned' and includes them
 * in the context. Pinned items are sorted by priority metadata.
 */

import type { ContextPhase, ContextFragment, AssemblyContext } from '../../types/context-pipeline.js'
import type { MemoryItem } from '../../types/memory.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../pipeline.js'

/**
 * Configuration for pinned phase
 */
export interface PinnedPhaseConfig {
  /** Maximum number of pinned items to include */
  maxItems?: number
}

/**
 * Create the pinned phase
 */
export function createPinnedPhase(config: PinnedPhaseConfig = {}): ContextPhase {
  const { maxItems = 10 } = config

  return {
    id: 'pinned',
    priority: PHASE_PRIORITIES['project-cards'],
    budget: DEFAULT_BUDGETS['project-cards'],

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime } = ctx
      const fragments: ContextFragment[] = []

      // Check if memory storage is available
      const memoryStorage = runtime.memoryStorage
      if (!memoryStorage) {
        return fragments
      }

      try {
        // Query memory for pinned items
        const result = await memoryStorage.list({
          tags: ['pinned'],
          status: 'active',
          limit: maxItems
        })

        if (result.items.length === 0) {
          return fragments
        }

        // Sort by priority (higher first)
        const sortedItems = result.items.sort((a, b) => {
          const priorityA = (a as MemoryItemWithPriority).priority ?? 50
          const priorityB = (b as MemoryItemWithPriority).priority ?? 50
          return priorityB - priorityA
        })

        // Add header
        const headerContent = '## Pinned Context'
        fragments.push({
          source: 'pinned:header',
          content: headerContent,
          tokens: estimateTokens(headerContent)
        })

        // Add each pinned item
        for (const item of sortedItems) {
          const content = formatPinnedItem(item)
          fragments.push({
            source: `pinned:${item.namespace}:${item.key}`,
            content,
            tokens: estimateTokens(content),
            metadata: {
              key: item.key,
              namespace: item.namespace,
              priority: (item as MemoryItemWithPriority).priority
            }
          })
        }
      } catch (error) {
        console.error('[PinnedPhase] Failed to retrieve pinned items:', error)
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
 * Format a pinned item for display
 */
function formatPinnedItem(item: MemoryItem): string {
  const lines: string[] = []

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

  return lines.join('\n')
}

/**
 * Estimate token count
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3)
}
