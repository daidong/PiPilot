/**
 * Tests for the retry system (RFC-005)
 */

import { describe, it, expect } from 'vitest'
import {
  RetryBudget,
  DEFAULT_STRATEGIES,
  DEFAULT_BUDGET_CONFIG,
  getStrategy,
  withExecutorRetry,
  computeBackoff,
  defaultShouldRetry,
  withRetry,
  RetryPresets
} from '../../src/core/retry.js'
import type { BackoffStrategy } from '../../src/core/retry.js'

describe('RetryBudget', () => {
  it('should allow retries within budget', () => {
    const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)
    expect(budget.canRetry('validation', 'yes')).toBe(true)
  })

  it('should reject non-recoverable errors', () => {
    const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)
    expect(budget.canRetry('auth', 'no')).toBe(false)
  })

  it('should enforce total retry limit', () => {
    const budget = new RetryBudget({ maxTotalRetries: 2, maxConsecutiveSameCategory: 10 })
    budget.record('validation')
    budget.record('execution')
    expect(budget.canRetry('validation', 'yes')).toBe(false)
  })

  it('should enforce consecutive same-category limit', () => {
    const budget = new RetryBudget({ maxTotalRetries: 100, maxConsecutiveSameCategory: 2 })
    budget.record('validation')
    budget.record('validation')
    expect(budget.canRetry('validation', 'yes')).toBe(false)
    // Different category should still work
    expect(budget.canRetry('execution', 'yes')).toBe(true)
  })

  it('should enforce per-category limits', () => {
    const budget = new RetryBudget({
      maxTotalRetries: 100,
      maxConsecutiveSameCategory: 100,
      perCategory: { auth: 1 }
    })
    budget.record('auth')
    expect(budget.canRetry('auth', 'yes')).toBe(false)
  })

  it('should reset consecutive counter on category change', () => {
    const budget = new RetryBudget({ maxTotalRetries: 100, maxConsecutiveSameCategory: 2 })
    budget.record('validation')
    budget.record('validation')
    budget.record('execution') // resets consecutive
    budget.record('validation')
    expect(budget.canRetry('validation', 'yes')).toBe(true) // only 1 consecutive now
  })

  it('should report stats', () => {
    const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)
    budget.record('validation')
    budget.record('execution')
    budget.record('validation')
    const stats = budget.stats()
    expect(stats.total).toBe(3)
    expect(stats.byCategory.validation).toBe(2)
    expect(stats.byCategory.execution).toBe(1)
  })
})

describe('DEFAULT_STRATEGIES', () => {
  it('should have strategies for all categories', () => {
    const categories = [
      'validation', 'execution', 'timeout', 'rate_limit', 'auth',
      'policy_denied', 'context_overflow', 'malformed_output',
      'resource', 'transient_network', 'unknown'
    ] as const

    for (const cat of categories) {
      expect(DEFAULT_STRATEGIES[cat]).toBeDefined()
      expect(DEFAULT_STRATEGIES[cat].mode).toMatch(/^(executor_retry|agent_retry)$/)
      expect(DEFAULT_STRATEGIES[cat].maxAttempts).toBeGreaterThan(0)
    }
  })

  it('should use executor_retry for transient errors', () => {
    expect(DEFAULT_STRATEGIES.rate_limit.mode).toBe('executor_retry')
    expect(DEFAULT_STRATEGIES.transient_network.mode).toBe('executor_retry')
    expect(DEFAULT_STRATEGIES.timeout.mode).toBe('executor_retry')
  })

  it('should use agent_retry for logic errors', () => {
    expect(DEFAULT_STRATEGIES.validation.mode).toBe('agent_retry')
    expect(DEFAULT_STRATEGIES.execution.mode).toBe('agent_retry')
  })

  it('should have BackoffStrategy on executor_retry strategies', () => {
    expect(DEFAULT_STRATEGIES.rate_limit.backoff).toBeDefined()
    expect(DEFAULT_STRATEGIES.rate_limit.backoff!.type).toBe('exponential')
    expect(DEFAULT_STRATEGIES.transient_network.backoff).toBeDefined()
  })
})

describe('getStrategy', () => {
  it('should return default strategy', () => {
    const strategy = getStrategy('validation')
    expect(strategy).toEqual(DEFAULT_STRATEGIES.validation)
  })

  it('should merge overrides', () => {
    const strategy = getStrategy('validation', { validation: { maxAttempts: 5 } })
    expect(strategy.maxAttempts).toBe(5)
    expect(strategy.mode).toBe('agent_retry') // preserved from default
  })
})

