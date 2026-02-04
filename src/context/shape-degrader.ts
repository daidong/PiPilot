/**
 * Shape Degrader - RFC-009
 *
 * Unified shape degradation ladder for context budget management.
 * Applies to both Project Cards and WorkingSet items.
 *
 * Degradation Levels:
 * - L0 (usage < 70%):  full shape - complete content
 * - L1 (usage ≥ 80%):  excerpt shape - truncated content
 * - L2 (usage ≥ 95%):  card shape - summary only
 * - L3 (overflow):     index-line shape - minimal reference
 *
 * Shape Ladder:
 * full → excerpt → card → index-line → drop
 */

import type { EntityShape } from '../types/memory-entity.js'
import { countTokens, truncateToTokens } from '../utils/tokenizer.js'

// ============ Types ============

/**
 * Degradation level
 */
export type DegradationLevel = 'L0' | 'L1' | 'L2' | 'L3'

/**
 * Configuration for shape degradation
 */
export interface ShapeDegraderConfig {
  /**
   * Threshold for L0 (normal) - usage below this is full shape
   * Default: 0.70 (70%)
   */
  l0Threshold?: number

  /**
   * Threshold for L1 (excerpt) - usage at or above this triggers excerpt
   * Default: 0.80 (80%)
   */
  l1Threshold?: number

  /**
   * Threshold for L2 (card) - usage at or above this triggers card
   * Default: 0.95 (95%)
   */
  l2Threshold?: number

  /**
   * Maximum tokens for excerpt shape
   * Default: 500
   */
  excerptMaxTokens?: number

  /**
   * Maximum tokens for card shape
   * Default: 150
   */
  cardMaxTokens?: number

  /**
   * Maximum tokens for index-line shape
   * Default: 30
   */
  indexLineMaxTokens?: number
}

/**
 * Default configuration matching RFC-009
 */
const DEFAULT_CONFIG: Required<ShapeDegraderConfig> = {
  l0Threshold: 0.70,
  l1Threshold: 0.80,
  l2Threshold: 0.95,
  excerptMaxTokens: 500,
  cardMaxTokens: 150,
  indexLineMaxTokens: 30
}

/**
 * Item to be degraded
 */
export interface DegradableItem {
  /** Unique identifier */
  id: string

  /** Current shape */
  currentShape: EntityShape

  /** Content for each shape level */
  content: {
    full?: string
    excerpt?: string
    card?: string
    indexLine?: string
  }

  /** Priority (higher = more important, less likely to degrade) */
  priority: number

  /** Is this a Project Card? (higher protection) */
  isProjectCard?: boolean
}

/**
 * Result of degradation
 */
export interface DegradationResult {
  /** Item ID */
  id: string

  /** Original shape */
  originalShape: EntityShape

  /** Degraded shape */
  degradedShape: EntityShape

  /** Final content */
  content: string

  /** Token count of final content */
  tokens: number

  /** Whether item was dropped entirely */
  dropped: boolean

  /** Reason for degradation */
  reason: string
}

// ============ Level Detection ============

/**
 * Determine degradation level based on budget usage
 */
export function getDegradationLevel(
  usedTokens: number,
  totalBudget: number,
  config: ShapeDegraderConfig = {}
): DegradationLevel {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const usage = totalBudget > 0 ? usedTokens / totalBudget : 1

  if (usage >= cfg.l2Threshold) {
    return 'L3' // Overflow - index-line only
  } else if (usage >= cfg.l1Threshold) {
    return 'L2' // Card shape
  } else if (usage >= cfg.l0Threshold) {
    return 'L1' // Excerpt shape
  } else {
    return 'L0' // Full shape
  }
}

/**
 * Get target shape for degradation level
 */
export function getTargetShape(level: DegradationLevel): EntityShape {
  switch (level) {
    case 'L0':
      return 'full'
    case 'L1':
      return 'excerpt'
    case 'L2':
      return 'card'
    case 'L3':
      return 'index-line'
  }
}

/**
 * Get shape priority (lower = more degraded)
 */
function getShapePriority(shape: EntityShape): number {
  switch (shape) {
    case 'full':
      return 4
    case 'excerpt':
      return 3
    case 'card':
      return 2
    case 'index-line':
      return 1
    default:
      return 0
  }
}

/**
 * Check if shape A is more degraded than shape B
 */
export function isMoreDegraded(shapeA: EntityShape, shapeB: EntityShape): boolean {
  return getShapePriority(shapeA) < getShapePriority(shapeB)
}

// ============ Content Generation ============

/**
 * Generate content for a specific shape
 */
