/**
 * Failure Signal Derivation — pure function, no side effects.
 *
 * Maps raw facts (exit code, stderr, status) to structured failure signals
 * with machine-readable codes and actionable suggestions for the agent.
 *
 * Priority-ordered: first matching rule wins.
 */

import type { RunRecord, FailureSignal } from './types.js'

/**
 * Derive a structured failure signal from run facts.
 * Returns undefined for successful runs.
 */
export function deriveFailure(run: RunRecord): FailureSignal | undefined {
  if (run.status === 'completed') return undefined
  if (run.status === 'cancelled') return undefined

  const stderr = run.stderrTail ?? ''
  const exit = run.exitCode

  // Priority 1: OOM (exit 137 = SIGKILL, or MemoryError in output)
  if (exit === 137 || /\bMemoryError\b|OOM|Cannot allocate memory/i.test(stderr) || (exit === 137 && /\bKilled\b$/m.test(stderr))) {
    return {
      code: 'OOM_KILLED',
      retryable: true,
      message: 'Process was killed due to insufficient memory.',
      suggestions: [
        'Reduce the dataset size or batch size.',
        'Close other memory-intensive applications.',
        'Process large data in chunks if possible.',
      ],
    }
  }

  // Priority 2: Timeout
  if (run.status === 'timed_out') {
    const timeoutMin = Math.round(run.timeoutMs / 60_000)
    return {
      code: 'TIMEOUT',
      retryable: true,
      message: `Process exceeded the ${timeoutMin}-minute timeout.`,
      suggestions: [
        'Increase the timeout_minutes parameter.',
        'Optimize the code for faster execution.',
        'Process a smaller subset of the data.',
      ],
    }
  }

  // Priority 3: Stall (only check status, not the flag — flag may be stale after exit)
  if (run.status === 'stalled') {
    return {
      code: 'STALL',
      retryable: true,
      message: 'Process stopped producing output and appears stuck.',
      suggestions: [
        'Check for deadlocks or blocking I/O in the code.',
        'Add progress logging to detect where execution hangs.',
        'Check if the process is waiting for interactive input.',
      ],
    }
  }

  // Priority 4: Missing Python module
  if (/ModuleNotFoundError|No module named/i.test(stderr)) {
    const moduleMatch = stderr.match(/No module named '([^']+)'/i)
      ?? stderr.match(/ModuleNotFoundError:\s*No module named\s+'?([^\s']+)/i)
    const moduleName = moduleMatch?.[1] ?? 'unknown'
    return {
      code: 'MODULE_NOT_FOUND',
      retryable: true,
      message: `Python module not found: ${moduleName}`,
      suggestions: [
        `Add "${moduleName}" to requirements.txt and retry.`,
        `Or install directly: pip install ${moduleName}`,
      ],
    }
  }

  // Priority 5: Permission denied
  if (/PermissionError|EACCES|Permission denied/i.test(stderr)) {
    return {
      code: 'PERMISSION_DENIED',
      retryable: false,
      message: 'Permission denied during execution.',
      suggestions: [
        'Check file permissions on input/output paths.',
        'Ensure the output directory is writable.',
      ],
    }
  }

  // Priority 6: Python error (traceback or exception class at line start)
  if (/Traceback \(most recent call last\)/i.test(stderr) || /^\w+Error:/m.test(stderr) || /^\w+Exception:/m.test(stderr)) {
    // Try to extract the last error line
    const lines = stderr.split('\n').filter(l => l.trim())
    const lastErrorLine = lines[lines.length - 1] ?? ''
    return {
      code: 'PYTHON_ERROR',
      retryable: true,
      message: `Python error: ${lastErrorLine.slice(0, 200)}`,
      suggestions: [
        'Read the stderr output to understand the error.',
        'Fix the code and retry.',
      ],
    }
  }

  // Priority 7: Killed by signal (non-OOM)
  if (run.exitSignal) {
    return {
      code: 'SIGNAL_KILLED',
      retryable: run.exitSignal === 'SIGTERM', // SIGTERM is often retryable
      message: `Process was killed by signal: ${run.exitSignal}`,
      suggestions: [
        'Check if another process or the system killed this task.',
        'If the signal was SIGTERM, it may be safe to retry.',
      ],
    }
  }

  // Priority 8: Generic command failure
  return {
    code: 'COMMAND_FAILED',
    retryable: false,
    message: `Command exited with code ${exit ?? 'unknown'}.`,
    suggestions: [
      'Review stderr output for details on the failure.',
      'Fix the script error and re-submit.',
    ],
  }
}
