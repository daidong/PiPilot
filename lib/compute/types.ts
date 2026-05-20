/**
 * Compute Backend Abstraction — Core Types (RFC-008 v2)
 *
 * Single source of truth for what a compute backend looks like.
 * Backend-specific data flows through `backendData: unknown` with a
 * `backendDataVersion: number` sibling (amendment A5 — JSON-only,
 * version-tagged so renderers can guard).
 */

import type { FailureSignal, StructuredProgress } from './shared-types.js'

// ---------------------------------------------------------------------------
// Identity + capabilities
// ---------------------------------------------------------------------------

/**
 * Identity + advertised capabilities of a backend.
 *
 * `id` is the public, display-friendly slug used in events, settings keys,
 * URLs, etc. It can contain hyphens ('aws-batch', 'gcp-run').
 *
 * `toolPrefix` is the prefix the registry uses to generate per-backend
 * tool names. MUST match /^[a-z][a-z0-9_]*$/ (no hyphens — they aren't
 * valid in tool names). MUST be unique across all registered backends;
 * `Registry.register()` rejects duplicates.
 *
 * Amendment A4 (RFC-008): split from id to allow hyphenated ids while
 * keeping tool names tool-safe.
 */
export interface BackendIdentity {
  readonly id: string
  readonly displayName: string
  readonly toolPrefix: string
}

export interface BackendCapabilities {
  /** Plan must be approved by the user before submit() runs. */
  requiresApproval: boolean
  /** Backend bills the user; cost-killing and threshold settings apply. */
  hasCost: boolean
  /** Backend can run GPU workloads. Used by planner to filter candidate backends. */
  supportsGpu: boolean
  /** Backend supports stop() once a run is in flight. */
  supportsStop: boolean
  /** Backend can stream output incrementally (vs. only on completion). */
  supportsStreaming: boolean
}

export interface BackendAvailability {
  /** Ready to accept submissions right now. */
  available: boolean
  /**
   * Human-readable list of what's missing.
   * Example: ['Modal CLI not installed', 'MODAL_TOKEN_ID env var unset']
   */
  missingRequirements: string[]
  /** Optional actionable next-steps for the UI. */
  hints?: string[]
}

// ---------------------------------------------------------------------------
// Task profile + cost
// ---------------------------------------------------------------------------

/**
 * Common slice of a task profile that every backend's planner produces.
 * Backend-specific fields go into ComputePlan.backendData.
 */
export interface TaskProfile {
  cpuDensity: 'low' | 'medium' | 'high'
  gpuDensity: 'none' | 'light' | 'heavy'
  memoryPattern: 'constant' | 'growing' | 'spike'
  ioPattern: 'read_heavy' | 'write_heavy' | 'balanced' | 'minimal'
  chunkable: boolean
  resumable: boolean
  idempotent: boolean
  hasExternalSideEffects: boolean
  networkRequired: boolean
  expectedDurationClass: 'seconds' | 'minutes' | 'hours'
  reasoning: string
}

export interface CostEstimate {
  estimatedTotalUsd: number
  /**
   * Per-hour burn rate. Used by the BACKEND itself for elapsed-cost kill
   * decisions (the backend already polls its own runs for stall detection;
   * it computes elapsed-cost in the same loop and emits `cost-killed`
   * when over threshold). Also surfaced in the UI as the "burn rate".
   *
   * Amendment A2 (RFC-008): cost-killing is backend-owned, NOT Registry.
   */
  hourlyRateUsd: number
  expectedDurationMinutes: number
  notes: string
  /**
   * Calibration of how complete this estimate is.
   *   'lower_bound' — only one cost dimension modeled (e.g. Modal GPU only)
   *   'full'        — all material cost dimensions modeled
   *
   * Informational only — does NOT change kill behavior. The backend's
   * kill timer always uses `hourlyRateUsd * elapsed > threshold`.
   */
  coverage: 'lower_bound' | 'full'
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export type RunState =
  | 'pending_approval'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'cost_killed'

export function isTerminal(state: RunState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'timed_out' ||
    state === 'cancelled' ||
    state === 'cost_killed'
  )
}

