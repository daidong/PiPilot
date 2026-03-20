/**
 * TokenTracker - Comprehensive token usage tracking
 *
 * Tracks token usage, calculates costs, and emits events for UI consumption.
 * Provides run/step/session level aggregation.
 */

import type { DetailedTokenUsage, TokenCost, UsageSummary } from '../llm/provider.types.js'
import {
  calculateCost,
  aggregateCosts,
  aggregateUsage,
  calculateCacheHitRate
} from '../llm/cost-calculator.js'

/**
 * TokenTracker configuration
 */
export interface TokenTrackerConfig {
  /** Emit warning when run cost exceeds this threshold (USD). Default: $1.00 */
  costWarningThreshold?: number
  /** Emit warning when run tokens exceed this threshold. Default: 100,000 */
  tokenWarningThreshold?: number
  /** Target cache hit rate for efficiency warnings. Default: 0.3 (30%) */
  minCacheHitRate?: number
}

/**
 * Usage event types
 */
export type UsageEventType =
  | 'usage.call'     // Per-LLM-call usage
  | 'usage.step'     // Per-step cumulative
  | 'usage.run'      // Run summary
  | 'usage.warning'  // Threshold warnings

/**
 * Usage event data
 */
export interface UsageEvent {
  type: UsageEventType
  runId: string
  stepIndex?: number
  usage?: DetailedTokenUsage
  cost?: TokenCost
  summary?: UsageSummary
  warning?: {
    type: 'cost' | 'tokens' | 'cache_miss'
    message: string
    threshold: number
    actual: number
  }
}

/**
 * Event handler type
 */
export type UsageEventHandler = (event: UsageEvent) => void

/**
 * Step record for tracking
 */
interface StepRecord {
  usages: DetailedTokenUsage[]
  costs: TokenCost[]
  startTime: number
}

/**
 * TokenTracker class
 *
 * Tracks token usage across LLM calls, steps, and runs.
 * Emits events for UI consumption.
 */
export class TokenTracker {
  private config: Required<TokenTrackerConfig>
  private handlers: Map<UsageEventType | '*', Set<UsageEventHandler>> = new Map()

  // Current run state
  private currentRunId: string | null = null
  private runStartTime: number = 0
  private stepIndex: number = 0
  private steps: StepRecord[] = []

  // Cumulative tracking
  private allUsages: DetailedTokenUsage[] = []
  private allCosts: TokenCost[] = []

  constructor(config: TokenTrackerConfig = {}) {
    this.config = {
      costWarningThreshold: config.costWarningThreshold ?? 1.0,
      tokenWarningThreshold: config.tokenWarningThreshold ?? 100_000,
      minCacheHitRate: config.minCacheHitRate ?? 0.3
    }
  }

  /**
   * Start tracking a new run
   */
  startRun(runId: string): void {
    this.currentRunId = runId
    this.runStartTime = Date.now()
    this.stepIndex = 0
    this.steps = [this.createStepRecord()]
    this.allUsages = []
    this.allCosts = []
  }

  /**
   * Record usage from an LLM call
   */
  recordCall(modelId: string, usage: DetailedTokenUsage): TokenCost {
    const cost = calculateCost(modelId, usage)

    // Add to current step
    const currentStep = this.steps[this.stepIndex]
    if (currentStep) {
      currentStep.usages.push(usage)
      currentStep.costs.push(cost)
    }

    // Add to cumulative tracking
    this.allUsages.push(usage)
    this.allCosts.push(cost)

    // Emit per-call event
    this.emit({
      type: 'usage.call',
      runId: this.currentRunId || '',
      stepIndex: this.stepIndex,
      usage,
      cost
    })

    // Check thresholds
    this.checkThresholds()

    return cost
  }

  /**
   * Advance to the next step
   */
  advanceStep(): void {
    // Emit step summary
    const currentStep = this.steps[this.stepIndex]
    if (currentStep && currentStep.usages.length > 0) {
      this.emit({
        type: 'usage.step',
        runId: this.currentRunId || '',
        stepIndex: this.stepIndex,
        usage: aggregateUsage(currentStep.usages),
        cost: aggregateCosts(currentStep.costs)
      })
    }

    this.stepIndex++
    this.steps.push(this.createStepRecord())
  }

