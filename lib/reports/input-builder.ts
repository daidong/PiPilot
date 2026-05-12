/**
 * Build the structured `ReportInput` for the Paper Pack Report (RFC-007 PR-B).
 *
 * For each paper artifact in the project:
 *   1. Look up its Paper Wiki slug
 *   2. Read the wiki page
 *   3. Parse the embedded `WikiPaperMemoryMeta` sidecar
 * Join those into a `ReportPaperEntry`. Papers that have no wiki page
 * yet (e.g. wiki agent hasn't caught up) get `wiki: null` — downstream
 * code tolerates them.
 *
 * No LLM calls, no network. Pure file I/O over the wiki directory.
 */

import { basename } from 'node:path'
import { listArtifacts } from '../memory-v2/store.js'
import { readWikiPage, wikiSlugForPaperArtifact } from '../wiki/io.js'
import { parsePaperPage } from '../wiki/meta-parser.js'
import type { PaperArtifact } from '../types.js'
import type { ReportInput, ReportPaperEntry } from './types.js'

export function buildReportInput(projectPath: string): ReportInput {
  const papers = listArtifacts(projectPath, ['paper'])
    .filter((a): a is PaperArtifact => a.type === 'paper')

  const entries: ReportPaperEntry[] = papers.map((paper) => {
    const slug = wikiSlugForPaperArtifact(paper.id, projectPath)
    if (!slug) return { paper, wiki: null }

    const pageContent = readWikiPage(slug)
    if (!pageContent) return { paper, wiki: null, wikiSlug: slug }

    // parsePaperPage is forgiving — schema-invalid sidecars return
    // null. The report tolerates either case (treat as if there's no
    // wiki extraction beyond what's in the paper artifact itself).
    const parsed = parsePaperPage(pageContent, slug)
    return {
      paper,
      wiki: parsed.sidecar,
      wikiSlug: slug,
    }
  })

  return {
    projectPath,
    projectName: basename(projectPath) || 'Project',
    papers: entries,
    capturedAt: new Date().toISOString(),
  }
}

/**
 * Convenience: extract every citeKey for the current pack. Used by
 * the synthesizer post-validator to strip hallucinated citations.
 */
export function citeKeysOf(input: ReportInput): Set<string> {
  return new Set(input.papers.map((e) => e.paper.citeKey).filter(Boolean))
}
