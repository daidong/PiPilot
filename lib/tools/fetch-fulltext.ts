/**
 * fetch-fulltext — agent-facing tool for paper full-text retrieval.
 *
 * Default mode is metadata + section list + cache path (small, cheap).
 * Body is opt-in via `sections=[...]` (specific sections) or
 * `include_body=true` (entire body, capped by max_chars).
 *
 * Backed by lib/fulltext/resolveFulltext — same dispatch and cache as the
 * Paper Wiki indexer. Results are cached, so subsequent wiki scans pick up
 * fulltext upgrades automatically.
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult, toolError, toolSuccess } from './tool-utils.js'
import {
  resolveFulltext,
  type FulltextRequest,
  type FulltextSource,
} from '../fulltext/index.js'
import { fetchPaperclipMetadata } from '../fulltext/paperclip.js'

const DEFAULT_MAX_CHARS = 40_000

export function createFetchFulltextTool(): AgentTool {
  return {
    name: 'fetch-fulltext',
    label: 'Fetch Full Text',
    description:
      'Retrieve metadata, section listing, and (optionally) body of a paper. ' +
      'Tries Paperclip (section-aware biomedical/arXiv) first, then arXiv direct. ' +
      'Default returns metadata + section list + cache_path so you can decide ' +
      'what to read next. Pass `sections=["Methods", ...]` for specific sections, ' +
      'or `include_body=true` for the entire body. Provide at least one of ' +
      '`doi`, `arxiv_id`, `pmc_id`, or (`title` + `year`).',
    parameters: Type.Object({
      doi: Type.Optional(Type.String({ description: 'DOI (with or without "https://doi.org/" prefix).' })),
      arxiv_id: Type.Optional(Type.String({ description: 'arXiv id, e.g. "2404.18021".' })),
      pmc_id: Type.Optional(Type.String({ description: 'PubMed Central id, e.g. "PMC6130889".' })),
      pubmed_id: Type.Optional(Type.String({ description: 'PubMed id (numeric).' })),
      title: Type.Optional(Type.String({ description: 'Paper title — last-resort lookup via arXiv title search.' })),
      year: Type.Optional(Type.Integer({ description: 'Publication year (disambiguates title lookup).' })),

      sections: Type.Optional(Type.Array(Type.String(), {
        description: 'Section names to fetch (Paperclip only, fuzzy-matched). Returns those in `sections_returned`.',
      })),

      include_body: Type.Optional(Type.Boolean({
        description: 'When true, returns the entire body (capped by max_chars). Off by default.',
      })),

      max_chars: Type.Optional(Type.Integer({
        description: `Cap on returned body / sections bytes. Default ${DEFAULT_MAX_CHARS}.`,
      })),

      prefer_source: Type.Optional(Type.Union([
        Type.Literal('paperclip'),
        Type.Literal('arxiv'),
      ], { description: 'Override dispatch order. Default: Paperclip → arXiv.' })),
    }),
    execute: async (_id, rawParams) => {
      const params = rawParams as Record<string, unknown>

      const doi = typeof params.doi === 'string' ? params.doi.trim() || undefined : undefined
      const arxivId = typeof params.arxiv_id === 'string' ? params.arxiv_id.trim() || undefined : undefined
      const pmcId = typeof params.pmc_id === 'string' ? params.pmc_id.trim() || undefined : undefined
      const pubmedId = typeof params.pubmed_id === 'string' ? params.pubmed_id.trim() || undefined : undefined
      const title = typeof params.title === 'string' ? params.title.trim() || undefined : undefined
      const year = typeof params.year === 'number' ? params.year : undefined
      const sections = Array.isArray(params.sections)
        ? (params.sections as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined
      const includeBody = params.include_body === true
      const maxChars =
        typeof params.max_chars === 'number' && Number.isFinite(params.max_chars) && params.max_chars > 0
          ? Math.floor(params.max_chars)
          : DEFAULT_MAX_CHARS
      const preferSource =
        params.prefer_source === 'paperclip' || params.prefer_source === 'arxiv'
          ? (params.prefer_source as FulltextSource)
          : undefined

      // Validate identifiers
      const hasIdentifier = !!(doi || arxivId || pmcId || pubmedId || title)
      if (!hasIdentifier) {
        return toAgentResult('fetch-fulltext', toolError('MISSING_PARAMETER',
          'fetch-fulltext requires at least one of: doi, arxiv_id, pmc_id, pubmed_id, or title.', {
            suggestions: [
              'Pass the paper\'s DOI as `doi`.',
              'For biomedical papers in PubMed Central, pass `pmc_id` (e.g. "PMC6130889").',
              'For arXiv papers, pass `arxiv_id` (e.g. "2404.18021").',
              'As a last resort pass `title` (and `year` to disambiguate).',
            ],
          }))
      }

      const wantsBody = (sections && sections.length > 0) || includeBody

      const req: FulltextRequest = {
        doi,
        arxivId,
        pmcId,
        pubmedId,
        title,
        year,
        sections: wantsBody && sections && sections.length > 0 ? sections : undefined,
        preferSource,
      }

      // ── Default mode: metadata-only ──────────────────────────────────────
      if (!wantsBody) {
        // Paperclip is the only source that returns rich metadata + section
        // listing without dragging the whole body. arXiv has no section
        // structure to enumerate, so for arXiv-only papers we fall back to
        // a "metadata thin" response (the agent can still read the abstract
        // from the artifact / call again with include_body=true).
        const meta = await fetchPaperclipMetadata({ doi, pmcId, arxivId })
        if (meta) {
          return toAgentResult('fetch-fulltext', toolSuccess({
            metadata: {
              title: meta.meta?.title ?? null,
              authors: parseAuthors(meta.meta?.authors),
              year: meta.meta?.pub_year ?? meta.meta?.year ?? null,
              venue: meta.meta?.journal_title ?? meta.meta?.journal ?? null,
              doi: meta.meta?.doi ?? doi ?? null,
              pmc_id: meta.meta?.pmc_id ?? pmcId ?? null,
              arxiv_id: arxivId ?? null,
              abstract: meta.meta?.abstract ?? meta.meta?.abstract_text ?? null,
              fulltext_available: true,
            },
            sections: meta.sectionList,
            cache_path: null,
            paperclip_id: meta.paperclipId,
            source: 'paperclip',
            fetched_at: new Date().toISOString(),
          }))
        }

        // Paperclip didn't have it (no API key, not in corpus, or arXiv-only
        // paper). Try cache via cheap probe — if the body is already
        // cached, return its path without re-fetching.
        const cached = await resolveFulltext(req)
        if (cached) {
          return toAgentResult('fetch-fulltext', toolSuccess({
            metadata: { title: title ?? null, doi: doi ?? null, pmc_id: pmcId ?? null, arxiv_id: arxivId ?? null, fulltext_available: true },
            sections: cached.sectionList ?? null,
            cache_path: cached.cachePath,
            source: cached.source,
            fetched_at: cached.fetchedAt,
            note: 'Body cached locally — pass include_body=true for full text, or sections=[...] for specific sections.',
          }))
        }

        // No source produced anything.
        return toAgentResult('fetch-fulltext', toolError('NOT_FOUND',
          'No source could resolve full text for this paper.', {
            retryable: false,
            suggestions: [
              'Verify the identifier is correct.',
              'For biomedical papers: ensure PAPERCLIP_API_KEY is configured (Settings → API Keys → Paperclip).',
              'For arXiv-only papers: install the `markitdown` CLI for PDF conversion.',
              'For closed-access journal papers without a preprint, you may need to upload the PDF manually.',
            ],
            context: { doi, arxivId, pmcId, pubmedId, title },
          }))
      }

      // ── Body modes: sections=[...] or include_body=true ──────────────────
      const result = await resolveFulltext(req)
      if (!result) {
        return toAgentResult('fetch-fulltext', toolError('NOT_FOUND',
          'No source produced full text for this paper.', {
            retryable: false,
            suggestions: [
              'Try without sections=[...] first to confirm the paper exists in any source.',
              'Verify the identifier.',
              'Configure PAPERCLIP_API_KEY for biomedical / arXiv corpus access.',
            ],
            context: { doi, arxivId, pmcId, pubmedId, title },
          }))
      }

      const truncate = (s: string): { value: string; truncated: boolean } => {
        if (s.length <= maxChars) return { value: s, truncated: false }
        return {
          value: s.slice(0, maxChars) + '\n\n[... truncated for length ...]',
          truncated: true,
        }
      }

      const payload: Record<string, unknown> = {
        metadata: {
          title: title ?? null,
          doi: doi ?? null,
          pmc_id: result.resolvedPmcId ?? pmcId ?? null,
          arxiv_id: arxivId ?? null,
          fulltext_available: true,
        },
        sections: result.sectionList ?? null,
        cache_path: result.cachePath,
        source: result.source,
        fetched_at: result.fetchedAt,
      }

      if (sections && sections.length > 0 && result.sections) {
        // Truncate per-section so a single huge section doesn't drown the others.
        const sectionsReturned: Record<string, string> = {}
        let anyTruncated = false
        for (const [name, text] of Object.entries(result.sections)) {
          const t = truncate(text)
          sectionsReturned[name] = t.value
          if (t.truncated) anyTruncated = true
        }
        const matched = new Set(Object.keys(result.sections))
        const unmatched = sections.filter(s => {
          // Spec §7.3 fuzzy match: if any matched section overlaps, count as matched.
          const reqTokens = new Set(s.toLowerCase().split(/\s+/).filter(Boolean))
          for (const m of matched) {
            const mTokens = new Set(m.toLowerCase().split(/\s+/).filter(Boolean))
            for (const t of reqTokens) if (mTokens.has(t)) return false
          }
          return true
        })
        payload.sections_returned = sectionsReturned
        payload.sections_unmatched = unmatched
        payload.truncated = anyTruncated
      } else if (includeBody) {
        const t = truncate(result.markdown)
        payload.body = t.value
        payload.truncated = t.truncated
      }

      return toAgentResult('fetch-fulltext', toolSuccess(payload))
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseAuthors(raw?: string): string[] | null {
  if (!raw || typeof raw !== 'string') return null
  // Paperclip's meta.json `authors` is a single string with comma-separated
  // names. Split, trim, drop trailing markers like " *".
  return raw
    .split(',')
    .map(a => a.trim().replace(/\s+\*+$/, ''))
    .filter(Boolean)
}
