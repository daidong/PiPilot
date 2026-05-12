/**
 * Pure logic for the Paper Report button state machine (RFC-007 PR-A).
 *
 * Extracted from `report-store.ts` so tests can exercise it under
 * `node:test` without pulling in entity-store / enrichment-store /
 * window-api dependencies. This file imports NO Zustand and NO
 * renderer-only modules — only types.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type ReportButtonState =
  | 'no-papers'        // library is empty
  | 'pre-enrichment'   // papers exist, not yet (or partially) enriched
  | 'enriching'        // enrichment cycle in flight
  | 'pre-wiki'         // enrichment done, wiki still processing
  | 'ready'            // pipeline caught up, button is the primary CTA
  | 'generating'       // report generation in flight
  | 'done'             // report exists and matches current input hash
  | 'error'            // last generation attempt failed

export type ReportStatus = 'idle' | 'running' | 'done' | 'error'

export interface WikiStatusShape {
  state: 'processing' | 'idle' | 'paused' | 'disabled'
  processed: number
  pending: number
  totalInWiki: number
  lastRunAt?: string
}

/**
 * Minimal shape we need to know about each paper. Kept loose so the
 * test fixtures don't have to mock the full EntityItem.
 */
export interface PaperShape {
  id: string
  title?: string
  authors?: string[]
  year?: number
  venue?: string
  abstract?: string
  doi?: string
  citationCount?: number
  citeKey?: string
  enrichedAt?: string
}

export interface ButtonStateInputs {
  papers: PaperShape[]
  enrichmentStatus: 'idle' | 'running'
  wikiStatus: WikiStatusShape | null
  reportStatus: ReportStatus
  reportInputHash?: string
  currentInputHash: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Mirrors LiteratureSidebar's existing "is paper sufficiently enriched"
// threshold — keeping the heuristic in one place would be nice eventually,
// but for PR-A consistency-by-duplication is acceptable.
const CORE_FIELDS = ['title', 'authors', 'year', 'venue', 'abstract', 'doi', 'citationCount'] as const

function countCoreFields(paper: PaperShape): number {
  let count = 0
  for (const field of CORE_FIELDS) {
    const v = (paper as Record<string, unknown>)[field]
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    // Treat unknown:* DOIs as missing for the enrichment-readiness check —
    // they're placeholders set by upsertPaperArtifact when no real DOI
    // is available, not real metadata.
    if (field === 'doi' && typeof v === 'string' && v.startsWith('unknown:')) continue
    count++
  }
  return count
}

/**
 * Are MOST papers in the library well-enriched? A 90% threshold tolerates
 * the inevitable few papers that can never be enriched (no DOI, no arXiv,
 * Crossref miss). Without tolerance the button would never reach 'ready'
 * for libraries with any unmatchable items.
 */
export function allPapersWellEnriched(papers: PaperShape[]): boolean {
  if (papers.length === 0) return false
  const enriched = papers.filter((p) => countCoreFields(p) >= 5).length
  return enriched / papers.length >= 0.9
}

/**
 * Compute a stable content-hash of the current paper set for cache-
 * matching. In PR-A this isn't yet compared against a stored hash
 * (no report exists), but the function is in place so PR-B's
 * generator can both write and read it consistently.
 *
 * Hash inputs include only fields whose change should invalidate the
 * cached report. Order-independent (sort first).
 */
export function computeInputHash(papers: PaperShape[]): string {
  const parts = papers
    .map((p) => `${p.id}|${p.citeKey ?? ''}|${p.enrichedAt ?? ''}`)
    .sort()
  // Lightweight FNV-1a — we're not crypto-hashing, just keying. The
  // real generator (PR-B) can swap in sha256 if collisions become a
  // concern; the cache miss-on-collision is silent and safe.
  let hash = 2166136261
  for (const s of parts.join('\n')) {
    hash ^= s.charCodeAt(0)
    hash = (hash * 16777619) >>> 0
  }
  return hash.toString(16)
}

// ─── Pure derivation ─────────────────────────────────────────────────────

export function deriveButtonState(inputs: ButtonStateInputs): ReportButtonState {
  // Terminal report states win over pipeline state — once the report
  // is being generated, what enrichment / wiki are doing is irrelevant.
  if (inputs.reportStatus === 'running') return 'generating'
  if (inputs.reportStatus === 'error') return 'error'

  // Cached-result match — but only if the inputs haven't changed since
  // generation. If the hash differs (user added more papers, or wiki
  // re-processed something), fall through to whatever the pipeline says
  // now.
  if (
    inputs.reportStatus === 'done' &&
    inputs.reportInputHash &&
    inputs.reportInputHash === inputs.currentInputHash
  ) {
    return 'done'
  }

  // Empty library — nothing to report on.
  if (inputs.papers.length === 0) return 'no-papers'

  // Enrichment in flight → show its progress.
  if (inputs.enrichmentStatus === 'running') return 'enriching'

  // Enrichment idle but papers thin → need user to kick off enrichment.
  // (Auto-trigger on import handles the common path; this catches the
  // "user reopened the project mid-enrichment" edge case.)
  if (!allPapersWellEnriched(inputs.papers)) return 'pre-enrichment'

  // Enrichment looks satisfied. Now gate on wiki.
  if (!inputs.wikiStatus) return 'pre-wiki'  // wiki status not loaded yet
  if (inputs.wikiStatus.state === 'disabled') return 'pre-wiki'
  if (inputs.wikiStatus.state === 'processing') return 'pre-wiki'
  if (inputs.wikiStatus.pending > 0) return 'pre-wiki'

  // Everything's caught up — primary CTA.
  return 'ready'
}
