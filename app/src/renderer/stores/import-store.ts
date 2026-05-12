/**
 * BibTeX import store (RFC-006 PR-3).
 *
 * State machine for one bulk BibTeX import:
 *
 *   idle ──user picks file──► running ──completes──► done ─reset─► idle
 *                                │                       ▲
 *                                └──fatal error──► error─┘
 *
 * - `idle` — no import has run yet, or the last result was dismissed
 * - `running` — main process is mid-parse, emitting progress events
 * - `done` — import finished; UI shows the result summary + per-entry
 *   counts. The list of `failureDetails` lets the wizard render a "needs
 *   attention" panel.
 * - `error` — fatal error before any per-entry processing (file not
 *   found, not UTF-8, no @entries detected). UI shows the raw message.
 *
 * Why a separate store and not a member of `entity-store`:
 *   The entity store is consumed by every list view in the app and
 *   re-renders on every artifact change. Bulk imports emit one
 *   `import:progress` event per entry (could be hundreds), and we want
 *   to update progress in real time without thrashing the papers list.
 *
 * Why we keep the most-recent `result` after `done`:
 *   The wizard's last screen is a summary of the import. The user may
 *   click "Open Papers tab" or "Run enrichment" or "Import another
 *   file" — all branches need access to `importedPaperIds`. Resetting
 *   too eagerly forces the wizard to stash that array itself.
 */

import { create } from 'zustand'
import type { BibImportResult, BibImportProgressEvent } from '../../preload/index'

interface ImporterApi {
  pickBibtexFile: () => Promise<string | null>
  importBibtexFile: (path: string) => Promise<
    | { success: true; result: BibImportResult }
    | { success: false; error: string }
  >
  importBibtexString: (contents: string) => Promise<
    | { success: true; result: BibImportResult }
    | { success: false; error: string }
  >
  onImportProgress: (cb: (event: BibImportProgressEvent) => void) => () => void
}

// Resolve at call time so tests can stub `window.api` after module init.
// (Same pattern as trace-store.ts.)
function getApi(): ImporterApi {
  if (typeof window === 'undefined') {
    throw new Error('window.api is unavailable (not running in a renderer process)')
  }
  return (window as any).api as ImporterApi
}

export type ImportStatus = 'idle' | 'running' | 'done' | 'error'

/** Live per-entry counters updated by the progress stream. */
export interface ImportLiveCounts {
  /** Total number of entries the parser surfaced. Stable for the run. */
  total: number
  /** Number of progress events received so far (any status). */
  processed: number
  added: number
  merged: number
  mergedNoChange: number
  duplicateInFile: number
  failed: number
  /** Citekey of the most recent progress event (for UI ticker). */
  lastCiteKey?: string
  /** Status of the most recent event. */
  lastStatus?: BibImportProgressEvent['status']
}

const ZERO_COUNTS: ImportLiveCounts = {
  total: 0,
  processed: 0,
  added: 0,
  merged: 0,
  mergedNoChange: 0,
  duplicateInFile: 0,
  failed: 0,
}

interface ImportState {
  status: ImportStatus
  /** Absolute path of the file being / last imported, when known. */
  sourcePath?: string
  /** Live counts derived from the progress stream. */
  counts: ImportLiveCounts
  /** Final result, populated when status === 'done'. */
  result: BibImportResult | null
  /** Fatal-error message, populated when status === 'error'. */
  error: string | null

  /**
   * Whether the Import Wizard modal is currently visible. Held here
   * rather than in ui-store so the wizard can be opened from any CTA
   * (Papers-tab empty state, HeroIdle starter, future menu item)
   * without each call site having to wire its own `useState`.
   */
  wizardOpen: boolean

  /** Show the wizard. Does not reset progress; users may reopen mid-run. */
  openWizard: () => void
  /** Hide the wizard. Does NOT reset import progress — see closeAndReset. */
  closeWizard: () => void
  /** Hide the wizard and clear progress / result / error. */
  closeAndReset: () => void

  /** Open the native picker, then immediately start the import. */
  startFromPicker: () => Promise<void>
  /** Start importing a file by absolute path. */
  startFromFile: (path: string) => Promise<void>
  /** Start importing a .bib content string (e.g. drag-and-drop). */
  startFromString: (contents: string, label?: string) => Promise<void>
  /** Drop result / error / counts; bring status back to 'idle'. */
  reset: () => void

  /**
   * Wire up the global `import:progress` listener. Call once at app
   * startup; returns an unsubscribe function. Idempotent — re-calling
   * just registers a fresh listener and returns the new unsub.
   */
  subscribeToProgress: () => () => void
}

/**
 * Apply one progress event to a counts snapshot. Pure function so the
 * Zustand updater stays simple and the logic is testable in isolation.
 */
export function reduceCounts(
  prev: ImportLiveCounts,
  event: BibImportProgressEvent
): ImportLiveCounts {
  const next: ImportLiveCounts = {
    ...prev,
    // Each event reports the total — if it differs we trust the latest.
    total: event.total,
    processed: prev.processed + 1,
    lastCiteKey: event.citeKey,
    lastStatus: event.status,
  }
  switch (event.status) {
    case 'added':              next.added++; break
    case 'merged':             next.merged++; break
    case 'merged-no-change':   next.mergedNoChange++; break
    case 'duplicate-in-file':  next.duplicateInFile++; break
    case 'failed':             next.failed++; break
  }
  return next
}

export const useImportStore = create<ImportState>((set, get) => ({
  status: 'idle',
  sourcePath: undefined,
  counts: { ...ZERO_COUNTS },
  result: null,
  error: null,
  wizardOpen: false,

  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
  closeAndReset: () => set({
    wizardOpen: false,
    status: 'idle',
    sourcePath: undefined,
    counts: { ...ZERO_COUNTS },
    result: null,
    error: null,
  }),

  startFromPicker: async () => {
    const path = await getApi().pickBibtexFile()
    if (!path) return  // user canceled — stay in current state
    await get().startFromFile(path)
  },

  startFromFile: async (path) => {
    set({
      status: 'running',
      sourcePath: path,
      counts: { ...ZERO_COUNTS },
      result: null,
      error: null,
    })
    const response = await getApi().importBibtexFile(path)
    if (!response.success) {
      set({ status: 'error', error: response.error })
      return
    }
    set({ status: 'done', result: response.result })
  },

  startFromString: async (contents, label) => {
    set({
      status: 'running',
      sourcePath: label,
      counts: { ...ZERO_COUNTS },
      result: null,
      error: null,
    })
    const response = await getApi().importBibtexString(contents)
    if (!response.success) {
      set({ status: 'error', error: response.error })
      return
    }
    set({ status: 'done', result: response.result })
  },

  reset: () => set({
    status: 'idle',
    sourcePath: undefined,
    counts: { ...ZERO_COUNTS },
    result: null,
    error: null,
  }),

  subscribeToProgress: () => {
    return getApi().onImportProgress((event) => {
      // Only consume events while we believe an import is running.
      // This guards against late events from a previous run racing
      // a state reset, and against any future producer firing without
      // a matching `startFrom*` (e.g. test harnesses).
      if (get().status !== 'running') return
      set((state) => ({ counts: reduceCounts(state.counts, event) }))
    })
  },
}))
