/**
 * compute - 计算能力包（成本型）
 *
 * 特点：
 * - 需要显式启用
 * - Token 配额控制
 * - 成本监控
 *
 * Migration to Skills:
 * - useSkills defaults to true for lazy-loaded skills
 * - Set useSkills: false to use legacy promptFragment (backward compatibility)
 * - Skills reduce initial token usage by ~350 tokens (94% on first load)
 * - Skills load automatically when llm-* tools are first used
 */

import { definePack } from '../factories/define-pack.js'
import { defineGuardPolicy, defineMutatePolicy, defineAuditPolicy } from '../factories/define-policy.js'
import type { Pack } from '../types/pack.js'
import type { Policy } from '../types/policy.js'
import { llmCall, llmExpand, llmFilter } from '../tools/index.js'
import { llmComputeSkill } from '../skills/builtin/index.js'

/**
 * Compute Pack 配置选项
 */
export interface ComputePackOptions {
  /**
   * 单次调用最大 token 数
   * 默认 4000
   */
  maxTokensPerCall?: number

  /**
   * 会话总 token 配额
   * 默认 100000
   */
  sessionTokenQuota?: number

  /**
   * 允许的模型列表（如果需要限制）
   */
  allowModels?: string[]

  /**
   * 是否允许 JSON 模式
   * 默认 true
   */
  allowJsonMode?: boolean

  /**
   * 温度限制范围
   */
  temperatureRange?: {
    min: number
    max: number
  }

  /**
   * 是否需要审批
   * 默认 false
   */
  requireApproval?: boolean

  /**
   * Use Skills instead of promptFragment for token optimization
   * When true, uses lazy-loaded llmComputeSkill instead of inline promptFragment
   * @default true
   */
  useSkills?: boolean
}

/**
 * 会话 token 使用跟踪器
 */
const sessionTokenUsage = new Map<string, number>()

/**
 * 获取会话 token 使用量
 */
export function getSessionTokenUsage(sessionId: string): number {
  return sessionTokenUsage.get(sessionId) ?? 0
}

/**
 * 重置会话 token 使用量
 */
export function resetSessionTokenUsage(sessionId: string): void {
  sessionTokenUsage.delete(sessionId)
}

/**
 * 创建 token 限制策略（Mutate）
 */
function createMaxTokensPolicy(maxTokens: number): Policy {
  return defineMutatePolicy({
    id: 'compute:max-tokens',
    description: '限制单次调用的最大 token 数',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'clamp', path: 'maxTokens', max: maxTokens }
    ]
  })
}

/**
 * 创建会话配额策略
 */
function createQuotaPolicy(quota: number): Policy {
  return defineGuardPolicy({
    id: 'compute:session-quota',
    description: '限制会话总 token 配额',
    priority: 10,
    match: (ctx) => ctx.tool === 'llm-call',
    decide: (ctx) => {
      const used = sessionTokenUsage.get(ctx.sessionId) ?? 0
      const requested = (ctx.input as { maxTokens?: number })?.maxTokens ?? 1000

      if (used + requested > quota) {
        return {
          action: 'deny',
          reason: `Token 配额已用尽: ${used}/${quota}，请求 ${requested}`
        }
      }
      return { action: 'allow' }
    }
  })
}

/**
 * 创建温度限制策略
 */
function createTemperaturePolicy(range: { min: number; max: number }): Policy {
  return defineMutatePolicy({
    id: 'compute:temperature-limit',
    description: '限制温度参数范围',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'clamp', path: 'temperature', min: range.min, max: range.max }
    ]
  })
}

/**
 * 创建 JSON 模式禁用策略
 */
function createNoJsonModePolicy(): Policy {
  return defineMutatePolicy({
    id: 'compute:no-json-mode',
    description: '禁用 JSON 模式',
    priority: 50,
    match: (ctx) => ctx.tool === 'llm-call',
    transforms: [
      { op: 'set', path: 'jsonMode', value: false }
    ]
  })
}

/**
 * 创建审批策略
 */
function createApprovalPolicy(): Policy {
  return defineGuardPolicy({
    id: 'compute:approval',
    description: 'LLM 调用需要审批',
    priority: 20,
    match: (ctx) => ctx.tool === 'llm-call',
    decide: (ctx) => {
      const input = ctx.input as { prompt?: string; maxTokens?: number }
      const promptPreview = (input.prompt ?? '').slice(0, 100)
      return {
        action: 'require_approval',
        message: `LLM 调用审批:\nPrompt: ${promptPreview}...\nMax tokens: ${input.maxTokens ?? 1000}`,
        timeout: 60000
      }
    }
  })
}

/**
 * 创建 LLM 审计策略
 */
