/**
 * Paper Pack Report state machine (RFC-007 PR-A).
 *
 * The Quick Action button in LiteratureSidebar reads its label /
 * disabled-ness / handler from this store. The button is the entire
 * pipeline's status display, not just for report generation — six
 * distinct states across the (enrichment → wiki → ready → generate
 * → done) flow.
 *
 * The state-derivation function `deriveButtonState` is pure: it takes
 * a snapshot of every input it needs and returns one of the seven
 * states. That isolation is the point — derivation logic is unit-
 * tested without any IPC, LLM, or live store mutation.
 *
 * The store itself:
 *   1. mirrors external state (wiki status, enrichment status, papers)
 *      via subscriptions or selectors,
 *   2. holds the report-specific state (status, hash, currentStep, …),
 *   3. exposes `buttonState` as a derived value re-computed whenever
 *      any of the inputs change.
 *
 * In PR-A the click handlers for 'ready' (Generate), 'done' (Open),
 * and 'error' (Retry) are no-ops — they'll be wired in PR-B when the
 * headless generator lands.
 */

import { create } from 'zustand'
import { useEntityStore } from './entity-store'
import { useEnrichmentStore } from './enrichment-store'
import {
  deriveButtonState,
  computeInputHash,
  type ReportButtonState,
  type ReportStatus,
  type WikiStatusShape,
  type ButtonStateInputs,
} from './report-button-state'

// Re-export so existing consumers of `report-store` keep working.
// The pure logic lives in `report-button-state.ts` (no Zustand,
// no window dependency, importable under node:test).
export {
  deriveButtonState,
  computeInputHash,
  type ReportButtonState,
  type ReportStatus,
  type WikiStatusShape,
  type ButtonStateInputs,
}

// ─── Store ───────────────────────────────────────────────────────────────

interface ApiSurface {
  onWikiStatus?: (cb: (s: WikiStatusShape) => void) => () => void
  wikiGetStatus?: () => Promise<WikiStatusShape | null>
  // RFC-007 PR-B — paper report IPC entry points.
  generatePaperReport?: (opts?: { force?: boolean }) => Promise<{
    success: boolean
    markdownPath?: string
    htmlPath?: string
    inputHash?: string
    error?: string
    cacheHit?: boolean
  }>
  getPaperReportState?: () => Promise<{
    status: 'idle' | 'running' | 'done' | 'error'
    inputHash?: string
    generatedAt?: string
    markdownPath?: string
    htmlPath?: string
    error?: string
  } | null>
  openPaperReport?: () => Promise<{ success: boolean; error?: string }>
  onPaperReportProgress?: (cb: (event: {
    step: string
    percent: number
    detail?: string
  }) => void) => () => void
}

function getApi(): ApiSurface {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { api: ApiSurface }).api ?? {}
}

interface ReportStoreState {
  // Mirrored pipeline inputs (the report-store keeps its own snapshot
  // of wiki status so we don't need every consumer of the button to
  // subscribe to wiki events themselves).
  wikiStatus: WikiStatusShape | null

  // Report-specific state. In PR-A this lives only in memory; PR-B
  // will persist to .research-pilot/report-state.json so the state
  // survives app restarts.
  reportStatus: ReportStatus
  reportInputHash?: string
  reportPath?: string
  reportError?: string
  generationStep?: string
  generationPercent?: number

  /**
   * Wire up the wiki status listener (and prime with one initial
   * fetch). Mounted once at App level. Returns an unsubscribe.
   */
  subscribeToWikiStatus: () => () => void

  /**
   * Internal: trigger enrichment for the entire current library.
   * The button uses this when in 'pre-enrichment' state.
   *
   * Reads from useEntityStore directly (no parameter needed) so the
   * button click handler stays one-line.
   */
  triggerEnrichmentForAllPapers: () => Promise<void>

  /**
   * Trigger report generation via main process. Sets `reportStatus`
   * to 'running' synchronously, awaits the IPC call, settles to
   * 'done' / 'error' based on result. Force=true skips the input-hash
   * cache check on the main side (regenerate even when nothing changed).
   */
  generateReport: (opts?: { force?: boolean }) => Promise<void>

  /** Open the generated HTML in the user's default browser. */
  openReport: () => Promise<void>

  /** Clear the error state. Used by the button's 'error' handler. */
  retryFailed: () => void

  /**
   * Hydrate the store from `<project>/.research-pilot/report-state.json`.
   * Called once on app startup so a `done` state persists across
   * restarts. Mounted from App.tsx.
   */
  hydrateFromDisk: () => Promise<void>

  /**
   * Wire up the `report:progress` listener. Returns an unsubscribe.
   * Mounted once at app level alongside the other subscribers.
   */
  subscribeToReportProgress: () => () => void
}

