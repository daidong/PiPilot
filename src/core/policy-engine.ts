/**
 * PolicyEngine - 策略引擎
 * 三阶段 Pipeline: Guard → Mutate → Observe
 */

import type {
  Policy,
  PolicyContext,
  GuardDecision,
  MutateDecision,
  ObserveDecision,
  Transform,
  BeforeResult,
  ApprovalHandler,
  AlertHandler
} from '../types/policy.js'
import type { TraceCollector } from './trace-collector.js'
import type { EventBus } from './event-bus.js'
import { applyTransforms } from '../utils/transform.js'

/**
 * PolicyEngine 配置
 */
export interface PolicyEngineConfig {
  trace: TraceCollector
  eventBus: EventBus
  onApprovalRequired?: ApprovalHandler
  onAlert?: AlertHandler
}

/**
 * 策略引擎
 */
export class PolicyEngine {
  private guards: Policy[] = []
  private mutators: Policy[] = []
  private observers: Policy[] = []
  private config: PolicyEngineConfig

  constructor(config: PolicyEngineConfig) {
    this.config = config
  }

  /**
   * 注册策略
   */
  register(policy: Policy): void {
    switch (policy.phase) {
      case 'guard':
        this.guards.push(policy)
        this.guards.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        break
      case 'mutate':
        this.mutators.push(policy)
        this.mutators.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        break
      case 'observe':
        this.observers.push(policy)
        this.observers.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        break
    }
  }

  /**
   * 批量注册策略
   */
  registerAll(policies: Policy[]): void {
    for (const policy of policies) {
      this.register(policy)
    }
  }

  /**
   * 取消注册策略
   */
  unregister(policyId: string): boolean {
    let removed = false

    const removeFromArray = (arr: Policy[]): void => {
      const index = arr.findIndex(p => p.id === policyId)
      if (index !== -1) {
        arr.splice(index, 1)
        removed = true
      }
    }

    removeFromArray(this.guards)
    removeFromArray(this.mutators)
    removeFromArray(this.observers)

    return removed
  }

  /**
   * 执行前评估（Guard + Mutate 阶段）
   */
  async evaluateBefore(ctx: PolicyContext): Promise<BeforeResult> {
    // 1. Guard 阶段：任一 deny 即终止
    for (const policy of this.guards) {
      if (!policy.match(ctx)) {
        continue
      }

      const decision = await policy.decide(ctx) as GuardDecision

      this.config.trace.record({
        type: 'policy.guard',
        data: { policyId: policy.id, decision: decision.action }
      })

      if (decision.action === 'deny') {
        this.config.eventBus.emit('policy:deny', {
          policyId: policy.id,
          reason: decision.reason
        })

        return { allowed: false, reason: decision.reason, policyId: policy.id }
      }

      if (decision.action === 'require_approval') {
        this.config.eventBus.emit('policy:approval_requested', {
          policyId: policy.id,
          message: decision.message
        })

        if (this.config.onApprovalRequired) {
          const approved = await this.config.onApprovalRequired({
            message: decision.message,
            timeout: decision.timeout
          })

          if (!approved) {
            return { allowed: false, reason: 'User denied approval' }
          }
        } else {
          // 没有审批处理器，默认拒绝
          return { allowed: false, reason: 'Approval required but no handler configured' }
        }
      }
    }

    // 2. Mutate 阶段：收集所有 transforms
    const transforms: Transform[] = []

    for (const policy of this.mutators) {
      if (!policy.match(ctx)) {
        continue
      }

      const decision = await policy.decide(ctx) as MutateDecision

      if (decision.action === 'transform') {
        transforms.push(...decision.transforms)

        this.config.trace.record({
          type: 'policy.mutate',
          data: { policyId: policy.id, transforms: decision.transforms }
        })
      }
    }

    // 应用所有 transforms
    const mutatedInput = transforms.length > 0
      ? applyTransforms(ctx.input, transforms)
      : ctx.input

    return { allowed: true, input: mutatedInput, transforms }
  }

  /**
   * 执行后评估（Observe 阶段）
   */
  async evaluateAfter(ctx: PolicyContext): Promise<void> {
    for (const policy of this.observers) {
      if (!policy.match(ctx)) {
        continue
      }

      const decision = await policy.decide(ctx) as ObserveDecision

      if (decision.record) {
        this.config.trace.record({
          type: 'policy.observe',
          data: { policyId: policy.id, record: decision.record }
        })
      }

      if (decision.emit) {
        for (const e of decision.emit) {
          this.config.eventBus.emit(e.event, e.data)
        }
      }

      if (decision.alert && this.config.onAlert) {
        this.config.onAlert({
          level: decision.alert.level,
          message: decision.alert.message
        })
      }
    }
  }

  /**
   * 评估完整的工具调用（包含前后阶段）
   */
  async evaluateToolCall<T>(
    ctx: PolicyContext,
    execute: (mutatedInput: unknown) => Promise<T>
  ): Promise<{ allowed: boolean; result?: T; error?: string }> {
    const beforeResult = await this.evaluateBefore(ctx)

    if (!beforeResult.allowed) {
      return { allowed: false, error: beforeResult.reason }
    }

    const result = await execute(beforeResult.input)

    await this.evaluateAfter({
      ...ctx,
      input: beforeResult.input,
      result
    })

    return { allowed: true, result }
  }

  /**
   * 获取所有策略
   */
  getAllPolicies(): Policy[] {
    return [...this.guards, ...this.mutators, ...this.observers]
  }

  /**
   * 获取指定阶段的策略
   */
  getPoliciesByPhase(phase: 'guard' | 'mutate' | 'observe'): Policy[] {
    switch (phase) {
      case 'guard':
        return [...this.guards]
      case 'mutate':
        return [...this.mutators]
      case 'observe':
        return [...this.observers]
    }
  }

  /**
   * 获取策略统计
   */
  getStats(): {
    total: number
    guard: number
    mutate: number
    observe: number
  } {
    return {
      total: this.guards.length + this.mutators.length + this.observers.length,
      guard: this.guards.length,
      mutate: this.mutators.length,
      observe: this.observers.length
    }
  }

  /**
   * 清空所有策略
   */
  clear(): void {
    this.guards = []
    this.mutators = []
    this.observers = []
  }

  /**
   * 设置审批处理器
   */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.config.onApprovalRequired = handler
  }

  /**
   * 设置告警处理器
   */
  setAlertHandler(handler: AlertHandler): void {
    this.config.onAlert = handler
  }
}
