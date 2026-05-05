/**
 * Tracing-state log writer (§10.1).
 *
 * Append-only audit log of operational toggles and degraded-state events:
 * - `tracingMode` flips
 * - Scrubber catalog version bumps (§7)
 * - TraceStore degraded-mode entry/exit (§5.1)
 * - Drop-counter increments (§5.1)
 * - ProjectConfig migration completion (§14)
 *
 * Path: `<projectPath>/.research-pilot/tracing-state.jsonl`
 *
 * This file is the audit trail for "did we lose any spans, and why."
 * Retained forever; only purged when the project is deleted.
 */

import { join } from 'node:path'
import { PATHS } from '../types.js'
import { appendJsonl } from './jsonl-writer.js'

export type TracingStateKind =
  | 'config-migration'
  | 'tracing-mode-change'
  | 'scrubber-version-bump'
  | 'trace-store-degraded-enter'
  | 'trace-store-degraded-exit'
  | 'trace-dropped'
  | 'span-dropped'
  | 'startup'
  | 'shutdown'

export interface TracingStateRow {
  timestamp: string
  kind: TracingStateKind
  /** Optional: previous state for transitions. */
  fromState?: string | number
  /** Optional: new state for transitions. */
  toState?: string | number
  /** 'user' | 'system'. */
  actor?: 'user' | 'system'
  /** Free-form reason. */
  reason?: string
  /** Arbitrary additional context. */
  detail?: Record<string, unknown>
}

export interface TracingStateLogger {
  append(row: Omit<TracingStateRow, 'timestamp'> & { timestamp?: string }): Promise<boolean>
  /** Resolved absolute path the logger writes to. */
  readonly filePath: string
}

/**
 * Build a tracing-state logger bound to a single project path.
 *
 * Errors are silently captured (per A4 — never block the agent). They will surface
 * through the TraceStore degraded banner and the next successful append.
 */
export function createTracingStateLogger(projectPath: string): TracingStateLogger {
  const filePath = join(projectPath, PATHS.tracingState)
  return {
    filePath,
    async append(row) {
      const fullRow: TracingStateRow = {
        timestamp: row.timestamp ?? new Date().toISOString(),
        kind: row.kind,
        fromState: row.fromState,
        toState: row.toState,
        actor: row.actor,
        reason: row.reason,
        detail: row.detail
      }
      // Strip undefined to keep the file tidy.
      for (const k of Object.keys(fullRow) as (keyof TracingStateRow)[]) {
        if (fullRow[k] === undefined) delete fullRow[k]
      }
      return appendJsonl(filePath, fullRow, {
        onError: () => {
          // Swallow: tracing-state failures must never propagate.
        }
      })
    }
  }
}