function createLlmAuditPolicy(): Policy {
  return defineAuditPolicy({
    id: 'compute:audit',
    description: '审计所有 LLM 调用',
    priority: 100,
    match: (ctx) => ctx.tool === 'llm-call',
    record: (ctx) => {
      const input = ctx.input as {
        prompt?: string
        systemPrompt?: string
        maxTokens?: number
        temperature?: number
        jsonMode?: boolean
      }

      // 更新 token 使用量（在 observe 阶段，result 可能包含实际使用量）
      const result = ctx.result as { data?: { usage?: { totalTokens?: number } } } | undefined
      const tokensUsed = result?.data?.usage?.totalTokens ?? input.maxTokens ?? 1000

      const currentUsage = sessionTokenUsage.get(ctx.sessionId) ?? 0
      sessionTokenUsage.set(ctx.sessionId, currentUsage + tokensUsed)

      return {
        tool: ctx.tool,
        promptLength: input.prompt?.length ?? 0,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        jsonMode: input.jsonMode,
        tokensUsed,
        sessionTotalTokens: currentUsage + tokensUsed,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        step: ctx.step,
        timestamp: new Date().toISOString()
      }
    }
  })
}

/**
 * Compute Pack - 计算能力包
 *
 * 包含工具：
 * - llm-call: LLM 子调用
 *
 * 默认策略：
 * - 单次调用 token 限制
 * - 会话 token 配额
 * - 审计所有调用
 */
export function compute(options: ComputePackOptions = {}): Pack {
  const {
    maxTokensPerCall = 4000,
    sessionTokenQuota = 100000,
    temperatureRange,
    allowJsonMode = true,
    requireApproval = false,
    useSkills = true
  } = options

  const policies: Policy[] = []

  // Token 限制策略
  policies.push(createMaxTokensPolicy(maxTokensPerCall))

  // 会话配额策略
  policies.push(createQuotaPolicy(sessionTokenQuota))

  // 温度限制策略
  if (temperatureRange) {
    policies.push(createTemperaturePolicy(temperatureRange))
  }

  // JSON 模式禁用策略
  if (!allowJsonMode) {
    policies.push(createNoJsonModePolicy())
  }

  // 审批策略
  if (requireApproval) {
    policies.push(createApprovalPolicy())
  }

  // 审计策略
  policies.push(createLlmAuditPolicy())

  // Build pack with either skills (new) or promptFragment (legacy)
  if (useSkills) {
    // New Skills-based approach: lazy loading for token optimization
    // Only ~60 tokens loaded initially vs ~400 tokens with promptFragment
    return definePack({
      id: 'compute',
      description: '计算能力包：llm-call, llm-expand, llm-filter（需显式启用）',

      tools: [llmCall as any, llmExpand as any, llmFilter as any],

      policies,

      skills: [llmComputeSkill],
      skillLoadingConfig: {
        lazy: ['llm-compute-skill'] // Loads when llm-* tools are first used
      },

      // Note: promptFragment omitted - skills replace it
      // Runtime quota info can be added to skill via runtime configuration

      onDestroy: async (_runtime) => {
        // 清理会话 token 使用记录
      }
    })
  }

  // Legacy promptFragment approach (for backward compatibility)
  return definePack({
    id: 'compute',
    description: '计算能力包：llm-call, llm-expand, llm-filter（需显式启用）',

    tools: [llmCall as any, llmExpand as any, llmFilter as any],

    policies,

    promptFragment: `
## LLM 计算能力

### llm-call 工具
进行原始 LLM 子调用，用于：
- 自定义 prompt 任务
- 文本分类
- 摘要生成
- 结构化数据提取

### llm-expand 工具
文本扩展，生成多个变体：
- style: "search" - 搜索查询优化（默认）
- style: "synonyms" - 同义词生成
- style: "rephrase" - 多角度重述
- domain: 领域提示（如 "academic", "technical"）

### llm-filter 工具
相关性过滤，对列表评分筛选：
- 按 query 对每项评分 0-10
- minScore: 最低分数阈值（默认 5）
- maxItems: 最大返回数量（默认 10）
- 返回排序后的高相关性项目

### 配额限制
- 单次调用: 最多 ${maxTokensPerCall} tokens
- 会话配额: ${sessionTokenQuota} tokens
${temperatureRange ? `- 温度范围: ${temperatureRange.min} - ${temperatureRange.max}` : ''}
${!allowJsonMode ? '- JSON 模式已禁用' : ''}

### 最佳实践
1. 优先使用 llm-expand/llm-filter 替代自定义 prompt
2. 设置合理的 maxTokens 避免浪费
3. 复杂任务拆分为多次小调用
4. llm-filter 适合筛选搜索结果
    `.trim(),

    onDestroy: async (_runtime) => {
      // 清理会话 token 使用记录
      // 注意：这里可以添加更多清理逻辑
    }
  })
}

/**
 * 别名：computePack
 */
export const computePack = compute

/**
 * 预设：经济模式（低配额）
 */
export function computeEconomy(): Pack {
  return compute({
    maxTokensPerCall: 1000,
    sessionTokenQuota: 10000,
    temperatureRange: { min: 0, max: 0.7 }
  })
}

/**
 * 预设：标准模式
 */
export function computeStandard(): Pack {
  return compute({
    maxTokensPerCall: 4000,
    sessionTokenQuota: 100000
  })
}

/**
 * 预设：高级模式（大配额）
 */
export function computePremium(): Pack {
  return compute({
    maxTokensPerCall: 8000,
    sessionTokenQuota: 500000
  })
}

/**
 * 预设：审批模式
 */
export function computeWithApproval(): Pack {
  return compute({
    maxTokensPerCall: 4000,
    sessionTokenQuota: 100000,
    requireApproval: true
  })
}
