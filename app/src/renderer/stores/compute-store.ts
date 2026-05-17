/**
 * Compute Store — Zustand store for compute backend state.
 *
 * Subscribes to the unified `compute:event` IPC channel and dispatches
 * via a single applyEvent reducer (RFC-008 §7.6). Backend-specific
 * payloads are kept in `backendData` so per-backend UI components can
 * render their own details.
 *
 * Legacy selectors usePendingModalPlan / modalAvailable are preserved
 * (derived from the new backends/pendingPlans maps) so existing
 * consumers do not break.
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Shared (cross-backend) types
// ---------------------------------------------------------------------------

export interface ComputeProgress {
  percentage?: number
  currentStep?: number
  totalSteps?: number
  metrics?: Record<string, number>
  phase?: string
  etaSeconds?: number
}

export interface ComputeFailure {
  code: string
  retryable: boolean
  message: string
  suggestions: string[]
}

// ---------------------------------------------------------------------------
// Backend-specific payload shapes (subset — UI components type-narrow
// via backendData + backendDataVersion per amendment A5).
// ---------------------------------------------------------------------------

export interface ModalImageView {
  source: 'script' | 'modal_default' | 'unknown'
  gpuType: string | null
  runtimeGpuType: string | null
  buildGpuType: string | null
  baseImage: string
  pythonVersion: string | null
  pythonPackages: string[]
  pythonPackageInstallers: Array<'uv_pip_install' | 'pip_install' | 'micromamba_install'>
  systemPackages: string[]
  envVars: string[]
  localDirs: string[]
  localFiles: string[]
  localPythonSources: string[]
  buildCommands: string[]
  buildFunctions: string[]
  forceBuild: boolean
  warnings: string[]
  reasoning: string
}

export interface ModalCostEstimateView {
  estimatedTotalUsd: number
  gpuRateUsdPerHour: number
  expectedDurationMinutes: number
  notes: string
}

// ---------------------------------------------------------------------------
// Run + plan + backend views
// ---------------------------------------------------------------------------

export interface ComputeRunView {
  runId: string
  backend: string                    // 'local' | 'modal' | ...
  planId?: string
  taskDescription?: string
  status: string
  /** Local-only — survives for legacy ComputeView code paths. */
  currentPhase: string
  command: string
  scriptPath?: string
  sandbox: string
  weight: string
  startedAt?: string
  lastOutputAt?: string
  elapsedSeconds: number
  outputBytes: number
  outputLines: number
  timeoutMs?: number
  stallThresholdMs?: number
  stalled: boolean
  progress?: ComputeProgress
  outputTail: string
  failure?: ComputeFailure
  exitCode?: number
  parentRunId?: string
  estimatedCostUsd?: number
  costThresholdUsd?: number
  costEstimate?: ModalCostEstimateView
  image?: ModalImageView
  /** Generic escape hatch for per-backend UI extras (amendment A5). */
  backendData?: unknown
  backendDataVersion?: number
}

export interface ComputePlanView {
  backend: string
  planId: string
  taskDescription?: string
  command: string
  scriptPath?: string
  taskProfile?: {
    expectedDurationClass?: 'seconds' | 'minutes' | 'hours'
    durationReasoning?: string
    reasoning?: string
  }
  /** Modal-specific — present when backend = 'modal'. */
  image?: ModalImageView
  costEstimate?: ModalCostEstimateView
  createdAt: string
  approved: boolean
  rejectedAt?: string
  rejectionComments?: string
  /** True iff this plan must be approved before execute. */
  requiresApproval: boolean
  backendData?: unknown
  backendDataVersion?: number
}

export interface BackendCapabilities {
  requiresApproval: boolean
  hasCost: boolean
  supportsGpu: boolean
  supportsStop: boolean
  supportsStreaming: boolean
}

export interface BackendAvailability {
  available: boolean
  missingRequirements: string[]
  hints?: string[]
}

export interface BackendView {
  id: string
  displayName: string
  toolPrefix: string
  capabilities?: BackendCapabilities
  availability?: BackendAvailability
}

// ---------------------------------------------------------------------------
// Legacy compat types (preserved for existing ComputeView consumers)
// ---------------------------------------------------------------------------