export const useReportStore = create<ReportStoreState>((set, get) => ({
  wikiStatus: null,
  reportStatus: 'idle',

  subscribeToWikiStatus: () => {
    const api = getApi()
    // Prime once at startup so the very first render of LiteratureSidebar
    // doesn't have to wait for a wiki tick.
    api.wikiGetStatus?.().then((s) => {
      if (s) set({ wikiStatus: s })
    }).catch(() => {})

    if (!api.onWikiStatus) return () => {}
    return api.onWikiStatus((status) => set({ wikiStatus: status }))
  },

  triggerEnrichmentForAllPapers: async () => {
    const papers = useEntityStore.getState().papers
    const enrichStatus = useEnrichmentStore.getState().status
    // Diagnostic — surfaces which guard, if any, swallowed the click.
    // Cheap; left in place because it's the only signal we have when
    // the button looks unresponsive.
    console.log(
      '[paper-report] triggerEnrichmentForAllPapers: papers=%d, enrichment.status=%s',
      papers.length, enrichStatus,
    )
    if (papers.length === 0) return
    const ids = papers.map((p) => p.id)
    await useEnrichmentStore.getState().enrichAll(ids)
  },

  generateReport: async (opts) => {
    const api = getApi()
    if (!api.generatePaperReport) {
      console.warn('[report-store] generatePaperReport IPC unavailable')
      return
    }
    set({
      reportStatus: 'running',
      generationStep: 'starting',
      generationPercent: 0,
      reportError: undefined,
    })
    try {
      const result = await api.generatePaperReport(opts)
      if (result.success) {
        set({
          reportStatus: 'done',
          reportInputHash: result.inputHash,
          reportPath: result.htmlPath ?? result.markdownPath,
          reportError: undefined,
          generationStep: undefined,
          generationPercent: undefined,
        })
      } else {
        set({
          reportStatus: 'error',
          reportError: result.error ?? 'Generation failed',
          generationStep: undefined,
          generationPercent: undefined,
        })
      }
    } catch (err) {
      set({
        reportStatus: 'error',
        reportError: err instanceof Error ? err.message : String(err),
        generationStep: undefined,
        generationPercent: undefined,
      })
    }
  },

  openReport: async () => {
    const api = getApi()
    if (!api.openPaperReport) {
      console.warn('[report-store] openPaperReport IPC unavailable')
      return
    }
    const result = await api.openPaperReport()
    if (!result.success) {
      // Don't move to 'error' — opening is a user-facing action, not a
      // generation failure. Surface via console for now; PR-C could
      // add a toast.
      console.warn('[report-store] openPaperReport failed:', result.error)
    }
  },

  retryFailed: () => {
    set({ reportStatus: 'idle', reportError: undefined })
  },

  hydrateFromDisk: async () => {
    const api = getApi()
    if (!api.getPaperReportState) return
    try {
      const persisted = await api.getPaperReportState()
      if (!persisted) return
      // Map persisted shape (which may have 'idle'/'running'/'done'/'error')
      // back into the store's mirror.
      set({
        reportStatus: persisted.status,
        reportInputHash: persisted.inputHash,
        reportPath: persisted.htmlPath ?? persisted.markdownPath,
        reportError: persisted.error,
      })
    } catch {
      // Quiet — missing or unreadable state file isn't worth surfacing.
    }
  },

  subscribeToReportProgress: () => {
    const api = getApi()
    if (!api.onPaperReportProgress) return () => {}
    return api.onPaperReportProgress((event) => {
      // Only consume events while we believe a run is happening.
      if (get().reportStatus !== 'running') return
      set({
        generationStep: event.step + (event.detail ? ` (${event.detail})` : ''),
        generationPercent: event.percent,
      })
    })
  },
}))

// ─── Selector hook for the button view ───────────────────────────────────

/**
 * Hook the LiteratureSidebar uses to render the button. Pulls slices
 * from three stores and runs them through `deriveButtonState`.
 *
 * Recomputes the input hash on every render so cached-result match
 * stays accurate. (Hash is fast — ~µs for hundreds of papers.)
 */
export function useReportButtonState(): {
  state: ReportButtonState
  generationStep?: string
  generationPercent?: number
  reportError?: string
  enrichmentTotal?: number
  enrichmentProcessed?: number
  wikiTotal?: number
  wikiProcessed?: number
} {
  const papers = useEntityStore((s) => s.papers)
  const enrichmentStatus = useEnrichmentStore((s) => s.status)
  const enrichmentProgress = useEnrichmentStore((s) => s.progress)
  const wikiStatus = useReportStore((s) => s.wikiStatus)
  const reportStatus = useReportStore((s) => s.reportStatus)
  const reportInputHash = useReportStore((s) => s.reportInputHash)
  const generationStep = useReportStore((s) => s.generationStep)
  const generationPercent = useReportStore((s) => s.generationPercent)
  const reportError = useReportStore((s) => s.reportError)

  const currentInputHash = computeInputHash(papers)
  const state = deriveButtonState({
    papers,
    enrichmentStatus,
    wikiStatus,
    reportStatus,
    reportInputHash,
    currentInputHash,
  })

  // Pipe progress facts that the button might want to display alongside
  // the label (e.g. "Enriching 23/100" or "Wiki 12/100").
  return {
    state,
    generationStep,
    generationPercent,
    reportError,
    enrichmentTotal: enrichmentProgress?.total,
    enrichmentProcessed: enrichmentProgress?.processed,
    wikiTotal: wikiStatus ? wikiStatus.processed + wikiStatus.pending : undefined,
    wikiProcessed: wikiStatus?.processed,
  }
}
