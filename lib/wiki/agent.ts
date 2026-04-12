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
  isValidArxivId,
  type WikiAgent,
  type WikiAgentConfig,
  type WikiStatus,
  type ScanResult,
} from './types.js'
import { withWikiLock, acquireProcessLock, releaseProcessLock } from './lock.js'
import {
  ensureWikiStructure,
  markPaperProcessed,
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

type AgentState = 'created' | 'idle' | 'processing' | 'cooldown' | 'paused' | 'destroyed'

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
        for (const entry of provenanceOnly) {
          addProvenance({
            canonicalKey: entry.canonicalKey,
            projectPath: entry.projectPath,
            paperId: entry.artifact.id,
            addedAt: new Date().toISOString(),
          })
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

        // 8. Rebuild index
        rebuildIndex()

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
    const { artifact, slug, canonicalKey, projectPath, semanticHash } = scanResult

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
    }

    // Phase 2: Download + convert if we have a valid arXiv ID
    if (resolvedArxivId) {
      if (!shouldContinue()) return
      fulltext = await downloadAndConvertArxiv(resolvedArxivId)
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
      processedAt: new Date().toISOString(),
    }
    markPaperProcessed(entry)
    addProvenance({
      canonicalKey,
      projectPath,
      paperId: artifact.id,
      addedAt: new Date().toISOString(),
    })

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
