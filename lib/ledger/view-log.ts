/**
 * View log (telemetry-trace v0.10 §8.4).
 *
 * Renderer-side passive observation: artifact / memory / trace items the user
 * looked at without speaking. Disabled when `tracingMode='disabled'`; there is
 * no separate per-feature toggle in v0.7+.
 */

import { join } from 'node:path'
import { PATHS } from '../types.js'
import { appendJsonl } from '../telemetry/jsonl-writer.js'

export type ViewTargetKind = 'artifact' | 'memory' | 'trace' | 'session-summary'
export type ViewOp = 'view' | 'hover' | 'scroll' | 'dismiss'

export interface ViewLogRow {
  viewId: string
  projectId: string
  sessionId: string
  turnId?: string
  target: { kind: ViewTargetKind; id: string }
  op: ViewOp
  durationMs?: number
  timestamp: string
}

export interface ViewLogWriter {
  append(row: Omit<ViewLogRow, 'timestamp'> & { timestamp?: string }): Promise<boolean>
  readonly filePath: string
}

export function createViewLogWriter(projectPath: string): ViewLogWriter {
  const filePath = join(projectPath, PATHS.viewLog)
  return {
    filePath,
    async append(row) {
      const fullRow: ViewLogRow = {
        viewId: row.viewId,
        projectId: row.projectId,
        sessionId: row.sessionId,
        turnId: row.turnId,
        target: row.target,
        op: row.op,
        durationMs: row.durationMs,
        timestamp: row.timestamp ?? new Date().toISOString()
      }
      for (const k of Object.keys(fullRow) as (keyof ViewLogRow)[]) {
        if (fullRow[k] === undefined) delete fullRow[k]
      }
      return appendJsonl(filePath, fullRow, { onError: () => {} })
    }
  }
}