/** Subset of legacy EnvironmentSummary kept so the existing ComputeView panel still renders. Unused fields can stay undefined. */
export interface EnvironmentSummary {
  os?: string
  arch?: string
  cpuCores?: number
  totalMemoryMb?: number
  freeMemoryMb?: number
  freeDiskMb?: number
  gpu?: string
  mlxAvailable?: boolean
  sandbox?: string
}

export interface ModalAvailability {
  available: boolean
  cliInstalled: boolean
  hasCredentials: boolean
}

export type ModalPlanView = ComputePlanView   // legacy alias

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface ComputeState {
  runs: Map<string, ComputeRunView>
  backends: Map<string, BackendView>
  /** Keyed by `${backend}::${planId}`. Only the most recent plan-ready per backend is shown to the user. */
  pendingPlans: Map<string, ComputePlanView>
  /** Legacy compat — derived from `backends.get('local')?.availability`. Kept for ComputeView. */
  environment: EnvironmentSummary | null

  // Single reducer for all ComputeEvent variants (RFC-008 §7.6).
  applyEvent: (event: any) => void

  // Bulk hydration after app boot (compute:hydrate).
  hydrateRuns: (runs: Array<{ run: any; status: any }>) => void
  hydratePendingPlans: (entries: Array<{ backend: string; planId: string; record: any }>) => void

  // Direct setters (used by tests / niche flows; renderer normally uses applyEvent)
  updateRun: (runId: string, data: Partial<ComputeRunView>) => void
  removeRun: (runId: string) => void
  /** Legacy shim — drops any modal pending plan. New code should rely on applyEvent('plan-approved'/'plan-rejected'). */
  clearModalPendingPlan: () => void
  reset: () => void
}

function planKey(backend: string, planId: string): string {
  return `${backend}::${planId}`
}

function runViewFrom(backendId: string, runId: string, run: any, status: any): ComputeRunView {
  return {
    runId,
    backend: backendId,
    planId: run?.planId,
    taskDescription: run?.taskDescription,
    status: status?.status ?? run?.status ?? 'running',
    currentPhase: status?.backendData?.currentPhase ?? 'full',
    command: run?.command ?? '',
    scriptPath: run?.scriptPath,
    sandbox: run?.backendData?.sandbox ?? backendId,
    weight: run?.backendData?.weight ?? 'heavy',
    startedAt: run?.startedAt,
    lastOutputAt: status?.lastOutputAt,
    elapsedSeconds: status?.elapsedSeconds ?? 0,
    outputBytes: status?.outputBytes ?? 0,
    outputLines: status?.outputLines ?? 0,
    timeoutMs: undefined,
    stallThresholdMs: undefined,
    stalled: status?.stalled ?? false,
    progress: status?.progress,
    outputTail: status?.outputTail ?? '',
    failure: status?.failure,
    exitCode: status?.exitCode,
    parentRunId: run?.parentRunId,
    estimatedCostUsd: status?.estimatedCostUsd ?? run?.estimatedCostUsd,
    costThresholdUsd: status?.backendData?.costThresholdUsd ?? run?.backendData?.costThresholdUsd,
    costEstimate: status?.backendData?.costEstimate,
    image: status?.backendData?.image ?? run?.backendData?.image,
    backendData: status?.backendData ?? run?.backendData,
    backendDataVersion: status?.backendDataVersion ?? run?.backendDataVersion,
  }
}

function runViewFromStatusOnly(backendId: string, runId: string, status: any, prev?: ComputeRunView): ComputeRunView {
  const base = prev ?? {
    runId,
    backend: backendId,
    status: 'running',
    currentPhase: 'full',
    command: '',
    sandbox: backendId,
    weight: 'heavy',
    elapsedSeconds: 0,
    outputBytes: 0,
    outputLines: 0,
    stalled: false,
    outputTail: '',
  } as ComputeRunView
  return {
    ...base,
    status: status?.status ?? base.status,
    elapsedSeconds: status?.elapsedSeconds ?? base.elapsedSeconds,
    outputBytes: status?.outputBytes ?? base.outputBytes,
    outputLines: status?.outputLines ?? base.outputLines,
    outputTail: status?.outputTail ?? base.outputTail,
    lastOutputAt: status?.lastOutputAt ?? base.lastOutputAt,
    stalled: status?.stalled ?? base.stalled,
    progress: status?.progress ?? base.progress,
    failure: status?.failure ?? base.failure,
    exitCode: status?.exitCode ?? base.exitCode,
    estimatedCostUsd: status?.estimatedCostUsd ?? base.estimatedCostUsd,
    costThresholdUsd: status?.backendData?.costThresholdUsd ?? base.costThresholdUsd,
    costEstimate: status?.backendData?.costEstimate ?? base.costEstimate,
    image: status?.backendData?.image ?? base.image,
    currentPhase: status?.backendData?.currentPhase ?? base.currentPhase,
    backendData: status?.backendData ?? base.backendData,
    backendDataVersion: status?.backendDataVersion ?? base.backendDataVersion,
  }
}

