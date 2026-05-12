/**
 * Persistent report state (RFC-007 PR-B).
 *
 * `<project>/.research-pilot/report-state.json` holds:
 *   - last generation outcome (status / paths / error)
 *   - inputHash for cache match (the button's `done` state requires
 *     the persisted hash to equal the live one)
 *
 * Forward-compat: bump `schemaVersion` if we ever change the shape.
 * Reads of unknown schema return `null` (treated as "no prior report").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATHS } from '../types.js'

export const REPORT_STATE_SCHEMA_VERSION = 1

export interface ReportPersistedState {
  schemaVersion: typeof REPORT_STATE_SCHEMA_VERSION
  status: 'idle' | 'running' | 'done' | 'error'
  /** sha256 hex (32 chars) of the input set the last successful run consumed. */
  inputHash?: string
  /** ISO timestamp of the last successful run. */
  generatedAt?: string
  /** Absolute path to the .md report. */
  markdownPath?: string
  /** Absolute path to the .html report. */
  htmlPath?: string
  /** Last error message, if status === 'error'. */
  error?: string
  /**
   * Diagnostic stats from the last successful run — surfaced in the
   * renderer for the "done" summary. Cheap to store, expensive to
   * recompute without re-reading the wiki dir.
   */
  stats?: {
    paperCount: number
    themeCount: number
    talkingPointCount: number
    onboardingCount: number
    fulltextCount: number
    abstractOnlyCount: number
  }
}

function statePath(projectPath: string): string {
  // PATHS.researchPilot points at .research-pilot/. We add our own
  // filename — no dedicated PATHS entry needed for one-off file.
  return join(projectPath, '.research-pilot', 'report-state.json')
}

export function readReportState(projectPath: string): ReportPersistedState | null {
  const file = statePath(projectPath)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    if (raw.schemaVersion !== REPORT_STATE_SCHEMA_VERSION) return null
    return raw as unknown as ReportPersistedState
  } catch {
    return null
  }
}

export function writeReportState(projectPath: string, state: ReportPersistedState): void {
  const file = statePath(projectPath)
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Convenience: blank-out the persisted state to 'idle'. Used by the
 * "Retry" button after a previous run errored.
 */
export function resetReportState(projectPath: string): void {
  writeReportState(projectPath, {
    schemaVersion: REPORT_STATE_SCHEMA_VERSION,
    status: 'idle',
  })
}

// Keep PATHS export aware of this constant — duplicating PATHS.researchPilot
// here would be brittle. We accept the small string-literal coupling.
void PATHS
