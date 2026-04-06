/**
 * Local Compute — Core Type Definitions (v1.0)
 *
 * Types for sandboxed long-running task execution.
 * Design axiom: run, observe, persist, stop — zero LLM dependency.
 */

// ---------------------------------------------------------------------------
// Run State Machine
// ---------------------------------------------------------------------------

export type RunState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'cancelled'

export function isTerminal(state: RunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled'
}

// ---------------------------------------------------------------------------
// Run Record (JSONL-persisted)
// ---------------------------------------------------------------------------

export type RunWeight = 'heavy' | 'light'

export interface RunRecord {
  runId: string
  status: RunState
  weight: RunWeight
  currentPhase: 'preflight' | 'smoke' | 'full'
  command: string
  smokeCommand?: string
  workDir: string                    // Original workspace-relative dir
  sandboxWorkDir: string             // Sandbox working directory (absolute)
  sandbox: 'docker' | 'process'
  env?: Record<string, string>

  // Lifecycle timestamps (ISO)
  createdAt: string
  startedAt?: string
  completedAt?: string

  // Execution results
  exitCode?: number
  exitSignal?: string
  error?: string
  stderrTail?: string               // Last 4KB of stderr

  // Output
  outputPath: string                 // Absolute path to combined stdout+stderr file

  // Progress tracking
  outputBytes: number
  outputLines: number
  lastOutputAt?: string              // ISO — last time output file grew

  // Timeout & stall
  timeoutMs: number
  stallThresholdMs: number
  stalled: boolean

  // Process tracking (for crash recovery — detect stale runs on restart)
  pid?: number
  pidStartTime?: number          // Process start time (epoch ms) — PID+starttime pair prevents PID reuse confusion

  // Retry lineage
  retryCount: number
  parentRunId?: string
}

// ---------------------------------------------------------------------------
// Failure Classification
// ---------------------------------------------------------------------------

export type FailureCode =
  | 'OOM_KILLED'
  | 'TIMEOUT'
  | 'STALL'
  | 'MODULE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PYTHON_ERROR'
  | 'SIGNAL_KILLED'
  | 'COMMAND_FAILED'

export interface FailureSignal {
  code: FailureCode
  retryable: boolean
  message: string
  suggestions: string[]
}

// ---------------------------------------------------------------------------
// Progress Extraction
// ---------------------------------------------------------------------------

export interface StructuredProgress {
  currentStep?: number
  totalSteps?: number
  percentage?: number
  metrics?: Record<string, number>
  phase?: string
  etaSeconds?: number
}

export interface OutputProgress {
  bytesWritten: number
  estimatedLines: number
  lastOutputAt?: string
  tailContent: string                // Last 8KB
  elapsedSeconds: number
  stalled: boolean
  structured?: StructuredProgress
}

// ---------------------------------------------------------------------------
// Sandbox Provider Interface
// ---------------------------------------------------------------------------

export interface SpawnConfig {
  command: string
  workDir: string
  outputPath: string                 // Where stdout+stderr go
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface SandboxHandle {
  pid: number | string               // PID or container ID
  kill(signal?: string): Promise<void>
  wait(): Promise<{ exitCode: number; exitSignal?: string }>
  cleanup(): Promise<void>
}

export interface SandboxProvider {
  name: 'docker' | 'process'
  available(): Promise<boolean>
  spawn(config: SpawnConfig): Promise<SandboxHandle>
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface ActiveRunInfo {
  runId: string
  weight: RunWeight
}

export interface PreRunSnapshot {
  freeMemoryMb: number
  cpuLoadPercent: number
  freeDiskMb: number
  activeRuns: ActiveRunInfo[]
}

export interface SchedulerDecision {
  allowed: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// Experience (v1.1+ structured metadata)
// ---------------------------------------------------------------------------

export interface ExperienceRecord {
  runId: string
  taskKind: string
  sandbox: 'docker' | 'process'
  outcome: 'success' | 'failed' | 'timeout' | 'cancelled'
  failureCode?: FailureCode
  durationSeconds: number
  retryCount: number
  dataSizeMb?: number
  peakMemoryMb?: number
  summary?: string
  effectiveFix?: string
  timestamp: string
}

// ---------------------------------------------------------------------------
// Tool Result Types
// ---------------------------------------------------------------------------

export interface RunStatusResult {
  status: RunState
  currentPhase: string
  exitCode?: number
  outputTail: string
  outputBytes: number
  outputLines: number
  elapsedSeconds: number
  stalled: boolean
  progress?: StructuredProgress
  failure?: FailureSignal
}