function planViewFrom(event: any): ComputePlanView {
  const plan = event.plan ?? event.record?.plan ?? {}
  return {
    backend: event.backend ?? plan.backend,
    planId: event.planId ?? plan.planId,
    taskDescription: plan.taskDescription,
    command: plan.command,
    scriptPath: plan.scriptPath,
    taskProfile: plan.taskProfile,
    image: plan.backendData?.image,
    costEstimate: plan.costEstimate
      ? {
          estimatedTotalUsd: plan.costEstimate.estimatedTotalUsd,
          gpuRateUsdPerHour: plan.costEstimate.hourlyRateUsd ?? plan.costEstimate.gpuRateUsdPerHour,
          expectedDurationMinutes: plan.costEstimate.expectedDurationMinutes,
          notes: plan.costEstimate.notes,
        }
      : undefined,
    createdAt: plan.createdAt ?? new Date().toISOString(),
    approved: event.record?.approved ?? false,
    rejectedAt: event.record?.rejectedAt,
    rejectionComments: event.record?.rejectionComments,
    requiresApproval: event.requiresApproval ?? event.record?.effectiveRequiresApproval ?? false,
    backendData: plan.backendData,
    backendDataVersion: plan.backendDataVersion,
  }
}

export const useComputeStore = create<ComputeState>((set, get) => ({
  runs: new Map(),
  backends: new Map(),
  pendingPlans: new Map(),
  environment: null,

  applyEvent: (event) => {
    if (!event || typeof event !== 'object') return
    const state = get()
    switch (event.kind) {
      case 'availability-changed': {
        const backends = new Map(state.backends)
        const existing = backends.get(event.backend) ?? {
          id: event.backend,
          displayName: event.backend,
          toolPrefix: event.backend,
        }
        backends.set(event.backend, { ...existing, availability: event.availability })
        set({ backends })
        return
      }
      case 'plan-ready': {
        const plans = new Map(state.pendingPlans)
        plans.set(planKey(event.backend, event.planId), planViewFrom(event))
        set({ pendingPlans: plans })
        return
      }
      case 'plan-approved': {
        const plans = new Map(state.pendingPlans)
        const existing = plans.get(planKey(event.backend, event.planId))
        if (existing) {
          plans.set(planKey(event.backend, event.planId), { ...existing, approved: true })
          set({ pendingPlans: plans })
        }
        return
      }
      case 'plan-rejected': {
        const plans = new Map(state.pendingPlans)
        const existing = plans.get(planKey(event.backend, event.planId))
        if (existing) {
          plans.set(planKey(event.backend, event.planId), {
            ...existing,
            approved: false,
            rejectedAt: event.rejectedAt,
            rejectionComments: event.comments,
          })
          set({ pendingPlans: plans })
        }
        return
      }
      case 'run-update':
      case 'run-complete': {
        const runs = new Map(state.runs)
        const prev = runs.get(event.runId)
        runs.set(event.runId, runViewFromStatusOnly(event.backend, event.runId, event.status, prev))
        // On terminal, drop the pending plan if any still referenced this run's planId.
        if (event.kind === 'run-complete' && prev?.planId) {
          const plans = new Map(state.pendingPlans)
          plans.delete(planKey(event.backend, prev.planId))
          set({ runs, pendingPlans: plans })
        } else {
          set({ runs })
        }
        return
      }
      case 'cost-killed': {
        const runs = new Map(state.runs)
        const prev = runs.get(event.runId)
        if (prev) {
          runs.set(event.runId, {
            ...prev,
            status: 'cost_killed',
            estimatedCostUsd: event.estimatedCostUsd,
            costThresholdUsd: event.thresholdUsd,
          })
          set({ runs })
        }
        return
      }
      default:
        return
    }
  },

  hydrateRuns: (entries) => {
    const runs = new Map(get().runs)
    for (const entry of entries) {
      const backendId = entry.run?.backend ?? 'local'
      runs.set(entry.run.runId, runViewFrom(backendId, entry.run.runId, entry.run, entry.status))
    }
    set({ runs })
  },

  hydratePendingPlans: (entries) => {
    const plans = new Map(get().pendingPlans)
    for (const entry of entries) {
      const event = {
        backend: entry.backend,
        planId: entry.planId,
        plan: entry.record?.plan,
        record: entry.record,
        requiresApproval: entry.record?.effectiveRequiresApproval ?? false,
      }
      plans.set(planKey(entry.backend, entry.planId), planViewFrom(event))
    }
    set({ pendingPlans: plans })
  },

  updateRun: (runId, data) =>
    set((state) => {
      const next = new Map(state.runs)
      const existing = next.get(runId)
      if (existing) {
        next.set(runId, { ...existing, ...data })
      } else {
        next.set(runId, {
          runId,
          backend: 'local',
          status: 'running',
          currentPhase: 'full',
          command: '',
          sandbox: 'process',
          weight: 'heavy',
          elapsedSeconds: 0,
          outputBytes: 0,
          outputLines: 0,
          stalled: false,
          outputTail: '',
          ...data,
        } as ComputeRunView)
      }
      return { runs: next }
    }),

  removeRun: (runId) =>
    set((state) => {
      const next = new Map(state.runs)
      next.delete(runId)
      return { runs: next }
    }),

  clearModalPendingPlan: () => set((state) => {
    const next = new Map(state.pendingPlans)
    for (const [k, v] of next) {
      if (v.backend === 'modal') next.delete(k)
    }
    return { pendingPlans: next }
  }),

  reset: () => set({ runs: new Map(), backends: new Map(), pendingPlans: new Map(), environment: null }),
}))

