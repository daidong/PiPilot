/**
 * Compute Events — single discriminated union for all backend-emitted events.
 *
 * Replaces the per-backend channel proliferation that PR #62 introduced.
 * One IPC channel (compute:event) carries this union; one renderer
 * reducer dispatches on `kind`.
 */

import type { ComputePlan, RunStatus, BackendAvailability } from './types.js'

export type ComputeEvent =
  | {
      kind: 'availability-changed'
      backend: string
      availability: BackendAvailability
    }
  | {
      kind: 'plan-ready'
      backend: string
      planId: string
      plan: ComputePlan
      /** True iff this plan must be approved before submit() runs. */
      requiresApproval: boolean
    }
  | {
      kind: 'plan-approved'
      backend: string
      planId: string
      approvedAt: string
    }
  | {
      kind: 'plan-rejected'
      backend: string
      planId: string
      rejectedAt: string
      comments: string
    }
  | {
      kind: 'run-update'
      backend: string
      runId: string
      status: RunStatus
    }
  | {
      kind: 'run-complete'
      backend: string
      runId: string
      status: RunStatus
    }
  | {
      kind: 'cost-killed'
      backend: string
      runId: string
      estimatedCostUsd: number
      thresholdUsd: number
    }

export type ComputeEventKind = ComputeEvent['kind']
