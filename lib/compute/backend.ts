/**
 * ComputeBackend — the contract every compute target implements.
 *
 * One backend = one implementation of this interface. Backends are
 * independent; they share nothing beyond the types and the ComputeContext
 * dependency bundle.
 *
 * Backend-internal state (runner pools, polling timers, child processes,
 * persistence stores) is encapsulated — Registry only sees the interface.
 */

import type {
  BackendIdentity,
  BackendCapabilities,
  BackendAvailability,
  ComputePlan,
  ComputeRun,
  RunStatus,
  PlanInput,
  SubmitOpts,
} from './types.js'

export interface ComputeBackend {
  readonly identity: BackendIdentity
  readonly capabilities: BackendCapabilities

  /**
   * Live-probe whether this backend can accept work right now.
   * Cheap to call (sub-second). Backends MAY return immediately if
   * they have nothing to check.
   */
  probeAvailability(): Promise<BackendAvailability>

  /**
   * Analyze a task and produce a plan. May call out to LLM, read the
   * script, inspect image declarations, etc.
   *
   * MUST NOT submit. MUST be safe to call repeatedly (no side effects
   * beyond logging / cache warming).
   */
  plan(input: PlanInput): Promise<ComputePlan>

  /**
   * Kick off the plan. Returns immediately with a ComputeRun whose
   * runId can be polled. Polling + event emission is the backend's
   * responsibility; backend reports via ctx.emit().
   */
  submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun>

  /**
   * Synchronous snapshot of a run's current state. Returns undefined
   * if runId is unknown to this backend.
   */
  getStatus(runId: string): RunStatus | undefined

  /**
   * Block until the run reaches a terminal state OR the timeout
   * expires. Returns undefined if runId is unknown.
   */
  waitForCompletion(runId: string, timeoutMs: number): Promise<RunStatus | undefined>

  /**
   * Cancel a running task. No-op if already terminal or unknown.
   * If capabilities.supportsStop is false, this method throws.
   */
  stop(runId: string): Promise<void>

  /** Release resources (timers, child processes, file handles). */
  destroy(): Promise<void>

  /**
   * Hydrate persisted runs from disk for crash recovery. Returns the
   * list of runs the backend now knows about, each paired with its
   * latest status snapshot.
   *
   * Amendment A3 (RFC-008): returns `{ run, status }` tuples rather
   * than ComputeRun[] alone — ComputeRun lacks the live status fields
   * the UI needs to restore the Compute tab.
   */
  hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>>
}
