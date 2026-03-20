/**
 * TokenBudget - Token Budget Management
 */

import type { CostTier } from '../types/context.js'
import { countTokens } from '../utils/tokenizer.js'

/**
 * Token budget configuration
 */
export interface TokenBudgetConfig {
  /** Total budget */
  total: number
  /** Limits per cost tier */
  tierLimits?: {
    cheap?: number
    medium?: number
    expensive?: number
  }
  /** Warning threshold (percentage) */
  warningThreshold?: number
}

/**
 * Full tier limits configuration
 */
interface FullTierLimits {
  cheap: number
  medium: number
  expensive: number
}

/**
 * Full configuration
 */
interface FullTokenBudgetConfig {
  total: number
  tierLimits: FullTierLimits
  warningThreshold: number
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  total: number
  byTier: {
    cheap: number
    medium: number
    expensive: number
  }
}

/**
 * Token Budget Manager
 */
export class TokenBudget {
  private config: FullTokenBudgetConfig
  private usage: TokenUsage = {
    total: 0,
    byTier: {
      cheap: 0,
      medium: 0,
      expensive: 0
    }
  }
  private onWarning?: (usage: TokenUsage, threshold: number) => void

  constructor(config: TokenBudgetConfig) {
    this.config = {
      total: config.total,
      tierLimits: {
        cheap: config.tierLimits?.cheap ?? config.total,
        medium: config.tierLimits?.medium ?? config.total * 0.7,
        expensive: config.tierLimits?.expensive ?? config.total * 0.3
      },
      warningThreshold: config.warningThreshold ?? 0.8
    }
  }

  /**
   * Set the warning callback
   */
  setWarningHandler(handler: (usage: TokenUsage, threshold: number) => void): void {
    this.onWarning = handler
  }

  /**
   * Check if the specified cost is affordable
   */
  canAfford(tier: CostTier, tokens?: number): boolean {
    const tierLimit = this.config.tierLimits[tier]
    const tierUsage = this.usage.byTier[tier]

    // If a specific token count is provided, check if it would exceed the limit
    if (tokens !== undefined) {
      if (tierUsage + tokens > tierLimit) {
        return false
      }
      if (this.usage.total + tokens > this.config.total) {
        return false
      }
    }

    // Check if current usage already exceeds the limit
    return tierUsage < tierLimit && this.usage.total < this.config.total
  }

  /**
   * Consume tokens
   */
  consume(tier: CostTier, tokens: number): void {
    this.usage.total += tokens
    this.usage.byTier[tier] += tokens

    // Check if the warning threshold is triggered
    const usageRatio = this.usage.total / this.config.total
    if (usageRatio >= this.config.warningThreshold && this.onWarning) {
      this.onWarning(this.getUsage(), this.config.warningThreshold)
    }
  }

  /**
   * Consume tokens for text content
   */
  consumeText(tier: CostTier, text: string): number {
    const tokens = countTokens(text)
    this.consume(tier, tokens)
    return tokens
  }

  /**
   * Get current usage
   */
  getUsage(): TokenUsage {
    return {
      total: this.usage.total,
      byTier: { ...this.usage.byTier }
    }
  }

  /**
   * Get remaining budget
   */
  getRemaining(): {
    total: number
    byTier: {
      cheap: number
      medium: number
      expensive: number
    }
  } {
    return {
      total: this.config.total - this.usage.total,
      byTier: {
        cheap: this.config.tierLimits.cheap - this.usage.byTier.cheap,
        medium: this.config.tierLimits.medium - this.usage.byTier.medium,
        expensive: this.config.tierLimits.expensive - this.usage.byTier.expensive
      }
    }
  }

  /**
   * Get usage percentage
   */
  getUsagePercentage(): {
    total: number
    byTier: {
      cheap: number
      medium: number
      expensive: number
    }
  } {
    return {
      total: (this.usage.total / this.config.total) * 100,
      byTier: {
        cheap: (this.usage.byTier.cheap / this.config.tierLimits.cheap) * 100,
        medium: (this.usage.byTier.medium / this.config.tierLimits.medium) * 100,
        expensive: (this.usage.byTier.expensive / this.config.tierLimits.expensive) * 100
      }
    }
  }

  /**
   * Reset usage
   */
  reset(): void {
    this.usage = {
      total: 0,
      byTier: {
        cheap: 0,
        medium: 0,
        expensive: 0
      }
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TokenBudgetConfig>): void {
    if (config.total !== undefined) {
      this.config.total = config.total
    }
    if (config.tierLimits) {
      Object.assign(this.config.tierLimits, config.tierLimits)
    }
    if (config.warningThreshold !== undefined) {
      this.config.warningThreshold = config.warningThreshold
    }
  }

  /**
   * Get configuration
   */
  getConfig(): FullTokenBudgetConfig {
    return { ...this.config }
  }
}
