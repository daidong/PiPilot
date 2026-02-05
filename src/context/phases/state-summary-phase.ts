/**
 * State Summary Phase - RFC-009
 *
 * Assembles session memory (ephemeral key-value data) for context inclusion.
 *
 * Priority: 60 (after project-cards and workingset, before session history)
 * Budget: configurable (default 600 tokens)
 *
 * This phase replaces the old message-prefix injection approach.
 * Session memory is now budgeted and subject to TTL expiration.
 *
 * Session memory includes:
 * - Short-term facts and decisions
 * - User preferences discovered in session
 * - Task state and progress
 * - Temporary notes
 */

import type { ContextPhase, ContextFragment, AssemblyContext } from '../../types/context-pipeline.js'
import type { MemoryItem } from '../../types/memory.js'
import { countTokens, truncateToTokens } from '../../utils/tokenizer.js'

/**
 * Configuration for State Summary phase
 */
export interface StateSummaryPhaseConfig {
  /**
   * Time-to-live for session memory items in milliseconds
   * Default: 2 hours (sliding)
   */
  ttl?: number

  /**
   * Maximum number of session memory items
   * Default: 8
   */
  maxItems?: number

  /**
   * Maximum tokens for session memory section
   * Default: 600
   */
  maxTokens?: number

  /**
   * Whether to refresh item TTL on read
   * Default: true
   */
  refreshOnRead?: boolean

  /**
   * Session memory namespace
   * Default: 'session'
   */
  namespace?: string
}

/**
 * Default configuration matching RFC-009
 */
const DEFAULT_STATE_SUMMARY_CONFIG: Required<StateSummaryPhaseConfig> = {
  ttl: 2 * 60 * 60 * 1000, // 2 hours
  maxItems: 8,
  maxTokens: 600,
  refreshOnRead: true,
  namespace: 'session'
}

/**
 * Create the State Summary phase
 *
 * This phase queries memoryStorage for session-scoped items
 * and includes them in context with proper budgeting.
 */
export function createStateSummaryPhase(
  config: StateSummaryPhaseConfig = {}
): ContextPhase {
  const cfg = { ...DEFAULT_STATE_SUMMARY_CONFIG, ...config }

  return {
    id: 'state-summary',
    priority: 60, // After project-cards (90) and workingset (70), before session (50)
    budget: { type: 'fixed' as const, tokens: cfg.maxTokens },

    async assemble(ctx: AssemblyContext): Promise<ContextFragment[]> {
      const { runtime, remainingBudget, allocatedBudget } = ctx
      const fragments: ContextFragment[] = []

      // Check if memory storage is available
      const memoryStorage = runtime.memoryStorage
      if (!memoryStorage) {
        return fragments
      }

      try {
        // Query session memory
        const result = await memoryStorage.list({
          namespace: cfg.namespace,
          status: 'active',
          limit: cfg.maxItems * 2 // Over-fetch to allow for TTL filtering
        })

        if (result.items.length === 0) {
          return fragments
        }

        // Filter by TTL
        const now = Date.now()
        const validItems = result.items.filter(item => {
          // Check TTL expiration
          if (item.ttlExpiresAt) {
            const expiresAt = new Date(item.ttlExpiresAt).getTime()
            if (now > expiresAt) {
              return false
            }
          }

          // Check sliding TTL based on updatedAt
          const updatedAt = new Date(item.updatedAt).getTime()
          if (now - updatedAt > cfg.ttl) {
            return false
          }

          return true
        })

        if (validItems.length === 0) {
          return fragments
        }

        // Sort by recency
        const sortedItems = validItems
          .sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )
          .slice(0, cfg.maxItems)

        // Refresh TTL if configured
        if (cfg.refreshOnRead) {
          // Note: Actual refresh would require update calls
          // This is a placeholder for the refresh behavior
          // In practice, apps should call memoryStorage.update() to refresh
        }

        // Build state summary content
        const effectiveBudget = Math.min(cfg.maxTokens, allocatedBudget ?? remainingBudget)
        const content = formatStateSummary(sortedItems, effectiveBudget)

        if (content) {
          fragments.push({
            source: 'state-summary',
            content,
            tokens: countTokens(content),
            metadata: {
              itemCount: sortedItems.length,
              ttl: cfg.ttl,
              namespace: cfg.namespace
            }
          })
        }
      } catch (error) {
        console.error('[StateSummaryPhase] Failed to retrieve session memory:', error)
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
 * Format state summary for context
 */
function formatStateSummary(items: MemoryItem[], maxTokens: number): string {
  const parts: string[] = []

  // Header
  parts.push('## Session Memory')
  parts.push('')

  // Format each item
  const now = Date.now()
  const itemLines: string[] = []

  for (const item of items) {
    const ago = Math.round((now - new Date(item.updatedAt).getTime()) / 60000)
    const timeLabel = ago < 1 ? 'just now' : `${ago}min ago`

    // Format value
    let valueStr: string
    if (item.valueText) {
      valueStr = item.valueText
    } else if (typeof item.value === 'string') {
      valueStr = item.value
    } else {
      valueStr = JSON.stringify(item.value)
    }

    // Truncate long values
    if (valueStr.length > 200) {
      valueStr = valueStr.slice(0, 200) + '...'
    }

    itemLines.push(`- **${item.key}**: ${valueStr} _(${timeLabel})_`)
  }

  parts.push(...itemLines)

  // Combine and truncate if needed
  let content = parts.join('\n')
  const tokens = countTokens(content)

  if (tokens > maxTokens) {
    content = truncateToTokens(content, maxTokens, 'tail')
  }

  return content
}

/**
 * Helper to check if an item has expired
 */
export function isSessionItemExpired(
  item: MemoryItem,
  ttl: number
): boolean {
  const now = Date.now()

  // Check explicit TTL
  if (item.ttlExpiresAt) {
    const expiresAt = new Date(item.ttlExpiresAt).getTime()
    if (now > expiresAt) {
      return true
    }
  }

  // Check sliding TTL
  const updatedAt = new Date(item.updatedAt).getTime()
  return now - updatedAt > ttl
}

/**
 * Clean expired session items
 */
export async function cleanExpiredSessionItems(
  memoryStorage: import('../../types/memory.js').MemoryStorage,
  namespace: string = 'session',
  ttl: number = DEFAULT_STATE_SUMMARY_CONFIG.ttl
): Promise<number> {
  let cleaned = 0

  try {
    const result = await memoryStorage.list({
      namespace,
      status: 'active'
    })

    for (const item of result.items) {
      if (isSessionItemExpired(item, ttl)) {
        await memoryStorage.delete(namespace, item.key, 'ttl-expired')
        cleaned++
      }
    }
  } catch (error) {
    console.error('[StateSummary] Failed to clean expired items:', error)
  }

  return cleaned
}
