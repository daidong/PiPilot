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

  // ── PR-B placeholders (no-ops in PR-A) ────────────────────────────
  // The button's 'ready' / 'done' / 'error' handlers wire to these.
  // PR-A keeps them as stubs so the UI shape is final and only the
  // bodies change in PR-B.
  generateReport: () => Promise<void>
  openReport: () => Promise<void>
  retryFailed: () => void
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
    if (papers.length === 0) return
    const ids = papers.map((p) => p.id)
    await useEnrichmentStore.getState().enrichAll(ids)
  },

  generateReport: async () => {
    // PR-B will:
    //   1. Compute currentInputHash from papers
    //   2. Set reportStatus to 'running'
    //   3. Spawn the IPC `cmd:generate-paper-report` call
    //   4. Subscribe to `report:progress` to update generationStep / percent
    //   5. On done, set reportStatus + reportInputHash + reportPath
    //   6. On error, set reportStatus = 'error' + reportError
    console.warn('[report-store] generateReport: not implemented in PR-A')
  },

  openReport: async () => {
    // PR-B will call shell.openPath(get().reportPath).
    console.warn('[report-store] openReport: not implemented in PR-A')
  },

  retryFailed: () => {
    set({ reportStatus: 'idle', reportError: undefined })
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
