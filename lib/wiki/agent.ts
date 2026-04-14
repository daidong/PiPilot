/**
 * Wiki Agent — background orchestrator with pacing.
 *
 * State machine: Created → Idle Scanning → Processing → Cooldown → (loop)
 * Pause/Resume from any state. Single writer via withWikiLock + process lock.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  getWikiRoot,
  GENERATOR_VERSION,
  HASH_SCHEMA_VERSION,
  isValidArxivId,
  computeCanonicalKey,
  computeSemanticHash,
  canonicalKeyToSlug,
  type WikiAgent,
  type WikiAgentConfig,
  type WikiStatus,
  type ScanResult,
} from './types.js'
import { withWikiLock, acquireProcessLock, releaseProcessLock } from './lock.js'
import {
  ensureWikiStructure,
  markPaperProcessed,
  markFulltextFailure,
  addProvenance,
  rebuildIndex,
  appendLog,
  countPaperPages,
  countConceptPages,
  safeWriteFile,
  safeReadFile,
} from './io.js'
import { scanForNewContent } from './scanner.js'
import { downloadAndConvertArxiv, resolveArxivIdByTitle } from './downloader.js'
import { updateArtifact } from '../memory-v2/store.js'
import {
  generatePaperPage,
  identifyConcepts,
  generateAndUpdateConceptPages,
  listExistingConceptSlugs,
} from './generator.js'
import type { FulltextStatus, ProcessedEntry, ProvenanceEntry } from './types.js'
import { parsePaperPage, writeMetaBlockInto } from './meta-parser.js'
import { deriveLensFromArtifact, mergeLens, unionProvenanceProjects } from './lens-deriver.js'
import { recordSidecarStatus } from './sidecar-status.js'
import { rebuildMemoryIndex } from './indexer.js'
import { buildRepairScanResults } from './repair.js'
import type { PaperArtifact } from '../types.js'

type AgentState = 'created' | 'idle' | 'processing' | 'cooldown' | 'paused' | 'destroyed'

/**
 * Merge a project context (lens + provenance_projects) into an existing
 * paper memory page's meta block. No-op if the page has no meta block
 * (legacy RFC-003 pages) or if the artifact has no useful lens content.
 *
 * Must be called under withWikiLock.
 */
function mergeProjectContextIntoPage(
  slug: string,
  projectPath: string,
  artifact: PaperArtifact,
): void {
  const pagePath = join(getWikiRoot(), 'papers', `${slug}.md`)
  const content = safeReadFile(pagePath)
  if (!content) return

  const parsed = parsePaperPage(content, slug)
  if (!parsed.sidecar) return  // legacy body-only page — wait for repair pass

  const lens = deriveLensFromArtifact(artifact, projectPath)
  const updatedProvenance = unionProvenanceProjects(parsed.sidecar.provenance_projects, projectPath)

  parsed.sidecar.provenance_projects = updatedProvenance
  if (lens) {
    parsed.sidecar.project_lenses = mergeLens(parsed.sidecar.project_lenses, lens)
  }

  const newContent = writeMetaBlockInto(parsed.body, parsed.sidecar)
  if (newContent !== content) {
    safeWriteFile(pagePath, newContent)
  }
}

