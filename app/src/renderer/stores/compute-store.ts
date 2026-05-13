/**
 * Compute Store — Zustand store for local compute run state.
 *
 * Receives events from main process via IPC:
 * - compute:run-update — progress updates during execution
 * - compute:run-complete — run finished (success/fail/timeout/cancel)
 * - compute:environment — system environment info
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
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

export interface ComputeRunView {
  runId: string
  target?: 'local' | 'modal'
  planId?: string
  taskDescription?: string
  status: string
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
}

export interface EnvironmentSummary {
  os: string
  arch: string
  cpuCores: number
  totalMemoryMb: number
  freeMemoryMb?: number
  freeDiskMb?: number
  gpu?: string
  mlxAvailable?: boolean
  sandbox: string
}

export interface ModalAvailability {
  available: boolean
  cliInstalled: boolean
  hasCredentials: boolean
}

export interface ModalPlanView {
  planId: string
  taskDescription?: string
  command: string
  scriptPath: string
  image: ModalImageView
  costEstimate: ModalCostEstimateView
  taskProfile?: {
    expectedDurationClass?: 'seconds' | 'minutes' | 'hours'
    durationReasoning?: string
  }
  createdAt: string
  approved: boolean
  rejectedAt?: string
  rejectionComments?: string
}

interface ComputeState {
  runs: Map<string, ComputeRunView>
  environment: EnvironmentSummary | null
  modalPendingPlan: ModalPlanView | null
  modalAvailable: ModalAvailability | null

  // Actions
  updateRun: (runId: string, data: Partial<ComputeRunView>) => void
  removeRun: (runId: string) => void
  setEnvironment: (env: EnvironmentSummary) => void
  setModalPendingPlan: (plan: ModalPlanView | null) => void
  clearModalPendingPlan: () => void
  setModalAvailable: (available: ModalAvailability) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useComputeStore = create<ComputeState>((set) => ({
  runs: new Map(),
  environment: null,
  modalPendingPlan: null,
  modalAvailable: null,

  updateRun: (runId, data) =>
    set((state) => {
      const next = new Map(state.runs)
      const existing = next.get(runId)
      if (existing) {
        next.set(runId, { ...existing, ...data })
      } else {
        next.set(runId, {
          runId,
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

  setEnvironment: (env) => set({ environment: env }),
  setModalPendingPlan: (plan) => set({ modalPendingPlan: plan }),
  clearModalPendingPlan: () => set({ modalPendingPlan: null }),
  setModalAvailable: (available) => set({ modalAvailable: available }),

  reset: () => set({ runs: new Map(), environment: null, modalPendingPlan: null, modalAvailable: null }),
}))

// ---------------------------------------------------------------------------
// Derived selectors
// ---------------------------------------------------------------------------

export function useActiveRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values()).filter(
    (r) => r.status === 'running' || r.status === 'stalled'
  )
}

export function useRecentRuns(): ComputeRunView[] {
  const runs = useComputeStore((s) => s.runs)
  return Array.from(runs.values())
    .filter((r) => r.status !== 'running' && r.status !== 'stalled')
    .sort((a, b) => {
      // Sort by startedAt timestamp descending (most recent first)
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
    if (r.status === 'running' || r.status === 'stalled') count++
  }
  return count
}

export function usePendingModalPlan(): ModalPlanView | null {
  return useComputeStore((s) => s.modalPendingPlan)
}
