/**
 * Retry System (RFC-005)
 *
 * Two retry modes:
 * - executor_retry: Transparent retry without LLM involvement (rate limits, transient network)
 * - agent_retry: Feed error back to LLM for corrective action (validation, execution)
 *
 * RetryBudget prevents infinite loops with per-category and total limits.
 */

import type { ErrorCategory, Recoverability, AgentError } from './errors.js'
import type { FeedbackBuilder } from './feedback.js'

// ============================================================================
// Types
// ============================================================================

/**
 * How retries are handled.
 * - executor_retry: Automatic retry, no LLM tokens spent
 * - agent_retry: Error fed back to LLM, LLM generates new attempt
 */
export type RetryMode = 'executor_retry' | 'agent_retry'

/**
 * Backoff strategy for retry delays.
 */
export type BackoffStrategy =
  | { type: 'none' }
  | { type: 'fixed'; delayMs: number }
  | { type: 'exponential'; baseMs: number; multiplier: number; maxMs?: number }
  | { type: 'custom'; compute: (attempt: number) => number }

/**
 * Strategy for a specific error category.
 */
export interface RetryStrategy {
  mode: RetryMode
  maxAttempts: number
  /** Backoff strategy (replaces flat backoffMs/backoffMultiplier) */
  backoff?: BackoffStrategy
  /** Custom predicate: should we retry this error at this attempt? */
  shouldRetry?: (error: AgentError, attempt: number, budget: RetryBudget) => boolean
  /** Custom feedback builder for this strategy */
  buildFeedback?: FeedbackBuilder
  /** @deprecated Use backoff instead. Backoff base in ms (for executor_retry) */
  backoffMs?: number
  /** @deprecated Use backoff instead. Exponential backoff multiplier */
  backoffMultiplier?: number
}

/**
 * Per-run retry budget to prevent infinite loops.
 */
export interface RetryBudgetConfig {
  maxTotalRetries: number
  maxConsecutiveSameCategory: number
  perCategory?: Partial<Record<ErrorCategory, number>>
}

/**
 * Tracks retry state during a single run.
 */
export class RetryBudget {
  private totalRetries = 0
  private categoryCounts: Partial<Record<ErrorCategory, number>> = {}
  private consecutiveSameCategory = 0
  private lastCategory: ErrorCategory | null = null

  constructor(private readonly config: RetryBudgetConfig) {}

  /**
   * Check if a retry is allowed for the given category.
   */
  canRetry(category: ErrorCategory, recoverability: Recoverability): boolean {
    // Non-recoverable errors are never retried
    if (recoverability === 'no') return false

    // Total budget exhausted
    if (this.totalRetries >= this.config.maxTotalRetries) return false

    // Per-category limit
    const categoryLimit = this.config.perCategory?.[category]
    if (categoryLimit !== undefined) {
      const count = this.categoryCounts[category] || 0
      if (count >= categoryLimit) return false
    }

    // Consecutive same-category limit
    if (category === this.lastCategory && this.consecutiveSameCategory >= this.config.maxConsecutiveSameCategory) {
      return false
    }

    return true
  }

  /**
   * Record a retry attempt.
   */
  record(category: ErrorCategory): void {
    this.totalRetries++
    this.categoryCounts[category] = (this.categoryCounts[category] || 0) + 1

    if (category === this.lastCategory) {
      this.consecutiveSameCategory++
    } else {
      this.consecutiveSameCategory = 1
      this.lastCategory = category
    }
  }

  /**
   * Get current retry stats.
   */
  stats(): { total: number; byCategory: Partial<Record<ErrorCategory, number>> } {
    return {
      total: this.totalRetries,
      byCategory: { ...this.categoryCounts }
    }
  }
}

// ============================================================================
// Backoff Computation
// ============================================================================

/**
 * Compute backoff delay in ms for a given strategy and attempt number.
 */
export function computeBackoff(strategy: BackoffStrategy | undefined, attempt: number): number {
  if (!strategy) return 0
  switch (strategy.type) {
    case 'none':
      return 0
    case 'fixed':
      return strategy.delayMs
    case 'exponential': {
      const delay = strategy.baseMs * Math.pow(strategy.multiplier, attempt)
      return strategy.maxMs ? Math.min(delay, strategy.maxMs) : delay
    }
    case 'custom':
      return strategy.compute(attempt)
  }
}

/**
 * Default shouldRetry predicate: checks budget + recoverability.
 */
export function defaultShouldRetry(
  error: AgentError,
  _attempt: number,
  budget: RetryBudget
): boolean {
  return budget.canRetry(error.category, error.recoverability)
}

// ============================================================================
// Strategy Resolution
// ============================================================================

/**
 * Default retry strategies per error category.
 */
