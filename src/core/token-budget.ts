/**
 * TokenBudget - Token 预算管理
 */

import type { CostTier } from '../types/context.js'
import { countTokens } from '../utils/tokenizer.js'

/**
 * Token 预算配置
 */
export interface TokenBudgetConfig {
  /** 总预算 */
  total: number
  /** 各成本等级的限制 */
  tierLimits?: {
    cheap?: number
    medium?: number
    expensive?: number
  }
  /** 警告阈值（百分比） */
  warningThreshold?: number
}

/**
 * 完整的 tier 限制配置
 */
interface FullTierLimits {
  cheap: number
  medium: number
  expensive: number
}

/**
 * 完整的配置
 */
interface FullTokenBudgetConfig {
  total: number
  tierLimits: FullTierLimits
  warningThreshold: number
}

/**
 * Token 使用统计
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
 * Token 预算管理器
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
   * 设置警告回调
   */
  setWarningHandler(handler: (usage: TokenUsage, threshold: number) => void): void {
    this.onWarning = handler
  }

  /**
   * 检查是否能承担指定成本
   */
  canAfford(tier: CostTier, tokens?: number): boolean {
    const tierLimit = this.config.tierLimits[tier]
    const tierUsage = this.usage.byTier[tier]

    // 如果提供了具体 token 数，检查是否会超出
    if (tokens !== undefined) {
      if (tierUsage + tokens > tierLimit) {
        return false
      }
      if (this.usage.total + tokens > this.config.total) {
        return false
      }
    }

    // 检查当前使用是否已超出
    return tierUsage < tierLimit && this.usage.total < this.config.total
  }

  /**
   * 消费 token
   */
  consume(tier: CostTier, tokens: number): void {
    this.usage.total += tokens
    this.usage.byTier[tier] += tokens

    // 检查是否触发警告
    const usageRatio = this.usage.total / this.config.total
    if (usageRatio >= this.config.warningThreshold && this.onWarning) {
      this.onWarning(this.getUsage(), this.config.warningThreshold)
    }
  }

  /**
   * 消费文本内容的 token
   */
  consumeText(tier: CostTier, text: string): number {
    const tokens = countTokens(text)
    this.consume(tier, tokens)
    return tokens
  }

  /**
   * 获取当前使用情况
   */
  getUsage(): TokenUsage {
    return {
      total: this.usage.total,
      byTier: { ...this.usage.byTier }
    }
  }

  /**
   * 获取剩余预算
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
   * 获取使用百分比
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
   * 重置使用情况
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
   * 更新配置
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
   * 获取配置
   */
  getConfig(): FullTokenBudgetConfig {
    return { ...this.config }
  }
}
