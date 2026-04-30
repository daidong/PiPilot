/**
 * literature-search provenance adapter.
 *
 * The tool produces:
 *   - N paper artifacts in Memory V2 (auto-saved when relevanceScore ≥ threshold)
 *   - one review JSON at .research-pilot/literature-runs/{runId}/review.json
 *
 * v1 limitation: the tool's success payload does not include the IDs of the
 * paper artifacts it auto-saved. Without those IDs we cannot create per-paper
 * memory-artifact nodes here. We track the run as a workspace-file output for
 * the review.json (which preserves all paper metadata and can be inspected by
 * the auditor). A follow-up tool refactor can add `savedPaperIds: string[]` to
 * the payload, after which we'll surface per-paper nodes with `derived-from`
 * edges to this run.
 */

import type { ProvenanceAdapter, ProvenanceFacts } from '../types.js'
import { parseResultJson } from './index.js'

export const literatureSearchAdapter: ProvenanceAdapter = (args, result, _ctx): ProvenanceFacts | null => {
  const data = parseResultJson(result)
  if (!data) return null

  const reviewPath = typeof data.fullReviewPath === 'string' ? data.fullReviewPath : null
  if (!reviewPath) return null

  const runId = typeof data.runId === 'string' ? data.runId : 'unknown'
  const query = typeof args.query === 'string' ? args.query : '(unknown query)'
  const reviewedCount = typeof data.reviewedCount === 'number' ? data.reviewedCount : 0
  const papersAutoSaved = typeof data.papersAutoSaved === 'number' ? data.papersAutoSaved : 0

  return {
    outputs: [{
      kind: 'workspace-file',
      ref: { kind: 'workspace-file', path: reviewPath },
      label: `lit-search ${runId}: "${truncate(query, 60)}" — ${papersAutoSaved}/${reviewedCount} saved`
      // Default snapshotPolicy 'always' for workspace-file outputs; review.json is small.
    }],
    inputs: []
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
