/**
 * ComputeRegistry — owns registered backends, dispatches operations,
 * fans out events. Single source of truth for "which backends exist"
 * and "where does a run id route to".
 */

import type { ComputeBackend } from './backend.js'
import type { ComputeEvent } from './events.js'
import type {
  ComputePlan,
  ComputeRun,
  RunStatus,
  PlanInput,
  SubmitOpts,
  PlanRecord,
} from './types.js'
import { PlanStore } from './plan-store.js'

const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/

export interface RegistryOpts {
  projectPath: string
  /** Global override: force every backend through the approval gate. */
  forceApproval: boolean
}

export interface HydrateResult {
  runs: Array<{ run: ComputeRun; status: RunStatus }>
  pendingPlans: Array<{ backend: string; planId: string; record: PlanRecord }>
}

export class ComputeRegistry {
  private readonly backends = new Map<string, ComputeBackend>()
  /** Routing table: runId → backend. Populated in submit() and hydrate(). */
  private readonly runIdRouting = new Map<string, ComputeBackend>()
  private readonly plans: PlanStore
  private readonly subscribers = new Set<(event: ComputeEvent) => void>()
  private forceApproval: boolean

  constructor(opts: RegistryOpts) {
    this.plans = new PlanStore(opts.projectPath)
    this.forceApproval = opts.forceApproval
  }

  /**
   * Update the global approval-override flag.
   *
   * Amendment A1 (RFC-008): this affects only FUTURE plans. Plans
   * already written to PlanStore keep their captured
   * `effectiveRequiresApproval`. Eliminates the settings-flip race.
   */
  setForceApproval(value: boolean): void {
    this.forceApproval = value
  }

  isForceApproval(): boolean {
    return this.forceApproval
  }

  // ── Backend registration ────────────────────────────────────────────

  /**
   * Amendment A4 (RFC-008): rejects duplicate id, duplicate toolPrefix,
   * and toolPrefix that doesn't match /^[a-z][a-z0-9_]*$/.
   */
  register(backend: ComputeBackend): void {
    const { id, toolPrefix } = backend.identity
    if (this.backends.has(id)) {
      throw new Error(`ComputeRegistry: backend id collision: '${id}' is already registered`)
    }
    if (!TOOL_PREFIX_PATTERN.test(toolPrefix)) {
      throw new Error(
        `ComputeRegistry: backend '${id}' has invalid toolPrefix '${toolPrefix}' — must match /^[a-z][a-z0-9_]*$/`
      )
    }
    for (const existing of this.backends.values()) {
      if (existing.identity.toolPrefix === toolPrefix) {
        throw new Error(
          `ComputeRegistry: backend toolPrefix collision: '${toolPrefix}' is already used by backend '${existing.identity.id}'`
        )
      }
    }
    this.backends.set(id, backend)
  }

  list(): ComputeBackend[] {
    return [...this.backends.values()]
  }

  get(backendId: string): ComputeBackend | undefined {
    return this.backends.get(backendId)
  }

  has(backendId: string): boolean {
    return this.backends.has(backendId)
  }

  // ── Plan + approval ─────────────────────────────────────────────────

  /**
   * Amendment A1 (RFC-008): every plan gets a PlanRecord with captured
   * effectiveRequiresApproval, regardless of gate status. Settings
   * flips after this point do NOT affect this plan.
   */
  async plan(backendId: string, input: PlanInput): Promise<ComputePlan> {
    const backend = this.requireBackend(backendId)
    const plan = await backend.plan(input)
    const effectiveRequiresApproval = this.forceApproval || backend.capabilities.requiresApproval
    const record: PlanRecord = {
      plan,
      effectiveRequiresApproval,
      approved: !effectiveRequiresApproval,
    }
    this.plans.write(backendId, plan.planId, record)
    this.emit({
      kind: 'plan-ready',
      backend: backendId,
      planId: plan.planId,
      plan,
      requiresApproval: effectiveRequiresApproval,
    })
    return plan
  }

  /** Returns the PlanRecord for a (backend, planId) pair — used by the compute_plan tool to surface effectiveRequiresApproval. */
  getPlanRecord(backendId: string, planId: string): PlanRecord | undefined {
    return this.plans.read(backendId, planId)
  }

