/**
 * PolicyEngine - Policy Engine
 * Three-phase Pipeline: Guard → Mutate → Observe
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
 * PolicyEngine configuration
 */
export interface PolicyEngineConfig {
  trace: TraceCollector
  eventBus: EventBus
  onApprovalRequired?: ApprovalHandler
  onAlert?: AlertHandler
}

/**
 * Policy Engine
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
   * Register a policy
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
   * Register multiple policies
   */
  registerAll(policies: Policy[]): void {
    for (const policy of policies) {
      this.register(policy)
    }
  }

  /**
   * Unregister a policy
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
   * Pre-execution evaluation (Guard + Mutate phases)
   */
  async evaluateBefore(ctx: PolicyContext): Promise<BeforeResult> {
    // 1. Guard phase: terminate on any deny
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
            return { allowed: false, reason: 'User denied approval', policyId: policy.id }
          }
        } else {
          // No approval handler configured, deny by default
          return { allowed: false, reason: 'Approval required but no handler configured', policyId: policy.id }
        }
      }
    }

    // 2. Mutate phase: collect all transforms
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

    // Apply all transforms
    const mutatedInput = transforms.length > 0
      ? applyTransforms(ctx.input, transforms)
      : ctx.input

    return { allowed: true, input: mutatedInput, transforms }
  }

  /**
   * Post-execution evaluation (Observe phase)
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
   * Evaluate a complete tool call (including pre and post phases)
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
   * Get all policies
   */
  getAllPolicies(): Policy[] {
    return [...this.guards, ...this.mutators, ...this.observers]
  }

  /**
   * Get policies by phase
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
   * Get policy statistics
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
   * Clear all policies
   */
  clear(): void {
    this.guards = []
    this.mutators = []
    this.observers = []
  }

  /**
   * Set the approval handler
   */
  setApprovalHandler(handler: ApprovalHandler): void {
    this.config.onApprovalRequired = handler
  }

  /**
   * Set the alert handler
   */
  setAlertHandler(handler: AlertHandler): void {
    this.config.onAlert = handler
  }
}
