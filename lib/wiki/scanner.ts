/**
 * Wiki Scanner — scan project directories for paper artifacts,
 * diff against watermark to find papers needing processing.
 */

import { listArtifacts } from '../memory-v2/store.js'
import type { PaperArtifact } from '../types.js'
import {
  computeCanonicalKey,
  computeSemanticHash,
  canSilentRestampLegacyWatermark,
  canonicalKeyToSlug,
  isValidArxivId,
  GENERATOR_VERSION,
  HASH_SCHEMA_VERSION,
  type ScanResult,
  type ProcessedEntry,
} from './types.js'
import { readProcessedWatermark, readProvenance, restampProcessedBatch } from './io.js'
import { applyIdentityMigration, computeAllCanonicalKeys } from './identity-migration.js'

// ── Fulltext retry backoff ─────────────────────────────────────────────────
// When a paper sits in abstract-fallback and its arXiv download keeps
// failing, we must NOT re-run the full LLM pipeline every idle cycle.
// Backoff: give up after MAX_FAILURES attempts; otherwise require a
// minimum delay that doubles with each failure (1h, 2h, 4h, 8h, capped at
// 24h). Entries missing the counter (legacy) are allowed through so the
// first post-upgrade scan can retry once, and the counter starts tracking.

const MAX_FULLTEXT_FAILURES = 5
const BASE_BACKOFF_MS = 60 * 60 * 1000  // 1h
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000

export function canRetryFulltext(w: ProcessedEntry, now: number = Date.now()): boolean {
  const fails = w.fulltextFailures ?? 0
  if (fails >= MAX_FULLTEXT_FAILURES) return false
  if (!w.lastFulltextTryAt) return true
  const lastMs = new Date(w.lastFulltextTryAt).getTime()
  if (!Number.isFinite(lastMs)) return true
  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, fails), MAX_BACKOFF_MS)
  return now - lastMs >= backoffMs
}

/**
 * Scan all projects for paper artifacts, compare against watermark,
 * return papers needing wiki processing — sorted newest-first.
 *
 * Returns 5 categories:
 * - new: paper not in watermark
 * - semantic-change: content-affecting fields changed
 * - fulltext-upgrade: was abstract-fallback, now has arXiv fulltext potential
 * - generator-bump: older GENERATOR_VERSION
 * - provenance-only: paper exists but from a new project (no LLM cost)
 */