// ---------------------------------------------------------------------------
// Derived selectors — preserve legacy API for ComputeView / LiteratureSidebar
// ---------------------------------------------------------------------------

export function useActiveRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values()).filter(
    (r) => r.status === 'running' || r.status === 'stalled' || r.status === 'queued' || r.status === 'pending_approval'
  )
}

export function useRecentRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values())
    .filter((r) => !['running', 'stalled', 'queued', 'pending_approval'].includes(r.status))
    .sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0
      return bTime - aTime
    })
    .slice(0, 20)
}

export function useActiveRunCount(): number {
  const runs = useComputeStore((s) => s.runs)
  let count = 0
  for (const r of runs.values()) {
    if (['running', 'stalled', 'queued', 'pending_approval'].includes(r.status)) count++
  }
  return count
}

/**
 * Legacy selector: returns the most recent pending Modal plan if any,
 * else null. Mirrors the PR #62 API so ComputeView doesn't have to
 * change.
 */
export function usePendingModalPlan(): ComputePlanView | null {
  const plans = useComputeStore((s) => s.pendingPlans)
  for (const plan of plans.values()) {
    if (plan.backend === 'modal' && !plan.approved && !plan.rejectedAt) return plan
  }
  return null
}

/**
 * Legacy selector: returns Modal availability derived from the
 * backends map. cliInstalled is inferred (an availability with no
 * "CLI not installed" requirement implies it's installed).
 */
export function useModalAvailability(): ModalAvailability | null {
  const backends = useComputeStore((s) => s.backends)
  const modal = backends.get('modal')
  if (!modal?.availability) return null
  const missing = modal.availability.missingRequirements ?? []
  const cliMissing = missing.some(m => m.toLowerCase().includes('cli'))
  const credsMissing = missing.some(m => m.toLowerCase().includes('credentials'))
  return {
    available: modal.availability.available,
    cliInstalled: !cliMissing,
    hasCredentials: !credsMissing,
  }
}
