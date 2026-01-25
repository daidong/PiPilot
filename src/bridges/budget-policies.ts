/**
 * Budget Policies
 *
 * 根据预算声明生成限制策略
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
 * 超时策略配置
 */
export interface TimeoutPolicyConfig {
  /** Provider ID */
  providerId: string
  /** 超时时间（毫秒） */
  timeoutMs: number
  /** 策略优先级 */
  priority?: number
  /** 应用到哪些工具 */
  tools?: string[]
}

/**
 * 创建超时策略
 *
 * 注意：这是一个 Mutate 策略，会修改工具输入添加超时参数
 */
export function createTimeoutPolicy(config: TimeoutPolicyConfig): Policy {
  const { providerId, timeoutMs, priority = 50, tools } = config

  return defineMutatePolicy({
    id: `${providerId}.budget.timeout`,
    description: `Timeout limit for ${providerId}: ${timeoutMs}ms`,
    priority,
    match: (ctx: PolicyContext) => {
      // 如果指定了工具列表，只匹配这些工具
      if (tools && tools.length > 0) {
        return tools.includes(ctx.tool)
      }
      // 否则匹配所有工具
      return true
    },
    transforms: (ctx: PolicyContext): Transform[] => {
      const input = ctx.input as { timeout?: number } | undefined
      const currentTimeout = input?.timeout

      // 只有当没有设置超时或设置的超时大于限制时才应用
      if (currentTimeout === undefined || currentTimeout > timeoutMs) {
        return [{ op: 'set', path: 'timeout', value: timeoutMs }]
      }

      return []
    }
  })
}

/**
 * 输出大小限制策略配置
 */
export interface OutputLimitPolicyConfig {
  /** Provider ID */
  providerId: string
  /** 最大输出字节数 */
  maxBytes: number
  /** 策略优先级 */
  priority?: number
}

/**
 * 创建输出大小限制策略
 *
 * 注意：这是一个 Mutate 策略，会修改工具输入添加限制参数
 */
export function createOutputLimitPolicy(config: OutputLimitPolicyConfig): Policy {
  const { providerId, maxBytes, priority = 50 } = config

  return defineMutatePolicy({
    id: `${providerId}.budget.output`,
    description: `Output limit for ${providerId}: ${maxBytes} bytes`,
    priority,
    match: (ctx: PolicyContext) => {
      // 匹配可能产生大输出的工具
      return ['read', 'grep', 'glob', 'bash', 'fetch'].includes(ctx.tool)
    },
    transforms: (ctx: PolicyContext): Transform[] => {
      const transforms: Transform[] = []

      // 对于 read 工具，限制行数
      if (ctx.tool === 'read') {
        const estimatedLinesLimit = Math.floor(maxBytes / 100) // 假设每行平均 100 字节
        transforms.push({
          op: 'clamp',
          path: 'limit',
          max: estimatedLinesLimit
        })
      }

      // 对于 grep 工具，限制结果数
      if (ctx.tool === 'grep') {
        const estimatedMatchLimit = Math.floor(maxBytes / 200) // 假设每个匹配平均 200 字节
        transforms.push({
          op: 'clamp',
          path: 'limit',
          max: estimatedMatchLimit
        })
      }

      // 对于 glob 工具，限制结果数
      if (ctx.tool === 'glob') {
        const estimatedFileLimit = Math.floor(maxBytes / 50) // 假设每个文件路径平均 50 字节
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
 * 请求次数限制策略配置
 */
export interface RequestLimitPolicyConfig {
  /** Provider ID */
  providerId: string
  /** 最大请求次数 */
  maxRequests: number
  /** 时间窗口（毫秒），默认 60000 (1分钟) */
  windowMs?: number
  /** 策略优先级 */
  priority?: number
  /** 应用到哪些工具 */
  tools?: string[]
}

/**
 * 请求计数器
 */
const requestCounters = new Map<string, { count: number; resetTime: number }>()

/**
 * 创建请求次数限制策略
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

      // 检查是否需要重置计数器
      if (!counter || now >= counter.resetTime) {
        counter = { count: 0, resetTime: now + windowMs }
        requestCounters.set(counterId, counter)
      }

      // 检查是否超过限制
      if (counter.count >= maxRequests) {
        const remainingMs = counter.resetTime - now
        return {
          action: 'deny',
          reason: `[${providerId}] Request limit exceeded (${maxRequests} per ${windowMs}ms). Reset in ${Math.ceil(remainingMs / 1000)}s`
        }
      }

      // 增加计数
      counter.count++

      return { action: 'allow' }
    }
  })
}

/**
 * 重置请求计数器（用于测试）
 */
export function resetRequestCounter(providerId: string): void {
  requestCounters.delete(`${providerId}.requests`)
}

/**
 * 重置所有请求计数器（用于测试）
 */
export function resetAllRequestCounters(): void {
  requestCounters.clear()
}

/**
 * 从预算声明创建策略
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

  // 超时策略
  if (budgets.timeoutMs !== undefined) {
    policies.push(
      createTimeoutPolicy({
        providerId,
        timeoutMs: budgets.timeoutMs,
        priority
      })
    )
  }

  // 输出大小限制策略
  if (budgets.maxOutputBytes !== undefined) {
    policies.push(
      createOutputLimitPolicy({
        providerId,
        maxBytes: budgets.maxOutputBytes,
        priority
      })
    )
  }

  // 请求次数限制策略
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