  approvePlan(backendId: string, planId: string): { success: boolean; error?: string } {
    const record = this.plans.read(backendId, planId)
    if (!record) return { success: false, error: `No plan ${planId} for backend ${backendId}` }
    if (!record.effectiveRequiresApproval) return { success: false, error: 'Plan does not require approval' }
    if (record.approved) return { success: true } // idempotent
    const approvedAt = new Date().toISOString()
    this.plans.write(backendId, planId, {
      ...record,
      approved: true,
      approvedAt,
      rejectedAt: undefined,
      rejectionComments: undefined,
    })
    this.emit({ kind: 'plan-approved', backend: backendId, planId, approvedAt })
    return { success: true }
  }

  rejectPlan(backendId: string, planId: string, comments: string): { success: boolean; error?: string } {
    const trimmed = comments.trim()
    if (!trimmed) return { success: false, error: 'Rejection comments are required' }
    const record = this.plans.read(backendId, planId)
    if (!record) return { success: false, error: `No plan ${planId} for backend ${backendId}` }
    if (!record.effectiveRequiresApproval) return { success: false, error: 'Plan does not require approval' }
    const rejectedAt = new Date().toISOString()
    this.plans.write(backendId, planId, {
      ...record,
      approved: false,
      rejectedAt,
      rejectionComments: trimmed,
      approvedAt: undefined,
    })
    this.emit({ kind: 'plan-rejected', backend: backendId, planId, rejectedAt, comments: trimmed })
    return { success: true }
  }

  // ── Submit ──────────────────────────────────────────────────────────

  /**
   * Amendment A1 (RFC-008): relies entirely on the captured PlanRecord.
   * No re-derivation from current settings — that was the v1 bug.
   */
  async submit(backendId: string, planId: string, opts: SubmitOpts): Promise<ComputeRun> {
    const backend = this.requireBackend(backendId)
    const record = this.plans.read(backendId, planId)
    if (!record) throw new Error(`No plan ${planId} for backend ${backendId}`)
    if (record.rejectedAt) {
      throw new Error(`Plan ${planId} was rejected; produce a new plan before submitting`)
    }
    if (record.effectiveRequiresApproval && !record.approved) {
      throw new Error(`Plan ${planId} requires approval and has not been approved yet`)
    }
    const run = await backend.submit(record.plan, opts)
    this.runIdRouting.set(run.runId, backend)
    this.plans.clear(backendId, planId)
    return run
  }

  // ── Run inspection ──────────────────────────────────────────────────

  getStatus(runId: string): RunStatus | undefined {
    return this.runIdRouting.get(runId)?.getStatus(runId)
  }

  async waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined> {
    return this.runIdRouting.get(runId)?.waitForCompletion(runId, timeoutMs)
  }

  async stop(runId: string): Promise<void> {
    const backend = this.runIdRouting.get(runId)
    if (!backend) throw new Error(`Unknown run: ${runId}`)
    if (!backend.capabilities.supportsStop) {
      throw new Error(`Backend '${backend.identity.id}' does not support stop`)
    }
    return backend.stop(runId)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    await Promise.allSettled([...this.backends.values()].map(b => b.destroy()))
  }

  /**
   * Amendment A3 (RFC-008): returns runs paired with their latest
   * status, so the renderer can restore the Compute tab in one round
   * trip. Also surfaces pending plans (gates that survived a crash).
   */
  async hydrate(): Promise<HydrateResult> {
    const runs: Array<{ run: ComputeRun; status: RunStatus }> = []
    for (const backend of this.backends.values()) {
      try {
        const entries = await backend.hydrate()
        for (const entry of entries) {
          this.runIdRouting.set(entry.run.runId, backend)
          runs.push(entry)
        }
      } catch {
        /* non-fatal: skip this backend */
      }
    }
    const pendingPlans = this.plans.listPending()
    return { runs, pendingPlans }
  }

  // ── Events ──────────────────────────────────────────────────────────

  subscribe(cb: (event: ComputeEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  emit(event: ComputeEvent): void {
    for (const sub of this.subscribers) sub(event)
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private requireBackend(backendId: string): ComputeBackend {
    const backend = this.backends.get(backendId)
    if (!backend) throw new Error(`Unknown compute backend: '${backendId}'`)
    return backend
  }
}