// ---------------------------------------------------------------------------
// Plan + Run records
// ---------------------------------------------------------------------------

/**
 * What planner returns. Generic shape; everything backend-specific goes
 * under backendData with a backend-defined type.
 *
 * Amendment A5 (RFC-008): backendData MUST be JSON-serializable.
 * backendDataVersion is backend-owned, bumped on breaking changes.
 */
export interface ComputePlan {
  planId: string
  backend: string
  createdAt: string
  taskDescription?: string
  command: string
  scriptPath?: string
  taskProfile: TaskProfile
  /** Present iff backend.capabilities.hasCost. */
  costEstimate?: CostEstimate
  /** Backend-specific extras. JSON-serializable only. */
  backendData: unknown
  /** Backend-owned schema version for backendData. */
  backendDataVersion: number
}

export interface ComputeRun {
  runId: string
  backend: string
  planId: string
  status: RunState
  command: string
  scriptPath?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  outputPath: string
  parentRunId?: string
  retryCount: number
  estimatedCostUsd?: number
  /** Backend-specific snapshot for UI rendering. JSON-serializable only. */
  backendData: unknown
  backendDataVersion: number
}

export interface RunStatus {
  status: RunState
  exitCode?: number
  elapsedSeconds: number
  outputBytes: number
  outputLines: number
  outputTail: string
  /**
   * Tail of the run's stderr stream (separately captured, distinct from
   * `outputTail` which interleaves stdout+stderr for progress tracking).
   * Backends that don't separate streams (e.g. Modal) leave this undefined.
   * Cap is backend-defined (LocalBackend uses 4 KB).
   */
  stderrTail?: string
  lastOutputAt?: string
  stalled: boolean
  progress?: StructuredProgress
  failure?: FailureSignal
  /**
   * Authoritative result payload extracted from the run's output via the
   * cooperative `##RESULT## <json>` line protocol. The last such line in
   * the output tail wins. Undefined when the script did not emit one.
   * Use this — not `outputTail` — to read structured results back from
   * a job, since `outputTail` is only the last 8 KB and may miss the
   * result line in the middle of a long log.
   */
  result?: unknown
  estimatedCostUsd?: number
  /** Backend-specific extras. JSON-serializable only. */
  backendData: unknown
  backendDataVersion: number
}

// ---------------------------------------------------------------------------
// Plan record (PlanStore)
// ---------------------------------------------------------------------------

/**
 * Captured plan state — owned by PlanStore.
 *
 * Amendment A1 (RFC-008): every plan is written here, regardless of
 * whether approval is required. `effectiveRequiresApproval` is captured
 * at Registry.plan() time and is IMMUTABLE for this record's lifetime.
 * `approved` starts true when no gate applies, false otherwise.
 */
export interface PlanRecord {
  plan: ComputePlan
  effectiveRequiresApproval: boolean
  approved: boolean
  approvedAt?: string
  rejectedAt?: string
  rejectionComments?: string
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanInput {
  command: string
  taskDescription?: string
  scriptPath?: string
  /** Actual source code of the script. Local backend uses this for task profiling. */
  scriptContent?: string
  suggestedTimeoutMinutes?: number
  /**
   * Backend-specific plan input. Symmetric to ComputePlan.backendData on
   * the output side (RFC-008 amendment A5). Backends that can derive
   * everything from `command` + `scriptPath` (Local, Modal) ignore this.
   * Backends that require caller-supplied configuration (RFC-009 Phase 1
   * EC2: instanceSpec) read it here.
   *
   * Carried over IPC from the `compute_plan` tool's `backend_data`
   * parameter (JSON-encoded string, parsed at the tool boundary).
   * JSON-serializable values only.
   */
  backendData?: unknown
}

export interface SubmitOpts {
  timeoutMinutes?: number
  stallThresholdMinutes?: number
  parentRunId?: string
}
