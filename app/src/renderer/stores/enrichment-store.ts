/**
 * Enrichment runtime status (RFC-007 PR-A).
 *
 * The existing `enrichPaperArtifacts` exposes a per-paper callback but
 * no stateful IPC channel — the renderer can't ask "is enrichment
 * running right now?" out of the box. The Paper Report button state
 * machine (`report-store.ts`) needs that signal to gate properly.
 *
 * This store fills the gap. It owns the "is enrichment running"
 * boolean and the rolling progress counts. State transitions are
 * driven by the explicit `enrichAll` action — that's the only path
 * by which enrichment is dispatched in the UI today (PR-A wires the
 * ImportWizard to call it).
 *
 * Why a separate store rather than rolling this into report-store:
 * enrichment is logically independent of report generation (it's
 * triggered after import, and benefits paper-wiki + chat + literature
 * search alike), so its state has a longer half-life than any report
 * concern.
 */

import { create } from 'zustand'

interface EnrichProgressEvent {
  paperId: string
  status: 'enriching' | 'done' | 'skipped' | 'failed'
}

interface RendererApi {
  enrichAllPapers: (paperIds: string[]) => Promise<{ success: boolean; enriched: number; skipped: number; failed: number }>
  onEnrichProgress: (cb: (info: EnrichProgressEvent) => void) => () => void
}

// Resolve at call time so tests can stub `window.api` after module init.
// (Same pattern as trace-store.ts / import-store.ts.)
function getApi(): RendererApi {
  if (typeof window === 'undefined') {
    throw new Error('window.api is unavailable (not running in a renderer process)')
  }
  return (window as unknown as { api: RendererApi }).api
}

export interface EnrichmentLiveProgress {
  /** Total papers the current run is enriching. */
  total: number
  /** Count of terminal-state events received so far (done/skipped/failed). */
  processed: number
  /** Most recent paperId for UI ticker. */
  lastPaperId?: string
  /** Most recent per-paper status. */
  lastStatus?: EnrichProgressEvent['status']
}

interface EnrichmentState {
  /**
   * Coarse run state. 'idle' means nothing's in flight right now —
   * NOT "papers don't need enrichment". A consumer that wants to
   * know "do my papers have all core fields" should inspect the
   * paper artifacts directly via the entity store.
   */
  status: 'idle' | 'running'

  /** Populated while `status === 'running'`. */
  progress: EnrichmentLiveProgress | null

  /**
   * Total enrichment runs since app start. Useful to detect "an
   * enrichment cycle just finished" without poll-style timestamp
   * comparisons. Increments at the END of each run.
   */
  runsCompleted: number

  /**
   * Dispatch enrichment for the given paper IDs. Sets status to
   * 'running' synchronously, awaits the IPC call, sets status to
   * 'idle' in the finally block.
   *
   * Safe to fire-and-forget. The promise resolves when the main
   * process is done; subscribers (the report-store) react to
   * `status` flipping back to 'idle'.
   */
  enrichAll: (paperIds: string[]) => Promise<void>

  /**
   * Subscribe to per-paper progress events. Returns an unsubscribe
   * function. Idempotent — re-calling just registers a fresh
   * listener and returns the new unsub.
   *
   * Mounted once at App level (App.tsx) like import-store's
   * subscribeToProgress.
   */
  subscribeToProgress: () => () => void
}

export const useEnrichmentStore = create<EnrichmentState>((set, get) => ({
  status: 'idle',
  progress: null,
  runsCompleted: 0,

  enrichAll: async (paperIds) => {
    if (paperIds.length === 0) return
    // Guard against double-fire: if a run is already happening, drop
    // the new request. Caller (ImportWizard, future "re-run" buttons)
    // can inspect `status` if they need to decide whether to retry.
    if (get().status === 'running') return

    set({
      status: 'running',
      progress: { total: paperIds.length, processed: 0 },
    })
    try {
      await getApi().enrichAllPapers(paperIds)
    } finally {
      set((s) => ({
        status: 'idle',
        progress: null,
        runsCompleted: s.runsCompleted + 1,
      }))
    }
  },

  subscribeToProgress: () => {
    return getApi().onEnrichProgress((event) => {
      // Only consume events while we believe a run is happening.
      // Drops stray events from a prior cycle if any race past
      // the cleanup.
      if (get().status !== 'running') return
      const cur = get().progress
      if (!cur) return

      // Each paper finishes with exactly one terminal event
      // ('done' / 'skipped' / 'failed'); 'enriching' is an
      // in-progress signal that doesn't bump the counter.
      const isTerminal =
        event.status === 'done' ||
        event.status === 'skipped' ||
        event.status === 'failed'

      set({
        progress: {
          total: cur.total,
          processed: cur.processed + (isTerminal ? 1 : 0),
          lastPaperId: event.paperId,
          lastStatus: event.status,
        },
      })
    })
  },
}))