export function generateShapeContent(
  item: DegradableItem,
  targetShape: EntityShape,
  config: ShapeDegraderConfig = {}
): string {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Try to use pre-generated content if available
  if (item.content[targetShape === 'index-line' ? 'indexLine' : targetShape]) {
    const content = item.content[targetShape === 'index-line' ? 'indexLine' : targetShape]!
    return content
  }

  // Fall back to degrading from higher shapes
  switch (targetShape) {
    case 'full':
      return item.content.full || item.content.excerpt || item.content.card || item.content.indexLine || `[${item.id}]`

    case 'excerpt':
      if (item.content.excerpt) return item.content.excerpt
      if (item.content.full) {
        return truncateToTokens(item.content.full, cfg.excerptMaxTokens, 'head')
      }
      return item.content.card || item.content.indexLine || `[${item.id}]`

    case 'card':
      if (item.content.card) return item.content.card
      if (item.content.excerpt) {
        return truncateToTokens(item.content.excerpt, cfg.cardMaxTokens, 'head')
      }
      if (item.content.full) {
        return truncateToTokens(item.content.full, cfg.cardMaxTokens, 'head')
      }
      return item.content.indexLine || `[${item.id}]`

    case 'index-line':
      if (item.content.indexLine) return item.content.indexLine
      // Generate minimal reference
      return `- ${item.id}`

    default:
      return `[${item.id}]`
  }
}

// ============ Degradation Engine ============

/**
 * Shape Degrader - manages context budget through shape degradation
 */
export class ShapeDegrader {
  private config: Required<ShapeDegraderConfig>

  constructor(config: ShapeDegraderConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Get current degradation level
   */
  getLevel(usedTokens: number, totalBudget: number): DegradationLevel {
    return getDegradationLevel(usedTokens, totalBudget, this.config)
  }

  /**
   * Degrade a single item to fit budget
   */
  degradeItem(
    item: DegradableItem,
    level: DegradationLevel
  ): DegradationResult {
    const targetShape = getTargetShape(level)

    // Project Cards get one level of protection
    let effectiveShape = targetShape
    if (item.isProjectCard && level !== 'L0') {
      // Project Cards degrade one level slower
      const protectedLevel = level === 'L3' ? 'L2' :
                             level === 'L2' ? 'L1' :
                             level === 'L1' ? 'L0' : 'L0'
      effectiveShape = getTargetShape(protectedLevel)
    }

    // Don't degrade below current shape if it's already more degraded
    if (isMoreDegraded(item.currentShape, effectiveShape)) {
      effectiveShape = item.currentShape
    }

    const content = generateShapeContent(item, effectiveShape, this.config)
    const tokens = countTokens(content)

    return {
      id: item.id,
      originalShape: item.currentShape,
      degradedShape: effectiveShape,
      content,
      tokens,
      dropped: false,
      reason: item.currentShape === effectiveShape
        ? 'No degradation needed'
        : `Degraded from ${item.currentShape} to ${effectiveShape} (level ${level})`
    }
  }

  /**
   * Degrade multiple items to fit within budget
   */
  degradeItems(
    items: DegradableItem[],
    totalBudget: number,
    reservedTokens: number = 0
  ): DegradationResult[] {
    const availableBudget = totalBudget - reservedTokens
    const results: DegradationResult[] = []

    // Sort by priority (higher first) and project card status
    const sortedItems = [...items].sort((a, b) => {
      // Project Cards always first
      if (a.isProjectCard && !b.isProjectCard) return -1
      if (!a.isProjectCard && b.isProjectCard) return 1
      // Then by priority
      return b.priority - a.priority
    })

    let usedTokens = 0

    for (const item of sortedItems) {
      // Get current degradation level
      const level = this.getLevel(usedTokens, availableBudget)

      // Degrade item
      const result = this.degradeItem(item, level)

      // Check if item fits
      if (usedTokens + result.tokens <= availableBudget) {
        results.push(result)
        usedTokens += result.tokens
      } else {
        // Try more aggressive degradation
        const moreAggressiveLevel: DegradationLevel =
          level === 'L0' ? 'L1' :
          level === 'L1' ? 'L2' :
          level === 'L2' ? 'L3' : 'L3'

        const aggressiveResult = this.degradeItem(item, moreAggressiveLevel)

        if (usedTokens + aggressiveResult.tokens <= availableBudget) {
          results.push(aggressiveResult)
          usedTokens += aggressiveResult.tokens
        } else if (!item.isProjectCard) {
          // Drop non-Project Card items if nothing fits
          results.push({
            id: item.id,
            originalShape: item.currentShape,
            degradedShape: 'index-line',
            content: '',
            tokens: 0,
            dropped: true,
            reason: 'Dropped due to budget constraints'
          })
        } else {
          // Project Cards always get at least index-line
          const minimalResult = this.degradeItem(item, 'L3')
          results.push(minimalResult)
          usedTokens += minimalResult.tokens
        }
      }
    }

    return results
  }

  /**
   * Calculate optimal degradation for a set of items
   */
  calculateOptimalDegradation(
    items: DegradableItem[],
    totalBudget: number
  ): {
    level: DegradationLevel
    results: DegradationResult[]
    totalTokens: number
    droppedCount: number
  } {
    const results = this.degradeItems(items, totalBudget)

    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0)
    const droppedCount = results.filter(r => r.dropped).length
    const level = this.getLevel(totalTokens, totalBudget)

    return {
      level,
      results,
      totalTokens,
      droppedCount
    }
  }
}

/**
 * Create a shape degrader with custom config
 */
export function createShapeDegrader(config: ShapeDegraderConfig = {}): ShapeDegrader {
  return new ShapeDegrader(config)
}
