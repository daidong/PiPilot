import type { FailureSignal, StructuredProgress } from '../local-compute/types.js'

export interface ModalTaskProfile {
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
  durationReasoning: string
  reasoning: string
}

export type ModalRunState =
  | 'pending_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'cost_killed'

export function isModalTerminal(state: ModalRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled' || state === 'cost_killed'
}

export type ModalPythonPackageInstaller = 'uv_pip_install' | 'pip_install' | 'micromamba_install'

export interface ModalImageInspection {
  source: 'script' | 'modal_default' | 'unknown'
  baseImage: string
  pythonVersion: string | null
  pythonPackages: string[]
  pythonPackageInstallers: ModalPythonPackageInstaller[]
  systemPackages: string[]
  envVars: string[]
  localDirs: string[]
  localFiles: string[]
  localPythonSources: string[]
  buildCommands: string[]
  buildFunctions: string[]
  buildGpuType: string | null
  runtimeGpuType: string | null
  gpuType: string | null
  forceBuild: boolean
  warnings: string[]
  reasoning: string
}

export interface ModalCostEstimate {
  gpuRateUsdPerHour: number
  expectedDurationMinutes: number
  estimatedTotalUsd: number
  notes: string
}

export interface ModalPendingPlan {
  planId: string
  createdAt: string
  approved: boolean
  approvedAt?: string
  rejectedAt?: string
  rejectionComments?: string
  taskDescription?: string
  command: string
  scriptPath: string
  image: ModalImageInspection
  costEstimate: ModalCostEstimate
  taskProfile: ModalTaskProfile
}

export interface ModalRunRecord {
  runId: string
  planId: string
  taskDescription?: string
  status: ModalRunState
  command: string
  scriptPath: string
  image: ModalImageInspection
  costEstimate: ModalCostEstimate
  createdAt: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  error?: string
  outputPath: string
  outputBytes: number
  outputLines: number
  lastOutputAt?: string
  timeoutMs: number
  stallThresholdMs: number
  stalled: boolean
  pid?: number
  retryCount: number
  parentRunId?: string
  estimatedCostSoFar?: number
}

export interface ModalSubmitConfig {
  plan: ModalPendingPlan
  timeoutMinutes?: number
  stallThresholdMinutes?: number
  parentRunId?: string
}

export interface ModalRunStatusResult {
  status: ModalRunState
  planId?: string
  taskDescription?: string
  command?: string
  scriptPath?: string
  image?: ModalImageInspection
  costEstimate?: ModalCostEstimate
  costThresholdUsd?: number
  exitCode?: number
  outputTail: string
  outputBytes: number
  outputLines: number
  lastOutputAt?: string
  timeoutMs?: number
  stallThresholdMs?: number
  startedAt?: string
  elapsedSeconds: number
  stalled: boolean
  estimatedCostUsd?: number
  progress?: StructuredProgress
  failure?: FailureSignal
}