export function createWikiAgent(config: WikiAgentConfig): WikiAgent {
  let state: AgentState = 'created'
  let timer: ReturnType<typeof setTimeout> | null = null
  let processedThisSession = 0
  let lastRunAt: string | undefined

  const log = config.debug
    ? (msg: string) => console.log(`[wiki-agent] ${msg}`)
    : () => {}

  function shouldContinue(): boolean {
    return state !== 'paused' && state !== 'destroyed'
  }

  function emitStatus(pending: number = 0): void {
    if (!config.onStatus) return
    const totalInWiki = existsSync(join(getWikiRoot(), 'papers'))
      ? readdirSync(join(getWikiRoot(), 'papers')).filter(f => f.endsWith('.md')).length
      : 0

    config.onStatus({
      state: state === 'processing' ? 'processing' : state === 'paused' ? 'paused' : 'idle',
      processed: processedThisSession,
      pending,
      totalInWiki,
      lastRunAt,
    })
  }

  // ── Core: processSinglePass ────────────────────────────────────────────

  async function processSinglePass(): Promise<{ processed: number; errors: number; pendingRemaining: number }> {
    let processed = 0
    let errors = 0

    // 1. Acquire cross-process lock
    if (!acquireProcessLock()) {
      log('process lock held by another instance, skipping')
      return { processed: 0, errors: 0, pendingRemaining: 0 }
    }

    try {
      // 2. In-process serialization
      return await withWikiLock(async () => {
        // 3. Ensure wiki structure
        ensureWikiStructure()

        // 4. Scan for new content
        const projectPaths = config.projectPaths()
        if (projectPaths.length === 0) {
          log('no project paths, nothing to scan')
          return { processed: 0, errors: 0, pendingRemaining: 0 }
        }

        const { toProcess, provenanceOnly } = scanForNewContent(projectPaths)

        // 5. Handle provenance-only entries (no LLM)
        //    Each entry is an existing wiki paper being seen from a new project.
        //    We record provenance + merge a project lens into the existing meta block.
        for (const entry of provenanceOnly) {
          addProvenance({
            canonicalKey: entry.canonicalKey,
            projectPath: entry.projectPath,
            paperId: entry.artifact.id,
            addedAt: new Date().toISOString(),
          })
          mergeProjectContextIntoPage(entry.slug, entry.projectPath, entry.artifact)
        }

        // 5b. RFC-005 §6.4, §12, §13 Phase 1: repair pass — surface papers
        //     whose meta block was missing / stale in sidecar_status.jsonl.
        //     Repair entries are prepended to toProcess (healer takes priority),
        //     with per-slug dedup against normal scan results.
        const repairs = buildRepairScanResults(projectPaths, config.pacing.papersPerCycle)
        if (repairs.length > 0) {
          log(`repair: ${repairs.length} stale/missing sidecar(s) queued`)
          const seenSlugs = new Set<string>()
          const merged: ScanResult[] = []
          for (const entry of repairs) {
            if (seenSlugs.has(entry.slug)) continue
            seenSlugs.add(entry.slug)
            merged.push(entry)
          }
          for (const entry of toProcess) {
            if (seenSlugs.has(entry.slug)) continue
            seenSlugs.add(entry.slug)
            merged.push(entry)
          }
          toProcess.splice(0, toProcess.length, ...merged)
        }

        if (toProcess.length === 0) {
          log('no papers to process')
          emitStatus(0)
          return { processed: 0, errors: 0, pendingRemaining: 0 }
        }

        // 6. Take at most papersPerCycle
        const batch = toProcess.slice(0, config.pacing.papersPerCycle)
        const pendingRemaining = toProcess.length - batch.length

        log(`processing ${batch.length} of ${toProcess.length} papers`)
        state = 'processing'
        emitStatus(toProcess.length)

        // 7. Process each paper
        for (const scanResult of batch) {
          if (!shouldContinue()) break

          try {
            await processPaper(scanResult)
            processed++
            processedThisSession++
          } catch (err) {
            errors++
            log(`error processing ${scanResult.slug}: ${err}`)
          }
        }

        // 8. Rebuild human index (index.md) and memory retrieval indices (RFC-005 Phase 2)
        rebuildIndex()
        try {
          rebuildMemoryIndex()
        } catch (err) {
          log(`rebuildMemoryIndex error: ${err}`)
        }

        lastRunAt = new Date().toISOString()
        emitStatus(pendingRemaining)

        return { processed, errors, pendingRemaining }
      })
    } finally {
      // 9. Release process lock
      releaseProcessLock()
    }
  }

  async function processPaper(scanResult: ScanResult): Promise<void> {
    const { artifact, projectPath } = scanResult
    // canonicalKey / slug / semanticHash may be refreshed mid-function if
    // resolveArxivIdByTitle elevates the artifact to a higher-priority key.
    // We use the post-resolve values for the page path, watermark write, and
    // concept markers so the next scan sees a stable identity and doesn't
    // trigger a spurious `semantic-change` reprocess.
    let canonicalKey = scanResult.canonicalKey
    let slug = scanResult.slug
    let semanticHash = scanResult.semanticHash

    log(`processing: ${artifact.title} (${scanResult.reason})`)

    // Resolve arXiv ID + download fulltext PDF
    let fulltext: string | null = null
    let resolvedArxivId = artifact.arxivId && isValidArxivId(artifact.arxivId)
      ? artifact.arxivId
      : null

    // Phase 1: If no valid arXiv ID, try to find one via title search
    if (!resolvedArxivId) {
      if (!shouldContinue()) return
      log(`resolving arXiv ID for: ${artifact.title}`)
      resolvedArxivId = await resolveArxivIdByTitle(artifact.title, artifact.year)

      // Write back to artifact: either the found ID or clear the garbage value
      const newArxivId = resolvedArxivId ?? undefined
      if (newArxivId !== artifact.arxivId) {
        updateArtifact(projectPath, artifact.id, { arxivId: newArxivId } as any)
        artifact.arxivId = newArxivId  // keep local copy in sync
        log(resolvedArxivId
          ? `resolved arXiv ID: ${resolvedArxivId}`
          : `no arXiv match, cleared garbage arxivId`)
      }

      // Gap A fix — propagate a newly-discovered arXiv ID to every sibling
      // project's artifact. Without this, the next scan would split the
      // paper across canonicalKeys (this project → `arxiv:X`, siblings →
      // `title:...`) and the sibling copies would be reprocessed as new.
      // We only propagate positive discoveries; clearing a bogus ID is
      // NOT propagated because sibling copies may legitimately still hold
      // different metadata that we shouldn't clobber.
      if (resolvedArxivId && scanResult.siblings) {
        for (const sib of scanResult.siblings) {
          if (sib.artifact.arxivId === resolvedArxivId) continue
          try {
            updateArtifact(sib.projectPath, sib.artifact.id, { arxivId: resolvedArxivId } as any)
            sib.artifact.arxivId = resolvedArxivId
            log(`propagated arXiv ID to sibling project ${sib.projectPath}`)
          } catch (err) {
            log(`failed to propagate arXiv ID to ${sib.projectPath}/${sib.artifact.id}: ${err}`)
          }
        }
      }

      // Refresh the post-resolve identity. The page path, watermark, and
      // concept markers all downstream use these locals — pinning them to
      // the post-resolve state means the next scan's semanticHash and key
      // lookups both match and no spurious reprocess is triggered.
      const postResolve = computeCanonicalKey(artifact)
      const postResolveCanonicalKey = postResolve.canonicalKey
      if (postResolveCanonicalKey !== canonicalKey) {
        canonicalKey = postResolveCanonicalKey
        slug = canonicalKeyToSlug(canonicalKey)
        log(`identity upgraded: ${scanResult.canonicalKey} → ${canonicalKey}`)
      }
      semanticHash = computeSemanticHash(artifact)
    }

    // Phase 2: Download + convert if we have a valid arXiv ID
    if (resolvedArxivId) {
      if (!shouldContinue()) return
      fulltext = await downloadAndConvertArxiv(resolvedArxivId)
    }

    // Fulltext retry backoff: if this pass was a pure fulltext-upgrade retry
    // and the arXiv download still failed, bump the failure counter and bail
    // out. We must NOT re-run the LLM pipeline for a retry that produced no
    // new material — that's the "burn tokens every idle cycle" bug.
    if (scanResult.reason === 'fulltext-upgrade' && !fulltext) {
      log(`fulltext retry failed for ${slug}; updating backoff and skipping LLM`)
      markFulltextFailure(canonicalKey)
      return
    }

    // Generate paper page
    if (!shouldContinue()) return
    const existingConcepts = listExistingConceptSlugs()
    const result = await generatePaperPage(
      artifact,
      slug,
      fulltext,
      existingConcepts,
      config.callLlm,
      config.pacing.interCallDelayMs,
      shouldContinue,
    )
    if (!result || !shouldContinue()) return

    // Write paper page
    const paperPath = join(getWikiRoot(), 'papers', `${slug}.md`)
    safeWriteFile(paperPath, result.content)

    // RFC-005 §6.2.1: parse the just-written page, record parse status,
    // merge a project lens from the triggering artifact. If the LLM emitted
    // a clean meta block this enriches the sidecar; if it didn't, the
    // status row lets the repair pass retry later.
    const parseOutcome = parsePaperPage(result.content, slug)
    recordSidecarStatus({
      slug,
      status: parseOutcome.status,
      reason: parseOutcome.reason,
      droppedFields: parseOutcome.droppedFields,
      generator_version: GENERATOR_VERSION,
      recorded_at: new Date().toISOString(),
      repairUsed: parseOutcome.repairUsed,
    })
    mergeProjectContextIntoPage(slug, projectPath, artifact)

    // Identify concepts
    if (!shouldContinue()) return
    const concepts = await identifyConcepts(
      result.content,
      artifact.title,
      existingConcepts,
      config.callLlm,
      config.pacing.interCallDelayMs,
      shouldContinue,
    )

    // Generate/update concept pages
    if (concepts.length > 0 && shouldContinue()) {
      await generateAndUpdateConceptPages(
        concepts,
        slug,
        artifact.title,
        result.content,
        config.callLlm,
        config.pacing.interCallDelayMs,
        shouldContinue,
      )
    }

    // Mark processed + provenance
    const entry: ProcessedEntry = {
      canonicalKey,
      slug,
      semanticHash,
      fulltextStatus: result.fulltextStatus,
      generatorVersion: GENERATOR_VERSION,
      hashSchemaVersion: HASH_SCHEMA_VERSION,
      processedAt: new Date().toISOString(),
    }
    markPaperProcessed(entry)
    addProvenance({
      canonicalKey,
      projectPath,
      paperId: artifact.id,
      addedAt: new Date().toISOString(),
    })

    // Multi-project lens backfill: for every other (projectPath, artifact)
    // pair that shares this canonicalKey, add provenance and merge the
    // project lens now that the page file exists. The provenance-only
    // branch at the top of processSinglePass runs BEFORE the page is
    // written, so its mergeProjectContextIntoPage call was a silent no-op
    // for brand-new papers — this loop is the fix for that lens loss.
    if (scanResult.siblings && scanResult.siblings.length > 0) {
      for (const sib of scanResult.siblings) {
        addProvenance({
          canonicalKey,
          projectPath: sib.projectPath,
          paperId: sib.artifact.id,
          addedAt: new Date().toISOString(),
        })
        mergeProjectContextIntoPage(slug, sib.projectPath, sib.artifact)
      }
    }

    // Log
    const tierLabel = result.fulltextStatus === 'fulltext' ? 'fulltext' : 'abstract'
    appendLog(`Processed "${artifact.title}" (${tierLabel})`)

    log(`done: ${artifact.title}`)
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (state === 'paused' || state === 'destroyed') return

    try {
      const result = await processSinglePass()
      if (state === 'destroyed') return

      if (state !== 'paused') {
        state = 'cooldown'
        const delay = result.pendingRemaining > 0
          ? config.pacing.cycleCooldownMs
          : config.pacing.idleScanIntervalMs

        log(`next cycle in ${delay / 1000}s (${result.pendingRemaining} pending)`)
        timer = setTimeout(() => {
          state = 'idle'
          tick()
        }, delay)
      }
    } catch (err) {
      log(`tick error: ${err}`)
      // Retry after idle interval
      if (state !== 'paused' && state !== 'destroyed') {
        timer = setTimeout(() => {
          state = 'idle'
          tick()
        }, config.pacing.idleScanIntervalMs)
      }
    }
  }

  // ── Public interface ───────────────────────────────────────────────────

  return {
    start() {
      if (state !== 'created') return
      state = 'idle'
      log(`starting (delay ${config.pacing.startupDelayMs / 1000}s)`)
      timer = setTimeout(() => tick(), config.pacing.startupDelayMs)
    },

    pause() {
      if (state === 'destroyed') return
      log('paused')
      state = 'paused'
      if (timer) { clearTimeout(timer); timer = null }
      emitStatus()
    },

    resume() {
      if (state !== 'paused') return
      log('resumed')
      state = 'idle'
      tick()
    },

    destroy() {
      log('destroyed')
      state = 'destroyed'
      if (timer) { clearTimeout(timer); timer = null }
      releaseProcessLock()
    },

    async runOnce() {
      const result = await processSinglePass()
      return { processed: result.processed, errors: result.errors }
    },

    get isActive() {
      return state === 'processing' || state === 'idle' || state === 'cooldown'
    },
  }
}
