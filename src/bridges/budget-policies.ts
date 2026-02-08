/**
 * Budget Policies
 *
 * Generates limit policies based on budget declarations
 */

import type {
  Policy,
  PolicyContext,
  GuardDecision,
  Transform
} from '../types/policy.js'
import type { ProviderBudgets } from '../types/provider.js'
import { defineGuardPolicy, defineMutatePolicy } from '../factories/define-policy.js'

/**
 * Timeout policy configuration
 */
export interface TimeoutPolicyConfig {
  /** Provider ID */
  providerId: string
  /** Timeout duration (milliseconds) */
  timeoutMs: number
  /** Policy priority */
  priority?: number
  /** Tools to apply this policy to */
  tools?: string[]
}

/**
 * Create a timeout policy
 *
 * Note: This is a Mutate policy that modifies tool input to add timeout parameters
 */
export function createTimeoutPolicy(config: TimeoutPolicyConfig): Policy {
  const { providerId, timeoutMs, priority = 50, tools } = config

  return defineMutatePolicy({
    id: `${providerId}.budget.timeout`,
    description: `Timeout limit for ${providerId}: ${timeoutMs}ms`,
    priority,
    match: (ctx: PolicyContext) => {
      // If a tool list is specified, only match those tools
      if (tools && tools.length > 0) {
        return tools.includes(ctx.tool)
      }
      // Otherwise match all tools
      return true
    },
    transforms: (ctx: PolicyContext): Transform[] => {
      const input = ctx.input as { timeout?: number } | undefined
      const currentTimeout = input?.timeout

      // Only apply when no timeout is set or the current timeout exceeds the limit
      if (currentTimeout === undefined || currentTimeout > timeoutMs) {
        return [{ op: 'set', path: 'timeout', value: timeoutMs }]
      }

      return []
    }
  })
}

/**
 * Output size limit policy configuration
 */
export interface OutputLimitPolicyConfig {
  /** Provider ID */
  providerId: string
  /** Maximum output bytes */
  maxBytes: number
  /** Policy priority */
  priority?: number
}

/**
 * Create an output size limit policy
 *
 * Note: This is a Mutate policy that modifies tool input to add limit parameters
 */
export function createOutputLimitPolicy(config: OutputLimitPolicyConfig): Policy {
  const { providerId, maxBytes, priority = 50 } = config

  return defineMutatePolicy({
    id: `${providerId}.budget.output`,
    description: `Output limit for ${providerId}: ${maxBytes} bytes`,
    priority,
    match: (ctx: PolicyContext) => {
      // Match tools that may produce large output
      return ['read', 'grep', 'glob', 'bash', 'fetch'].includes(ctx.tool)
    },
    transforms: (ctx: PolicyContext): Transform[] => {
      const transforms: Transform[] = []

      // For the read tool, limit line count
      if (ctx.tool === 'read') {
        const estimatedLinesLimit = Math.floor(maxBytes / 100) // Assuming ~100 bytes per line
        transforms.push({
          op: 'clamp',
          path: 'limit',
          max: estimatedLinesLimit
        })
      }

      // For the grep tool, limit result count
      if (ctx.tool === 'grep') {
        const estimatedMatchLimit = Math.floor(maxBytes / 200) // Assuming ~200 bytes per match
        transforms.push({
          op: 'clamp',
          path: 'limit',
          max: estimatedMatchLimit
        })
      }

      // For the glob tool, limit result count
      if (ctx.tool === 'glob') {
        const estimatedFileLimit = Math.floor(maxBytes / 50) // Assuming ~50 bytes per file path
        transforms.push({
          op: 'clamp',
          path: 'limit',
          max: estimatedFileLimit
        })
      }

      return transforms
    }
  })
}

/**
 * Request limit policy configuration
 */
export interface RequestLimitPolicyConfig {
  /** Provider ID */
  providerId: string
  /** Maximum number of requests */
  maxRequests: number
  /** Time window (milliseconds), defaults to 60000 (1 minute) */
  windowMs?: number
  /** Policy priority */
  priority?: number
  /** Tools to apply this policy to */
  tools?: string[]
}

/**
 * Request counter
 */
const requestCounters = new Map<string, { count: number; resetTime: number }>()

/**
 * Create a request limit policy
 */
export function createRequestLimitPolicy(config: RequestLimitPolicyConfig): Policy {
  const {
    providerId,
    maxRequests,
    windowMs = 60000,
    priority = 10,
    tools
  } = config

  const counterId = `${providerId}.requests`

  return defineGuardPolicy({
    id: `${providerId}.budget.requests`,
    description: `Request limit for ${providerId}: ${maxRequests} per ${windowMs}ms`,
    priority,
    match: (ctx: PolicyContext) => {
      if (tools && tools.length > 0) {
        return tools.includes(ctx.tool)
      }
      return true
    },
    decide: (_ctx: PolicyContext): GuardDecision => {
      const now = Date.now()
      let counter = requestCounters.get(counterId)

      // Check if the counter needs to be reset
      if (!counter || now >= counter.resetTime) {
        counter = { count: 0, resetTime: now + windowMs }
        requestCounters.set(counterId, counter)
      }

      // Check if the limit is exceeded
      if (counter.count >= maxRequests) {
        const remainingMs = counter.resetTime - now
        return {
          action: 'deny',
          reason: `[${providerId}] Request limit exceeded (${maxRequests} per ${windowMs}ms). Reset in ${Math.ceil(remainingMs / 1000)}s`
        }
      }

      // Increment the counter
      counter.count++

      return { action: 'allow' }
    }
  })
}

/**
 * Reset request counter (for testing)
 */
export function resetRequestCounter(providerId: string): void {
  requestCounters.delete(`${providerId}.requests`)
}

/**
 * Reset all request counters (for testing)
 */
export function resetAllRequestCounters(): void {
  requestCounters.clear()
}

/**
 * Create policies from budget declarations
 */
export function createBudgetPolicies(
  providerId: string,
  budgets: ProviderBudgets | undefined,
  priority?: number
): Policy[] {
  if (!budgets) {
    return []
  }

  const policies: Policy[] = []

  // Timeout policy
  if (budgets.timeoutMs !== undefined) {
    policies.push(
      createTimeoutPolicy({
        providerId,
        timeoutMs: budgets.timeoutMs,
        priority
      })
    )
  }

  // Output size limit policy
  if (budgets.maxOutputBytes !== undefined) {
    policies.push(
      createOutputLimitPolicy({
        providerId,
        maxBytes: budgets.maxOutputBytes,
        priority
      })
    )
  }

  // Request limit policy
  if (budgets.maxRequests !== undefined) {
    policies.push(
      createRequestLimitPolicy({
        providerId,
        maxRequests: budgets.maxRequests,
        priority
      })
    )
  }

  return policies
}
