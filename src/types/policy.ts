/**
 * Policy Types - 策略轴类型定义
 * Policies 决定操作是否被允许
 */

/**
 * 策略上下文
 */
export interface PolicyContext {
  /** 工具名称 */
  tool: string
  /** IO 操作类型 */
  operation?: string
  /** 工具输入 */
  input: unknown
  /** IO 操作参数 */
  params?: unknown
  /** Call source (e.g., ctx.get:docs.search) */
  caller?: string
  /** 代理 ID */
  agentId: string
  /** 会话 ID */
  sessionId: string
  /** 当前步骤 */
  step: number
  /** 工具执行结果（仅 Observe 阶段可用） */
  result?: unknown
}

/**
 * 声明式变换操作符（可序列化、可重放）
 */
export type Transform =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'delete'; path: string }
  | { op: 'append'; path: string; value: unknown }
  | { op: 'limit'; path: string; max: number }
  | { op: 'redact'; path: string; pattern: string }
  | { op: 'clamp'; path: string; min?: number; max?: number }
  | { op: 'normalize_path'; path: string }

/**
 * Guard 阶段决策
 */
export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_approval'; message: string; timeout?: number }

/**
 * Mutate 阶段决策
 */
export type MutateDecision =
  | { action: 'pass' }
  | { action: 'transform'; transforms: Transform[] }

/**
 * Observe 阶段决策
 */
export interface ObserveDecision {
  action: 'observe'
  /** 写入 trace */
  record?: Record<string, unknown>
  /** 发送事件 */
  emit?: { event: string; data: unknown }[]
  /** 告警 */
  alert?: { level: 'info' | 'warn' | 'error'; message: string }
}

/**
 * 策略决策（所有阶段的联合类型）
 */
export type PolicyDecision = GuardDecision | MutateDecision | ObserveDecision

/**
 * 策略阶段
 */
export type PolicyPhase = 'guard' | 'mutate' | 'observe'

/**
 * 策略定义
 */
export interface Policy {
  /** 策略 ID */
  id: string
  /** 策略描述 */
  description?: string
  /** 优先级（数字越小越先执行） */
  priority?: number
  /** 策略阶段 */
  phase: PolicyPhase
  /** 匹配函数 */
  match: (ctx: PolicyContext) => boolean
  /** 决策函数 */
  decide: (ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>
}

/**
 * 策略配置（用于 definePolicy）
 */
export interface PolicyConfig {
  id: string
  description?: string
  priority?: number
  phase: PolicyPhase
  match: (ctx: PolicyContext) => boolean
  decide: (ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>
}

/**
 * PolicyEngine 评估前的结果
 */
export interface BeforeResult {
  allowed: boolean
  reason?: string
  /** The policy ID that denied the request (if allowed is false) */
  policyId?: string
  input?: unknown
  transforms?: Transform[]
}

/**
 * 审批请求处理器
 */
export type ApprovalHandler = (decision: {
  message: string
  timeout?: number
}) => Promise<boolean>

/**
 * 告警处理器
 */
export type AlertHandler = (alert: {
  level: 'info' | 'warn' | 'error'
  message: string
}) => void