describe('computeBackoff', () => {
  it('should return 0 for none strategy', () => {
    expect(computeBackoff({ type: 'none' }, 0)).toBe(0)
  })

  it('should return fixed delay', () => {
    expect(computeBackoff({ type: 'fixed', delayMs: 500 }, 0)).toBe(500)
    expect(computeBackoff({ type: 'fixed', delayMs: 500 }, 3)).toBe(500)
  })

  it('should compute exponential backoff', () => {
    const strategy: BackoffStrategy = { type: 'exponential', baseMs: 100, multiplier: 2 }
    expect(computeBackoff(strategy, 0)).toBe(100)
    expect(computeBackoff(strategy, 1)).toBe(200)
    expect(computeBackoff(strategy, 2)).toBe(400)
  })

  it('should cap exponential backoff at maxMs', () => {
    const strategy: BackoffStrategy = { type: 'exponential', baseMs: 100, multiplier: 2, maxMs: 300 }
    expect(computeBackoff(strategy, 0)).toBe(100)
    expect(computeBackoff(strategy, 1)).toBe(200)
    expect(computeBackoff(strategy, 2)).toBe(300) // capped
    expect(computeBackoff(strategy, 10)).toBe(300) // still capped
  })

  it('should use custom compute function', () => {
    const strategy: BackoffStrategy = { type: 'custom', compute: (n) => n * 50 }
    expect(computeBackoff(strategy, 0)).toBe(0)
    expect(computeBackoff(strategy, 3)).toBe(150)
  })

  it('should return 0 for undefined strategy', () => {
    expect(computeBackoff(undefined, 0)).toBe(0)
  })
})

describe('defaultShouldRetry', () => {
  it('should delegate to budget.canRetry', () => {
    const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)
    const error = {
      category: 'validation' as const,
      source: { kind: 'tool' as const, toolName: 'x' },
      message: 'bad',
      recoverability: 'yes' as const
    }
    expect(defaultShouldRetry(error, 1, budget)).toBe(true)
  })
})

describe('withRetry', () => {
  it('should succeed on first try', async () => {
    let calls = 0
    const result = await withRetry(
      async () => { calls++; return 'ok' },
      { maxAttempts: 3 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('should retry and succeed', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('fail')
        return 'ok'
      },
      { maxAttempts: 3, backoff: { type: 'none' } }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('should throw after exhausting attempts', async () => {
    await expect(
      withRetry(
        async () => { throw new Error('always fails') },
        { maxAttempts: 2, backoff: { type: 'none' } }
      )
    ).rejects.toThrow('always fails')
  })

  it('should call onRetry callback', async () => {
    const retries: number[] = []
    try {
      await withRetry(
        async () => { throw new Error('fail') },
        {
          maxAttempts: 3,
          backoff: { type: 'none' },
          onRetry: (_err, attempt) => retries.push(attempt)
        }
      )
    } catch { /* expected */ }
    expect(retries).toEqual([1, 2])
  })
})

describe('RetryPresets', () => {
  it('none should have maxAttempts=1', () => {
    const opts = RetryPresets.none()
    expect(opts.maxAttempts).toBe(1)
  })

  it('transient should use exponential backoff', () => {
    const opts = RetryPresets.transient()
    expect(opts.maxAttempts).toBe(3)
    expect(opts.backoff?.type).toBe('exponential')
  })

  it('smart should include budget and exponential backoff', () => {
    const opts = RetryPresets.smart()
    expect(opts.maxAttempts).toBe(5)
    expect(opts.budget).toBeDefined()
    expect(opts.backoff?.type).toBe('exponential')
  })
})

describe('withExecutorRetry', () => {
  it('should succeed on first try', async () => {
    let calls = 0
    const result = await withExecutorRetry(
      async () => { calls++; return 'ok' },
      { mode: 'executor_retry', maxAttempts: 3, backoffMs: 1 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('should retry on failure and succeed', async () => {
    let calls = 0
    const result = await withExecutorRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('fail')
        return 'ok'
      },
      { mode: 'executor_retry', maxAttempts: 3, backoffMs: 1, backoffMultiplier: 1 }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('should throw after exhausting attempts', async () => {
    await expect(
      withExecutorRetry(
        async () => { throw new Error('always fails') },
        { mode: 'executor_retry', maxAttempts: 2, backoffMs: 1, backoffMultiplier: 1 }
      )
    ).rejects.toThrow('always fails')
  })
})
