/**
 * Shared compute types — definitions used across backends.
 *
 * §7.2 of RFC-008 moved these definitions here from
 * lib/local-compute/types.ts. The latter now re-exports from here
 * so legacy import sites in local-compute and modal-compute keep
 * working until §7.10 deletes those modules.
 */

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
  tailContent: string   // Last 8KB
  elapsedSeconds: number
  stalled: boolean
  structured?: StructuredProgress
}
