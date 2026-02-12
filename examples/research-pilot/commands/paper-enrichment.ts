import { listArtifacts } from '../memory-v2/store.js'
import type { CLIContext, PaperArtifact } from '../types.js'
import { updatePaperMetadata } from './save-paper.js'
import { RateLimiter, CircuitBreaker, DEFAULT_SEARCHER_CONFIG } from '../agents/rate-limiter.js'
import { enrichPapers, createEnrichmentConfig, countCoreFields, type PaperInput } from '../agents/metadata-enrichment.js'

export interface EnrichPapersResult {
  success: boolean
  enriched: number
  skipped: number
  failed: number
}

export interface EnrichPapersProgress {
  paperId: string
  status: 'enriching' | 'done' | 'skipped' | 'failed'
}

export interface EnrichPapersOptions extends CLIContext {
  paperIds?: string[]
  onProgress?: (event: EnrichPapersProgress) => void
}

function toPaperInput(paper: PaperArtifact): PaperInput {
  return {
    title: paper.title || '',
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    doi: paper.doi,
    citationCount: paper.citationCount,
    url: paper.url,
    pdfUrl: paper.pdfUrl,
    source: paper.externalSource
  }
}

function hasCoreMetadataDelta(
  before: {
    venue?: string
    doi?: string
    citationCount?: number
    url?: string
    abstract?: string
  },
  after: PaperInput
): boolean {
  return (
    (after.venue && after.venue !== before.venue) ||
    (after.doi && after.doi !== before.doi) ||
    (after.citationCount != null && after.citationCount !== before.citationCount) ||
    (after.url && after.url !== before.url) ||
    (after.abstract && after.abstract !== before.abstract)
  )
}

export async function enrichPaperArtifacts(options: EnrichPapersOptions): Promise<EnrichPapersResult> {
  const { projectPath, sessionId, debug, paperIds, onProgress } = options

  const allPapers = listArtifacts(projectPath, ['paper'])
    .filter((artifact): artifact is PaperArtifact => artifact.type === 'paper')

  const papers = paperIds && paperIds.length > 0
    ? paperIds
      .map(id => allPapers.find(p => p.id === id))
      .filter((paper): paper is PaperArtifact => !!paper)
    : allPapers

  if (papers.length === 0) {
    return { success: true, enriched: 0, skipped: 0, failed: 0 }
  }

  const rateLimiter = new RateLimiter(DEFAULT_SEARCHER_CONFIG.rateLimits)
  const circuitBreaker = new CircuitBreaker(DEFAULT_SEARCHER_CONFIG.circuitBreaker)
  const config = createEnrichmentConfig(rateLimiter, circuitBreaker)
  config.maxPapersToEnrich = 1
  config.maxTimeMs = 60_000

  let enriched = 0
  let skipped = 0
  let failed = 0

  for (const paper of papers) {
    const paperInput = toPaperInput(paper)

    if (countCoreFields(paperInput) >= 5) {
      onProgress?.({ paperId: paper.id, status: 'skipped' })
      skipped++
      continue
    }

    const beforeFields = {
      venue: paper.venue,
      doi: paper.doi,
      citationCount: paper.citationCount,
      url: paper.url,
      abstract: paper.abstract
    }

    onProgress?.({ paperId: paper.id, status: 'enriching' })

    try {
      await enrichPapers([paperInput], config)

      if (!hasCoreMetadataDelta(beforeFields, paperInput)) {
        if (debug) {
          console.log(`[enrich] No new data found for: ${paper.title?.slice(0, 60)}`)
        }
        onProgress?.({ paperId: paper.id, status: 'skipped' })
        skipped++
        continue
      }

      const updateResult = updatePaperMetadata(paper, {
        authors: paperInput.authors,
        year: paperInput.year,
        abstract: paperInput.abstract,
        venue: paperInput.venue ?? undefined,
        url: paperInput.url,
        citationCount: paperInput.citationCount ?? undefined,
        doi: paperInput.doi ?? undefined,
        pdfUrl: paperInput.pdfUrl ?? undefined,
        enrichmentSource: (paperInput as { enrichmentSource?: string }).enrichmentSource,
        enrichedAt: (paperInput as { enrichedAt?: string }).enrichedAt
      }, { sessionId, projectPath, debug })

      if (!updateResult.success) {
        failed++
        onProgress?.({ paperId: paper.id, status: 'failed' })
        continue
      }

      enriched++
      onProgress?.({ paperId: paper.id, status: 'done' })
    } catch (err) {
      if (debug) {
        console.error(`[enrich] Error enriching "${paper.title?.slice(0, 60)}":`, err)
      }
      failed++
      onProgress?.({ paperId: paper.id, status: 'failed' })
    }
  }

  if (debug) {
    console.log(`[enrich] Done: ${enriched} enriched, ${skipped} skipped, ${failed} failed`)
  }
  return { success: true, enriched, skipped, failed }
}
