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
  | 'enriching'        // enrichment cycle in flight (Enrich-All button or auto-trigger after import)
  | 'pre-wiki'         // wiki agent still processing
  | 'ready'            // wiki has caught up, button is the primary CTA
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

// (Removed `allPapersWellEnriched` gate per RFC-007 post-PR-A bug fix.)
//
// The original gate required 90% of papers to have ≥5 of {title, authors,
// year, venue, abstract, doi, citationCount} — but DOI and citationCount
// are CrossRef-only fields. Real-world libraries with arxiv preprints,
// older work, or non-CrossRef-indexed venues routinely fall below that
// threshold even after wiki processing has succeeded.
//
// The correct gate is wiki readiness, not enrichment depth: the Paper
// Pack Report's input is the Paper Wiki sidecars, and the wiki agent
// produces useful extractions from abstracts alone (`source_tier:
// 'abstract-only'`). If wiki is idle and pending=0, the pack is
// processable — independent of CrossRef coverage.
//
// Users who want to fill missing DOIs / citationCounts still have the
// dedicated "Enrich All" QuickAction in LiteratureSidebar. The Paper
// Report button shouldn't double as an enrichment trigger.

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

  // (Previously: an `allPapersWellEnriched` gate sat here. Removed —
  // see the comment block above the helper module's deletion. Wiki
  // readiness is the only real precondition.)
  //
  // Gate on wiki:
  if (!inputs.wikiStatus) return 'pre-wiki'  // wiki status not loaded yet
  if (inputs.wikiStatus.state === 'disabled') return 'pre-wiki'
  if (inputs.wikiStatus.state === 'processing') return 'pre-wiki'
  if (inputs.wikiStatus.pending > 0) return 'pre-wiki'
  // Wiki hasn't acknowledged all papers yet — happens in the gap
  // between BibTeX import (entity store updates first) and the next
  // wikiStatus event from the main process. Without this, the button
  // flashes 'ready' briefly, even though the wiki sidecars the report
  // needs aren't built yet. See user report: "导入 bibtex 后 button 短暂变绿".
  if (inputs.wikiStatus.totalInWiki < inputs.papers.length) return 'pre-wiki'

  // Everything's caught up — primary CTA.
  return 'ready'
}
