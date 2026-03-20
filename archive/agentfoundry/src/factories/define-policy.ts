/**
 * definePolicy - Policy definition factory
 */

import type {
  Policy,
  PolicyConfig,
  PolicyContext,
  GuardDecision,
  ObserveDecision,
  Transform
} from '../types/policy.js'

/**
 * Define a policy
 */
export function definePolicy(config: PolicyConfig): Policy {
  // Validate configuration
  if (!config.id) {
    throw new Error('Policy id is required')
  }

  if (!config.phase) {
    throw new Error('Policy phase is required')
  }

  if (!['guard', 'mutate', 'observe'].includes(config.phase)) {
    throw new Error(`Invalid policy phase: ${config.phase}`)
  }

  if (!config.match) {
    throw new Error('Policy match function is required')
  }

  if (!config.decide) {
    throw new Error('Policy decide function is required')
  }

  return {
    id: config.id,
    description: config.description,
    priority: config.priority ?? 100,
    phase: config.phase,
    match: config.match,
    decide: config.decide
  }
}

// ============ Guard policy shorthand creators ============

/**
 * Create a Guard policy
 */
export function defineGuardPolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  decide: (ctx: PolicyContext) => GuardDecision | Promise<GuardDecision>
}): Policy {
  return definePolicy({
    ...config,
    phase: 'guard'
  })
}

/**
 * Create a simple deny policy
 */
export function defineDenyPolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  reason: string | ((ctx: PolicyContext) => string)
}): Policy {
  return defineGuardPolicy({
    id: config.id,
    description: config.description,
    priority: config.priority,
    match: config.match,
    decide: (ctx) => ({
      action: 'deny',
      reason: typeof config.reason === 'function' ? config.reason(ctx) : config.reason
    })
  })
}

/**
 * Create an approval-required policy
 */
export function defineApprovalPolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  message: string | ((ctx: PolicyContext) => string)
  timeout?: number
}): Policy {
  return defineGuardPolicy({
    id: config.id,
    description: config.description,
    priority: config.priority,
    match: config.match,
    decide: (ctx) => ({
      action: 'require_approval',
      message: typeof config.message === 'function' ? config.message(ctx) : config.message,
      timeout: config.timeout
    })
  })
}

// ============ Mutate policy shorthand creators ============

/**
 * Create a Mutate policy
 */
export function defineMutatePolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  transforms: Transform[] | ((ctx: PolicyContext) => Transform[])
}): Policy {
  return definePolicy({
    id: config.id,
    description: config.description,
    priority: config.priority,
    phase: 'mutate',
    match: config.match,
    decide: (ctx) => ({
      action: 'transform',
      transforms: typeof config.transforms === 'function'
        ? config.transforms(ctx)
        : config.transforms
    })
  })
}

// ============ Observe policy shorthand creators ============

/**
 * Create an Observe policy
 */
export function defineObservePolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  decide: (ctx: PolicyContext) => ObserveDecision | Promise<ObserveDecision>
}): Policy {
  return definePolicy({
    ...config,
    phase: 'observe'
  })
}

/**
 * Create an audit policy
 */
export function defineAuditPolicy(config: {
  id: string
  description?: string
  priority?: number
  match?: (ctx: PolicyContext) => boolean
  record: (ctx: PolicyContext) => Record<string, unknown>
}): Policy {
  return defineObservePolicy({
    id: config.id,
    description: config.description,
    priority: config.priority,
    match: config.match ?? (() => true),
    decide: (ctx) => ({
      action: 'observe',
      record: config.record(ctx)
    })
  })
}

/**
 * Create an alert policy
 */
export function defineAlertPolicy(config: {
  id: string
  description?: string
  priority?: number
  match: (ctx: PolicyContext) => boolean
  level: 'info' | 'warn' | 'error'
  message: string | ((ctx: PolicyContext) => string)
}): Policy {
  return defineObservePolicy({
    id: config.id,
    description: config.description,
    priority: config.priority,
    match: config.match,
    decide: (ctx) => ({
      action: 'observe',
      alert: {
        level: config.level,
        message: typeof config.message === 'function' ? config.message(ctx) : config.message
      }
    })
  })
}
