/**
 * Wiki Scanner — scan project directories for paper artifacts,
 * diff against watermark to find papers needing processing.
 */

import { listArtifacts } from '../memory-v2/store.js'
import type { PaperArtifact } from '../types.js'
import {
  computeCanonicalKey,
  computeSemanticHash,
  canonicalKeyToSlug,
  isValidArxivId,
  GENERATOR_VERSION,
  type ScanResult,
} from './types.js'
import { readProcessedWatermark, readProvenance } from './io.js'

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
    const watermark = processed.get(canonicalKey)
    const knownProvenance = provenanceIndex.get(canonicalKey) || new Set<string>()

    const base: Omit<ScanResult, 'reason'> = {
      canonicalKey,
      keySource: identity.keySource,
      slug,
      artifact,
      projectPath,
      semanticHash,
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
      isValidArxivId(artifact.arxivId)
    ) {
      // Re-try fulltext download (only for genuine arXiv IDs)
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

  return { toProcess, provenanceOnly }
}
