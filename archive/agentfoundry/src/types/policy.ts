/**
 * Policy Types - Policy axis type definitions
 * Policies determine whether operations are allowed
 */

/**
 * Policy context
 */
export interface PolicyContext {
  /** Tool name */
  tool: string
  /** IO operation type */
  operation?: string
  /** Tool input */
  input: unknown
  /** IO operation parameters */
  params?: unknown
  /** Call source (e.g., ctx.get:docs.search) */
  caller?: string
  /** Agent ID */
  agentId: string
  /** Session ID */
  sessionId: string
  /** Current step */
  step: number
  /** Tool execution result (only available in the Observe phase) */
  result?: unknown
}

/**
 * Declarative transform operators (serializable and replayable)
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
 * Guard phase decision
 */
export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'require_approval'; message: string; timeout?: number }

/**
 * Mutate phase decision
 */
export type MutateDecision =
  | { action: 'pass' }
  | { action: 'transform'; transforms: Transform[] }

/**
 * Observe phase decision
 */
export interface ObserveDecision {
  action: 'observe'
  /** Write to trace */
  record?: Record<string, unknown>
  /** Emit events */
  emit?: { event: string; data: unknown }[]
  /** Alert */
  alert?: { level: 'info' | 'warn' | 'error'; message: string }
}

/**
 * Policy decision (union type of all phases)
 */
export type PolicyDecision = GuardDecision | MutateDecision | ObserveDecision

/**
 * Policy phase
 */
export type PolicyPhase = 'guard' | 'mutate' | 'observe'

/**
 * Policy definition
 */
export interface Policy {
  /** Policy ID */
  id: string
  /** Policy description */
  description?: string
  /** Priority (lower number executes first) */
  priority?: number
  /** Policy phase */
  phase: PolicyPhase
  /** Match function */
  match: (ctx: PolicyContext) => boolean
  /** Decision function */
  decide: (ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>
}

/**
 * Policy configuration (for definePolicy)
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
 * PolicyEngine pre-evaluation result
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
 * Approval request handler
 */
export type ApprovalHandler = (decision: {
  message: string
  timeout?: number
}) => Promise<boolean>

/**
 * Alert handler
 */
export type AlertHandler = (alert: {
  level: 'info' | 'warn' | 'error'
  message: string
}) => void
