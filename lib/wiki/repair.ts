/**
 * Wiki Repair Pass — RFC-005 §6.4, §12, §13 Phase 1.
 *
 * Consumes `.state/sidecar_status.jsonl` to find papers whose meta block
 * parse outcome was `missing` (LLM emitted body but no valid meta block)
 * or whose `generator_version` is stale. Resolves each such slug back to
 * a current-project `PaperArtifact` and emits `ScanResult` entries that
 * the agent can prepend to the normal scan queue.
 *
 * Limitation (RFC-005 §13 Phase 1): only papers whose source project is
 * currently in the active `projectPaths` list and whose artifact still
 * exists can be repaired. Orphan pages (from projects that are no longer
 * active) are silently skipped — acceptable for v1 as "no retroactive
 * backfill requirement". The user can bring an orphan back in by
 * re-opening the originating project.
 */

import { listArtifacts } from '../memory-v2/store.js'
import type { PaperArtifact } from '../types.js'
import {
  computeCanonicalKey,
  computeSemanticHash,
  canonicalKeyToSlug,
  GENERATOR_VERSION,
  type ScanResult,
} from './types.js'
import { readProcessedWatermark, readProvenance } from './io.js'
import { listStaleOrMissing } from './sidecar-status.js'

/**
 * Build a prioritized repair queue. Results are in sidecar_status insertion
 * order with missing entries first, capped at `budget`. The caller is
 * expected to prepend this list to the normal scan queue and de-dupe by slug.
 */
export function buildRepairScanResults(
  projectPaths: string[],
  budget: number,
): ScanResult[] {
  if (budget <= 0) return []
  if (projectPaths.length === 0) return []

  const stale = listStaleOrMissing(GENERATOR_VERSION)
  if (stale.length === 0) return []

  // Missing first (hardest to self-heal), then stale version bumps
  stale.sort((a, b) => {
    if (a.status === 'missing' && b.status !== 'missing') return -1
    if (a.status !== 'missing' && b.status === 'missing') return 1
    return 0
  })

  const watermark = readProcessedWatermark()
  const provenance = readProvenance()

  // Index slug → canonicalKey via watermark
  const slugToKey = new Map<string, string>()
  for (const entry of watermark.values()) {
    if (entry.slug) slugToKey.set(entry.slug, entry.canonicalKey)
  }

  // Cache artifacts per project to avoid repeated listArtifacts calls
  const artifactsByProject = new Map<string, PaperArtifact[]>()
  const loadProjectPapers = (projectPath: string): PaperArtifact[] => {
    const cached = artifactsByProject.get(projectPath)
    if (cached) return cached
    try {
      const arr = listArtifacts(projectPath, ['paper'])
        .filter((a): a is PaperArtifact => a.type === 'paper')
      artifactsByProject.set(projectPath, arr)
      return arr
    } catch {
      artifactsByProject.set(projectPath, [])
      return []
    }
  }

  const activeSet = new Set(projectPaths)

  const results: ScanResult[] = []
  const seenSlugs = new Set<string>()

  for (const staleEntry of stale) {
    if (results.length >= budget) break
    if (seenSlugs.has(staleEntry.slug)) continue
    seenSlugs.add(staleEntry.slug)

    const canonicalKey = slugToKey.get(staleEntry.slug)
    if (!canonicalKey) continue  // slug not in watermark — page exists but never tracked

    // Find a provenance entry whose project is currently active
    const candidates = provenance.filter(
      p => p.canonicalKey === canonicalKey && activeSet.has(p.projectPath),
    )
    if (candidates.length === 0) continue  // orphan — can't repair in v1

    let resolved: { artifact: PaperArtifact; projectPath: string } | null = null
    for (const cand of candidates) {
      const papers = loadProjectPapers(cand.projectPath)
      const artifact = papers.find(p => p.id === cand.paperId)
      if (artifact) {
        resolved = { artifact, projectPath: cand.projectPath }
        break
      }
    }
    if (!resolved) continue

    const identity = computeCanonicalKey(resolved.artifact)
    const semanticHash = computeSemanticHash(resolved.artifact)
    const slug = canonicalKeyToSlug(canonicalKey)

    results.push({
      canonicalKey,
      keySource: identity.keySource,
      slug,
      reason: 'repair',
      artifact: resolved.artifact,
      projectPath: resolved.projectPath,
      semanticHash,
    })
  }

  return results
}
