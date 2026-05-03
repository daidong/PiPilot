/**
 * Full-text Retrieval — public types.
 *
 * See docs/spec/fulltext-retrieval.md.
 */

import type { PaperArtifact } from '../types.js'

export type FulltextSource = 'paperclip' | 'arxiv'

export interface FulltextRequest {
  /** Canonical key when available. */
  doi?: string
  /** Bare arXiv id (e.g. "2301.12345"), no version suffix. */
  arxivId?: string
  /** PubMed Central id (e.g. "PMC6130889"). */
  pmcId?: string
  /** PubMed id (e.g. "29969439"). */
  pubmedId?: string
  /** Last-resort: search arXiv by title. */
  title?: string
  /** Disambiguates title-based arXiv resolve. */
  year?: number
  /**
   * Paperclip-only: when present, return just these named sections in
   * `result.sections`. Fuzzy-matched against actual section names.
   */
  sections?: string[]
  /**
   * Override dispatch order. Useful when the agent has a specific reason
   * to prefer a particular source (e.g. wanting the formal arXiv version
   * even though Paperclip would also have a copy).
   */
  preferSource?: FulltextSource
}

export interface FulltextResult {
  /** Converted body markdown, source-agnostic. */
  markdown: string
  /** Which provider produced this content. */
  source: FulltextSource
  /** Absolute path to the cached `.md` file under <wiki-root>/converted/. */
  cachePath: string
  /** Present iff `source === 'paperclip'` and sections were requested. */
  sections?: Record<string, string>
  /** Section names actually present (Paperclip only). */
  sectionList?: string[]
  /** ISO timestamp of the fetch (or the cached file's mtime on cache hit). */
  fetchedAt: string
  /**
   * Paperclip-only: if Paperclip resolved a richer ID for this paper than
   * the caller had, surface it so the caller can write it back to the
   * artifact. Right now we only surface `pmcId` because that's what
   * unlocks future cache hits.
   */
  resolvedPmcId?: string
}

/**
 * Result of a cache probe — strictly local. Includes everything resolveFulltext
 * needs to construct a FulltextResult without going online.
 */
export interface CacheHit {
  path: string
  source: FulltextSource
  sectionList?: string[]
}

/**
 * Eligibility check — does this artifact have at least one identifier we can
 * try to resolve? Used by both the wiki retry-trigger predicate (scanner.ts)
 * and the initial classification (generator.ts) so DOI-only biomedical papers
 * don't terminal-fail.
 *
 * Reads `PAPERCLIP_API_KEY` from `process.env` to mirror the existing
 * `BRAVE_API_KEY` plumbing convention.
 */
export interface ArtifactIdentifiers {
  arxivId?: string
  doi?: string
  pmcId?: string
  pubmedId?: string
}

export function artifactIdentifiers(a: PaperArtifact): ArtifactIdentifiers {
  return {
    arxivId: a.arxivId,
    doi: a.doi && !a.doi.startsWith('unknown:') ? a.doi : undefined,
    pmcId: a.pmcId,
    pubmedId: a.pubmedId,
  }
}
