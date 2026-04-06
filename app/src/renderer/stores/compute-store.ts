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

export interface ComputeRunView {
  runId: string
  status: string
  currentPhase: string
  command: string
  sandbox: string
  weight: string
  startedAt?: string
  elapsedSeconds: number
  outputBytes: number
  outputLines: number
  stalled: boolean
  progress?: ComputeProgress
  outputTail: string
  failure?: ComputeFailure
  exitCode?: number
  parentRunId?: string
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

interface ComputeState {
  runs: Map<string, ComputeRunView>
  environment: EnvironmentSummary | null

  // Actions
  updateRun: (runId: string, data: Partial<ComputeRunView>) => void
  removeRun: (runId: string) => void
  setEnvironment: (env: EnvironmentSummary) => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useComputeStore = create<ComputeState>((set) => ({
  runs: new Map(),
  environment: null,

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

  reset: () => set({ runs: new Map(), environment: null }),
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
