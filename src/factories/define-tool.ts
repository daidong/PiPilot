/**
 * defineTool - 工具定义工厂
 */

import type { Tool, ToolConfig, ToolContext, ToolResult } from '../types/tool.js'
import { classifyError } from '../core/errors.js'
import type { AgentError } from '../core/errors.js'
import { buildFeedback, formatFeedbackAsToolResult } from '../core/feedback.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG, getStrategy, computeBackoff } from '../core/retry.js'
import type { RetryStrategy } from '../core/retry.js'

/**
 * 定义工具
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  config: ToolConfig<TInput, TOutput>
): Tool<TInput, TOutput> {
  // 验证配置
  if (!config.name) {
    throw new Error('Tool name is required')
  }

  if (!config.description) {
    throw new Error('Tool description is required')
  }

  if (!config.execute) {
    throw new Error('Tool execute function is required')
  }

  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
    ...(config.activity ? { activity: config.activity } : {})
  }
}

/**
 * 创建工具包装器，添加错误处理
 */
export function withErrorHandling<TInput, TOutput>(
  tool: Tool<TInput, TOutput>
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      try {
        return await tool.execute(input, context)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `Tool execution failed: ${errorMessage}`
        }
      }
    }
  }
}

/**
 * 创建工具包装器，添加超时
 */
export function withTimeout<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  timeoutMs: number
): Tool<TInput, TOutput> {
  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      const timeoutPromise = new Promise<ToolResult<TOutput>>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool ${tool.name} timed out after ${timeoutMs}ms`)), timeoutMs)
      })

      try {
        return await Promise.race([tool.execute(input, context), timeoutPromise])
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: errorMessage
        }
      }
    }
  }
}

/**
 * Create a tool wrapper with retry support.
 *
 * Uses the structured error system (RFC-005):
 * - Classifies errors into categories (validation, execution, rate_limit, etc.)
 * - Uses per-category retry strategies (executor_retry vs agent_retry)
 * - Tracks retry budget to prevent infinite loops
 * - Provides structured feedback in error messages
 *
 * Accepts either:
 * - (tool, maxRetries, delayMs) — backwards compat
 * - (tool, retryStrategy) — new API with full RetryStrategy
 */
export function withRetry<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  maxRetriesOrStrategy: number | RetryStrategy = 3,
  delayMs: number = 1000
): Tool<TInput, TOutput> {
  // Resolve params: new RetryStrategy or legacy (maxRetries, delayMs)
  let maxRetries: number
  let resolveBackoff: (category: AgentError, attempt: number) => number
  let shouldRetryFn: ((error: AgentError, attempt: number, budget: RetryBudget) => boolean) | undefined
  let feedbackBuilder: ((error: AgentError) => import('../core/feedback.js').ErrorFeedback) | undefined

  if (typeof maxRetriesOrStrategy === 'object') {
    const strat = maxRetriesOrStrategy
    maxRetries = strat.maxAttempts - 1
    shouldRetryFn = strat.shouldRetry
    feedbackBuilder = strat.buildFeedback ? (err: AgentError) => strat.buildFeedback!(err) : undefined
    resolveBackoff = (_err, attempt) => {
      if (strat.backoff) return computeBackoff(strat.backoff, attempt)
      // Fallback to legacy fields
      const base = strat.backoffMs ?? delayMs
      const mult = strat.backoffMultiplier ?? 2
      return base * Math.pow(mult, attempt)
    }
  } else {
    maxRetries = maxRetriesOrStrategy
    resolveBackoff = (err, attempt) => {
      const strategy = getStrategy(err.category)
      if (strategy.backoff) return computeBackoff(strategy.backoff, attempt)
      const base = strategy.backoffMs ?? delayMs
      const mult = strategy.backoffMultiplier ?? 2
      return base * Math.pow(mult, attempt)
    }
  }

  return {
    ...tool,
    execute: async (input: TInput, context: ToolContext): Promise<ToolResult<TOutput>> => {
      let lastError: string | undefined
      let lastAgentError: AgentError | undefined
      const budget = new RetryBudget(DEFAULT_BUDGET_CONFIG)

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await tool.execute(input, context)
          if (result.success) {
            return result
          }
          lastError = result.error
          lastAgentError = classifyError(result.error || 'Unknown error', { toolName: tool.name })
          lastAgentError.attempt = attempt + 1
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          lastAgentError = classifyError(error instanceof Error ? error : lastError, { toolName: tool.name })
          lastAgentError.attempt = attempt + 1
        }

        // Check retry budget before continuing
        if (attempt < maxRetries && lastAgentError) {
          const canRetry = shouldRetryFn
            ? shouldRetryFn(lastAgentError, attempt + 1, budget)
            : budget.canRetry(lastAgentError.category, lastAgentError.recoverability)
          if (!canRetry) {
            break
          }
          budget.record(lastAgentError.category)

          const backoffMs = resolveBackoff(lastAgentError, attempt)
          if (backoffMs > 0) {
            await new Promise(resolve => setTimeout(resolve, backoffMs))
          }
        }
      }

      // Return structured feedback in the error message
      if (lastAgentError) {
        const feedback = feedbackBuilder
          ? feedbackBuilder(lastAgentError)
          : buildFeedback(lastAgentError)
        return {
          success: false,
          error: formatFeedbackAsToolResult(feedback)
        }
      }

      return {
        success: false,
        error: `Failed after ${maxRetries + 1} attempts: ${lastError}`
      }
    }
  }
}

/**
 * 组合多个工具增强器
 */
export function composeTool<TInput, TOutput>(
  tool: Tool<TInput, TOutput>,
  ...enhancers: Array<(t: Tool<TInput, TOutput>) => Tool<TInput, TOutput>>
): Tool<TInput, TOutput> {
  return enhancers.reduce((t, enhancer) => enhancer(t), tool)
}