export const DEFAULT_STRATEGIES: Record<ErrorCategory, RetryStrategy> = {
  validation:        { mode: 'agent_retry',    maxAttempts: 3 },
  execution:         { mode: 'agent_retry',    maxAttempts: 3 },
  timeout:           { mode: 'executor_retry', maxAttempts: 2, backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 }, backoffMs: 1000, backoffMultiplier: 2 },
  rate_limit:        { mode: 'executor_retry', maxAttempts: 5, backoff: { type: 'exponential', baseMs: 2000, multiplier: 2 }, backoffMs: 2000, backoffMultiplier: 2 },
  auth:              { mode: 'agent_retry',    maxAttempts: 1 },
  policy_denied:     { mode: 'agent_retry',    maxAttempts: 1 },
  context_overflow:  { mode: 'agent_retry',    maxAttempts: 2 },
  malformed_output:  { mode: 'agent_retry',    maxAttempts: 2 },
  resource:          { mode: 'agent_retry',    maxAttempts: 2 },
  transient_network: { mode: 'executor_retry', maxAttempts: 3, backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 }, backoffMs: 1000, backoffMultiplier: 2 },
  unknown:           { mode: 'agent_retry',    maxAttempts: 1 }
}

/**
 * Default retry budget config.
 */
export const DEFAULT_BUDGET_CONFIG: RetryBudgetConfig = {
  maxTotalRetries: 10,
  maxConsecutiveSameCategory: 3,
  perCategory: {
    auth: 1,
    policy_denied: 1,
    rate_limit: 5
  }
}

/**
 * Get the retry strategy for a given error category.
 */
export function getStrategy(
  category: ErrorCategory,
  overrides?: Partial<Record<ErrorCategory, Partial<RetryStrategy>>>
): RetryStrategy {
  const base = DEFAULT_STRATEGIES[category]
  const override = overrides?.[category]
  if (!override) return base
  return { ...base, ...override }
}

// ============================================================================
// Core Retry Executor
// ============================================================================

/**
 * Options for the withRetryExecutor function.
 */
export interface WithRetryOptions {
  /** Maximum number of attempts (including the first) */
  maxAttempts: number
  /** Backoff strategy between attempts */
  backoff?: BackoffStrategy
  /** Budget tracker (optional, will create one if not provided) */
  budget?: RetryBudget
  /** Custom shouldRetry predicate */
  shouldRetry?: (error: AgentError, attempt: number, budget: RetryBudget) => boolean
  /** Callback when a retry occurs */
  onRetry?: (error: AgentError, attempt: number) => void
}

/**
 * Core retry executor — wraps any async function with executor-level retry logic.
 *
 * This implements the RFC-005 executor_retry path:
 * - Classifies errors automatically
 * - Respects retry budgets
 * - Computes backoff delays
 * - Transparent to the LLM (no tokens consumed)
 *
 * Agent-retry (feeding errors back to the LLM) is handled by the agent loop,
 * not by this function. The loop naturally implements agent-retry: tool error →
 * structured feedback in tool result → LLM sees it → LLM decides next action.
 *
 * Returns the successful result or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions
): Promise<T> {
  const budget = options.budget ?? new RetryBudget(DEFAULT_BUDGET_CONFIG)
  const shouldRetryFn = options.shouldRetry ?? defaultShouldRetry
  let lastError: unknown
  let lastAgentError: AgentError | undefined

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Import classifyError lazily to avoid circular dependency at module load
      const { classifyError } = await import('./errors.js')
      const agentError = classifyError(
        err instanceof Error ? err : String(err)
      )
      agentError.attempt = attempt + 1
      lastAgentError = agentError

      if (attempt < options.maxAttempts - 1) {
        if (!shouldRetryFn(agentError, attempt + 1, budget)) {
          break
        }

        budget.record(agentError.category)
        options.onRetry?.(agentError, attempt + 1)

        const delay = computeBackoff(options.backoff, attempt)
        if (delay > 0) {
          await sleep(delay)
        }
      }
    }
  }

  // Attach classified error info for callers that need it
  if (lastAgentError && lastError instanceof Error) {
    ;(lastError as any).agentError = lastAgentError
  }

  throw lastError
}

// ============================================================================
// Retry Presets
// ============================================================================

/**
 * Pre-configured retry option sets for common scenarios.
 */
export const RetryPresets = {
  /** No retries at all */
  none(): WithRetryOptions {
    return { maxAttempts: 1 }
  },

  /** Retry transient errors (network, rate limit) with exponential backoff */
  transient(): WithRetryOptions {
    return {
      maxAttempts: 3,
      backoff: { type: 'exponential', baseMs: 1000, multiplier: 2, maxMs: 10000 }
    }
  },

  /** Budget-aware retry with exponential backoff */
  smart(budget?: RetryBudget): WithRetryOptions {
    return {
      maxAttempts: 5,
      backoff: { type: 'exponential', baseMs: 500, multiplier: 2, maxMs: 15000 },
      budget: budget ?? new RetryBudget(DEFAULT_BUDGET_CONFIG)
    }
  }
} as const

// ============================================================================
// Legacy Executor Retry (transparent, no LLM)
// ============================================================================

/**
 * Execute a function with transparent executor retries.
 * Used for rate limits, transient network errors — no LLM tokens spent.
 *
 * @deprecated Use withRetry() with appropriate options instead.
 */
export async function withExecutorRetry<T>(
  fn: () => Promise<T>,
  strategy: RetryStrategy
): Promise<T> {
  let lastError: unknown
  const { maxAttempts, backoffMs = 1000, backoffMultiplier = 2 } = strategy

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts - 1) {
        const delay = backoffMs * Math.pow(backoffMultiplier, attempt)
        await sleep(delay)
      }
    }
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