export function scanForNewContent(
  projectPaths: string[],
): { toProcess: ScanResult[]; provenanceOnly: ScanResult[] } {
  const processed = readProcessedWatermark()
  const toProcess: ScanResult[] = []
  const provenanceOnly: ScanResult[] = []

  // Hash schema migration queue. Collected across the scan and flushed in
  // a single atomic rewrite at the end (see bottom of this function).
  // Entries land here when their watermark was written under an older
  // HASH_SCHEMA_VERSION — we re-stamp them with the new hash in place so
  // subsequent scans match, without triggering a reprocess avalanche.
  const restamps: Array<{ canonicalKey: string; semanticHash: string; hashSchemaVersion: number }> = []

  // Build provenance index: canonicalKey → Set of known (projectPath, paperId) pairs
  const existingProvenance = readProvenance()
  const provenanceIndex = new Map<string, Set<string>>()
  for (const entry of existingProvenance) {
    const key = entry.canonicalKey
    if (!provenanceIndex.has(key)) provenanceIndex.set(key, new Set())
    provenanceIndex.get(key)!.add(`${entry.projectPath}\0${entry.paperId}`)
  }

  // Deduplicate across projects: collect all artifacts grouped by canonical key
  const byCanonicalKey = new Map<string, { artifact: PaperArtifact; projectPath: string; identity: ReturnType<typeof computeCanonicalKey> }[]>()

  for (const projectPath of projectPaths) {
    let papers: PaperArtifact[]
    try {
      papers = listArtifacts(projectPath, ['paper'])
        .filter((a): a is PaperArtifact => a.type === 'paper')
    } catch {
      continue  // project may not exist or have no artifacts
    }

    for (const paper of papers) {
      const identity = computeCanonicalKey(paper)
      const existing = byCanonicalKey.get(identity.canonicalKey) || []
      existing.push({ artifact: paper, projectPath, identity })
      byCanonicalKey.set(identity.canonicalKey, existing)
    }
  }

  // For each unique paper, determine scan result
  for (const [canonicalKey, entries] of byCanonicalKey) {
    // Pick the best version: prefer one with fulltextPath, then newest
    const best = entries.reduce((a, b) => {
      if (a.artifact.fulltextPath && !b.artifact.fulltextPath) return a
      if (!a.artifact.fulltextPath && b.artifact.fulltextPath) return b
      const aDate = new Date(a.artifact.createdAt).getTime()
      const bDate = new Date(b.artifact.createdAt).getTime()
      return bDate > aDate ? b : a
    })

    const { artifact, projectPath, identity } = best
    const semanticHash = computeSemanticHash(artifact)
    const slug = canonicalKeyToSlug(canonicalKey)

    // ── Identity-drift pre-pass ─────────────────────────────────────────
    // If a lower-priority canonicalKey for this same paper already exists
    // in the watermark (because the paper was first processed before its
    // DOI/arxivId was backfilled, or the agent's own resolveArxivIdByTitle
    // wrote back an arXiv ID between passes), migrate it onto the primary
    // key atomically. This blocks the reprocessing cascade and sweeps any
    // pre-existing drift (processed.jsonl, provenance.jsonl, paper page,
    // concept markers) to the new key in a single step.
    //
    // Runs under withWikiLock (held by the agent) so the in-place file
    // mutations are safe.
    const allKeys = computeAllCanonicalKeys(artifact)
    for (let i = 1; i < allKeys.length; i++) {
      const fallbackKey = allKeys[i]
      if (fallbackKey === canonicalKey) continue
      const oldEntry = processed.get(fallbackKey)
      if (!oldEntry) continue

      const primaryEntry = processed.get(canonicalKey)
      applyIdentityMigration({
        oldKey: fallbackKey,
        oldSlug: oldEntry.slug,
        newKey: canonicalKey,
        newSlug: primaryEntry?.slug ?? slug,
      })
      // Keep the in-memory processed map aligned with the file we just
      // mutated; otherwise the watermark check below would use stale data.
      processed.delete(fallbackKey)
      if (!primaryEntry) {
        processed.set(canonicalKey, { ...oldEntry, canonicalKey, slug })
      }

      // Same-key provenance cleanup: any provenance entry still pointing at
      // the fallback key is now orphaned. Rebuild this canonicalKey's bucket
      // from provenanceIndex so the later provenance-only check sees the
      // merged state.
      const fallbackProv = provenanceIndex.get(fallbackKey)
      if (fallbackProv) {
        const merged = provenanceIndex.get(canonicalKey) || new Set<string>()
        for (const k of fallbackProv) merged.add(k)
        provenanceIndex.set(canonicalKey, merged)
        provenanceIndex.delete(fallbackKey)
      }
    }

    // ── Hash schema migration (HASH_SCHEMA_VERSION bump) ────────────────
    // Narrow, guarded migration path. The hotfix changed what
    // computeSemanticHash projects, so legacy V1 watermarks cannot be
    // compared directly to V2 hashes of current artifacts without losing
    // the "paper changed → reprocess" invariant. We solve this by re-deriving
    // the V1 hash from the current artifact and ONLY re-stamping when it
    // matches the stored V1 hash — i.e., when the canonical content (and
    // the lens fields V1 included) is byte-for-byte identical to what V1
    // last saw.
    //
    //  - match   → no change since last V1 processing; safe to silently
    //              re-stamp with the V2 hash. Prevents the hash projection
    //              change from triggering a reprocess avalanche across the
    //              entire wiki.
    //  - no match → something changed. We don't know whether it was
    //              canonical content or a lens-only edit that V1 mistakenly
    //              captured. Fall through: leave the watermark untouched,
    //              let the normal check below see `stored (V1) !== current
    //              (V2)` and raise 'semantic-change', which reprocesses the
    //              paper. The resulting markPaperProcessed stamps the new
    //              V2 entry with HASH_SCHEMA_VERSION. This intentionally
    //              accepts a small rate of false reprocesses for pre-hotfix
    //              lens-only edits in exchange for never silently dropping
    //              a real canonical change. RFC-005 follow-up's controlled
    //              regen pass will re-canonicalize any remaining stale
    //              bodies.
    //
    // Migration is NOT a claim that existing page bodies are canonically
    // clean — pages written under V1 may still contain lens contamination
    // in the prose. That is follow-up work, not this hotfix.
    const priorWatermark = processed.get(canonicalKey)
    if (priorWatermark && canSilentRestampLegacyWatermark(priorWatermark, artifact)) {
      const restamped: ProcessedEntry = {
        ...priorWatermark,
        semanticHash,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
      }
      processed.set(canonicalKey, restamped)
      restamps.push({
        canonicalKey,
        semanticHash,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
      })
    }
    // If the predicate returns false on a legacy watermark, we intentionally
    // leave it untouched. The normal branch below will see
    //   priorWatermark.semanticHash (V1) !== semanticHash (V2)
    // and push a 'semantic-change' reprocess, which is the correct
    // conservative behavior when canonical content may have changed.

    const watermark = processed.get(canonicalKey)
    const knownProvenance = provenanceIndex.get(canonicalKey) || new Set<string>()

    // Siblings: non-best (projectPath, artifact) pairs for the same paper.
    // processPaper uses these to merge project lenses after the page exists.
    const siblings = entries
      .filter(e => e.artifact.id !== artifact.id || e.projectPath !== projectPath)
      .map(e => ({ projectPath: e.projectPath, artifact: e.artifact }))

    const base: Omit<ScanResult, 'reason'> = {
      canonicalKey,
      keySource: identity.keySource,
      slug,
      artifact,
      projectPath,
      semanticHash,
      siblings,
    }

    if (!watermark) {
      // Paper not yet processed — needs full generation
      toProcess.push({ ...base, reason: 'new' })
    } else if (watermark.generatorVersion < GENERATOR_VERSION) {
      toProcess.push({ ...base, reason: 'generator-bump' })
    } else if (watermark.semanticHash !== semanticHash) {
      toProcess.push({ ...base, reason: 'semantic-change' })
    } else if (
      watermark.fulltextStatus === 'abstract-fallback' &&
      artifact.arxivId &&
      isValidArxivId(artifact.arxivId) &&
      canRetryFulltext(watermark)
    ) {
      // Re-try fulltext download (only for genuine arXiv IDs, backoff-gated)
      toProcess.push({ ...base, reason: 'fulltext-upgrade' })
    }

    // Provenance tracking: check ALL entries (not just non-best) for new project contributions.
    // A project+paperId pair is "new" if it doesn't appear in existing provenance.
    for (const entry of entries) {
      const provenanceKey = `${entry.projectPath}\0${entry.artifact.id}`
      if (!knownProvenance.has(provenanceKey)) {
        provenanceOnly.push({
          ...base,
          artifact: entry.artifact,
          projectPath: entry.projectPath,
          reason: 'provenance-only',
        })
      }
    }
  }

  // Sort newest-first by artifact createdAt
  toProcess.sort((a, b) => {
    const aTime = new Date(a.artifact.createdAt).getTime()
    const bTime = new Date(b.artifact.createdAt).getTime()
    return bTime - aTime
  })

  // Flush hash schema migration: one atomic rewrite instead of N. Called
  // even when the scan has nothing to process, so a warm wiki picks up the
  // schema upgrade on its first post-hotfix scan.
  if (restamps.length > 0) {
    restampProcessedBatch(restamps)
  }

  return { toProcess, provenanceOnly }
}