  /**
   * Complete the current run and return summary
   */
  completeRun(): UsageSummary {
    const durationMs = Date.now() - this.runStartTime
    const tokens = aggregateUsage(this.allUsages)
    const cost = aggregateCosts(this.allCosts)
    const cacheHitRate = calculateCacheHitRate(tokens)

    const summary: UsageSummary = {
      tokens,
      cost,
      callCount: this.allUsages.length,
      cacheHitRate,
      durationMs
    }

    // Emit run summary
    this.emit({
      type: 'usage.run',
      runId: this.currentRunId || '',
      summary
    })

    // Check for low cache hit rate warning
    if (cacheHitRate < this.config.minCacheHitRate && this.allUsages.length > 1) {
      this.emit({
        type: 'usage.warning',
        runId: this.currentRunId || '',
        warning: {
          type: 'cache_miss',
          message: `Low cache hit rate: ${(cacheHitRate * 100).toFixed(1)}% (target: ${this.config.minCacheHitRate * 100}%)`,
          threshold: this.config.minCacheHitRate,
          actual: cacheHitRate
        }
      })
    }

    return summary
  }

  /**
   * Subscribe to events
   *
   * @param event - Event type or '*' for all events
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  on(event: UsageEventType | '*', handler: UsageEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  /**
   * Get cumulative token usage for the current run
   */
  getCumulativeUsage(): DetailedTokenUsage {
    return aggregateUsage(this.allUsages)
  }

  /**
   * Get cumulative cost for the current run
   */
  getCumulativeCost(): TokenCost {
    return aggregateCosts(this.allCosts)
  }

  /**
   * Get current cache hit rate
   */
  getCacheHitRate(): number {
    return calculateCacheHitRate(aggregateUsage(this.allUsages))
  }

  /**
   * Get current summary (without completing the run)
   */
  getSummary(): UsageSummary {
    const tokens = aggregateUsage(this.allUsages)
    return {
      tokens,
      cost: aggregateCosts(this.allCosts),
      callCount: this.allUsages.length,
      cacheHitRate: calculateCacheHitRate(tokens),
      durationMs: Date.now() - this.runStartTime
    }
  }

  /**
   * Get call count
   */
  getCallCount(): number {
    return this.allUsages.length
  }

  /**
   * Get current step index
   */
  getCurrentStep(): number {
    return this.stepIndex
  }

  // Private helpers

  private createStepRecord(): StepRecord {
    return {
      usages: [],
      costs: [],
      startTime: Date.now()
    }
  }

  private emit(event: UsageEvent): void {
    // Emit to specific handlers
    this.handlers.get(event.type)?.forEach(handler => handler(event))
    // Emit to wildcard handlers
    this.handlers.get('*')?.forEach(handler => handler(event))
  }

  private checkThresholds(): void {
    const cumCost = aggregateCosts(this.allCosts)
    const cumUsage = aggregateUsage(this.allUsages)

    // Check cost threshold
    if (cumCost.totalCost >= this.config.costWarningThreshold) {
      this.emit({
        type: 'usage.warning',
        runId: this.currentRunId || '',
        warning: {
          type: 'cost',
          message: `Run cost exceeded threshold: $${cumCost.totalCost.toFixed(4)} >= $${this.config.costWarningThreshold.toFixed(2)}`,
          threshold: this.config.costWarningThreshold,
          actual: cumCost.totalCost
        }
      })
    }

    // Check token threshold
    if (cumUsage.totalTokens >= this.config.tokenWarningThreshold) {
      this.emit({
        type: 'usage.warning',
        runId: this.currentRunId || '',
        warning: {
          type: 'tokens',
          message: `Run tokens exceeded threshold: ${cumUsage.totalTokens.toLocaleString()} >= ${this.config.tokenWarningThreshold.toLocaleString()}`,
          threshold: this.config.tokenWarningThreshold,
          actual: cumUsage.totalTokens
        }
      })
    }
  }
}

/**
 * Create a new TokenTracker instance
 */
export function createTokenTracker(config?: TokenTrackerConfig): TokenTracker {
  return new TokenTracker(config)
}
