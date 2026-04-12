/**
 * Wiki Tools — RFC-005 Phase 3 tool surface.
 *
 * Replaces the single `wiki_lookup` with six focused tools:
 *   wiki_search     — BM25 + alias + facet retrieval
 *   wiki_get        — targeted page / meta / lens read
 *   wiki_coverage   — local memory density on a topic
 *   wiki_facets     — enumerate top values of a facet
 *   wiki_neighbors  — concept-graph traversal
 *   wiki_source     — bridge from slug to source-layer artifacts
 *
 * All tools follow the pi-agent-core AgentTool interface and use
 * toAgentResult for output packaging.
 *
 * Epistemic contract (RFC-005 §4.3, §7, §9.1):
 *   - Tools return memory-layer data only.
 *   - The coordinator must NEVER cite raw findings[].value or meta:*
 *     fields directly. For quotes, numbers, and comparisons, call
 *     wiki_source to locate the underlying artifact, then read it.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { toAgentResult } from '../tools/tool-utils.js'
import { getWikiRoot } from './types.js'
import { safeReadFile, readProvenance, readProcessedWatermark } from './io.js'
import { parsePaperPage } from './meta-parser.js'
import {
  loadBm25Index,
  loadAliasMap,
  loadBy,
  loadFacets,
  loadGraph,
  expandQueryTokens,
  type Facets,
} from './indexer.js'
import { scoreQuery } from './bm25.js'
import type { WikiPaperMemoryMeta } from './memory-schema.js'

// ── Internal helpers ───────────────────────────────────────────────────────

interface PageParsed {
  slug: string
  title: string
  body: string
  sidecar: WikiPaperMemoryMeta | null
}

function readPaperPage(slug: string): PageParsed | null {
  const path = join(getWikiRoot(), 'papers', `${slug}.md`)
  const content = safeReadFile(path)
  if (!content) return null
  const parsed = parsePaperPage(content, slug)
  const titleMatch = parsed.body.match(/^#\s+(.+?)\s*$/m)
  const title = titleMatch ? titleMatch[1].trim() : slug
  return { slug, title, body: parsed.body, sidecar: parsed.sidecar }
}

/**
 * Append a low-yield query to index/query_log.jsonl for later thin-area analysis.
 * RFC-005 §9.5 / Phase 4.
 */
function logLowYieldQuery(entry: { query: string; matched: number; total: number }): void {
  try {
    const path = join(getWikiRoot(), 'index', 'query_log.jsonl')
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n'
    appendFileSync(path, line, 'utf-8')
  } catch {
    // Logging is best-effort; never break a search because of a log failure.
  }
}

function readConceptPage(slug: string): PageParsed | null {
  const path = join(getWikiRoot(), 'concepts', `${slug}.md`)
  const content = safeReadFile(path)
  if (!content) return null
  const parsed = parsePaperPage(content, slug)  // same parser works for concept pages
  const titleMatch = parsed.body.match(/^#\s+(.+?)\s*$/m)
  const title = titleMatch ? titleMatch[1].trim() : slug
  return { slug, title, body: parsed.body, sidecar: parsed.sidecar }
}

/**
 * Extract a `## Section Name` block from a Markdown body (case-insensitive).
 * Returns the content until the next `## ` heading or end of body.
 */
function extractMarkdownSection(body: string, sectionName: string): string | null {
  const re = new RegExp(
    `^##\\s+${sectionName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`,
    'im',
  )
  const match = body.match(re)
  if (!match || match.index === undefined) return null
  const start = match.index + match[0].length
  const rest = body.slice(start)
  const nextHeading = rest.search(/^##\s+/m)
  const sectionText = nextHeading < 0 ? rest : rest.slice(0, nextHeading)
  return sectionText.trim()
}

/** Section names to look up in the body (case-insensitive, heading text). */
const PAGE_SECTION_HEADINGS: Record<string, string[]> = {
  'page:summary': ['Summary'],
  'page:contributions': ['Key Contributions', 'Contributions'],
  'page:methodology': ['Methodology', 'Method', 'Approach'],
  'page:results': ['Results'],
  'page:limitations': ['Limitations'],
  'page:related': ['Related Concepts', 'Related Work'],
}

// ── wiki_search ────────────────────────────────────────────────────────────

const SearchFilters = Type.Optional(Type.Object({
  year_gte: Type.Optional(Type.Number()),
  year_lte: Type.Optional(Type.Number()),
  datasets: Type.Optional(Type.Array(Type.String())),
  concepts: Type.Optional(Type.Array(Type.String())),
  methods: Type.Optional(Type.Array(Type.String())),
  paper_type: Type.Optional(Type.Union([
    Type.Literal('method'),
    Type.Literal('empirical'),
    Type.Literal('review'),
    Type.Literal('resource'),
    Type.Literal('theory'),
    Type.Literal('position'),
  ])),
  has_code: Type.Optional(Type.Boolean()),
  source_tier: Type.Optional(Type.Union([
    Type.Literal('metadata-only'),
    Type.Literal('abstract-only'),
    Type.Literal('fulltext'),
  ])),
}))

export function createWikiSearchTool(): AgentTool {
  return {
    name: 'wiki_search',
    label: 'Wiki Search',
    description:
      'Keyword/BM25 search over the local paper wiki memory with alias expansion and facet filters. ' +
      'Always call this before external literature search when the topic might already be in local memory. ' +
      'Returns hits plus a coverage signal describing how DENSE or THIN local memory is on this topic. ' +
      'Hits contain preview text only (title, tldr, matched fields). ' +
      'IMPORTANT: wiki results are retrieval summaries, not citable facts. For quoted numbers or exact claims, ' +
      'call wiki_source(slug) to locate the underlying paper artifact and read from there.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query (topic, method name, concept keyword)' }),
      k: Type.Optional(Type.Number({ description: 'Max results (default 10, max 30)', default: 10 })),
      filters: SearchFilters,
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { query, k = 10, filters } = params as {
        query: string
        k?: number
        filters?: {
          year_gte?: number
          year_lte?: number
          datasets?: string[]
          concepts?: string[]
          methods?: string[]
          paper_type?: string
          has_code?: boolean
          source_tier?: string
        }
      }

      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_search', { success: true, data: 'Wiki not available.' })
      }

      const bm25 = loadBm25Index()
      if (!bm25 || bm25.numDocs === 0) {
        return toAgentResult('wiki_search', {
          success: true,
          data: {
            hits: [],
            coverage: { density: 'empty', note: 'No indexed papers yet.' },
          },
        })
      }

      const aliases = loadAliasMap()
      const { tokens: expanded, expansions } = expandQueryTokens(query, aliases)
      const allHits = scoreQuery(bm25, expanded)

      // Build candidate set after facet filters
      const candidateSet = buildCandidateSet(filters)
      const filtered = candidateSet
        ? allHits.filter(h => candidateSet.has(h.slug))
        : allHits

      // Load sidecars for preview + filter validation we couldn't do with indices
      const topK = Math.min(k, 30)
      const hits = filtered.slice(0, topK).map(h => {
        const page = readPaperPage(h.slug)
        const sidecar = page?.sidecar
        return {
          slug: h.slug,
          title: page?.title ?? h.slug,
          tldr: sidecar?.tldr,
          paper_type: sidecar?.paper_type,
          source_tier: sidecar?.source_tier,
          score: Math.round(h.score * 100) / 100,
          matchedTokens: h.matchedTokens,
          lens_count: sidecar?.project_lenses?.length ?? 0,
        }
      })

      const totalBefore = allHits.length
      const totalAfter = filtered.length
      const matched = hits.length

      const density =
        matched === 0
          ? 'none'
          : totalBefore < 5
          ? 'thin'
          : totalBefore < 15
          ? 'moderate'
          : 'dense'

      // Phase 4 feedback loop: log thin/empty queries for later coverage analysis.
      if (density === 'none' || density === 'thin') {
        logLowYieldQuery({ query, matched, total: totalBefore })
      }

      return toAgentResult('wiki_search', {
        success: true,
        data: {
          hits,
          coverage: {
            density,
            total_candidates_before_filters: totalBefore,
            total_candidates_after_filters: totalAfter,
            matched,
            alias_expansions_used: expansions,
            note:
              'Local memory density only — NOT an assessment of literature coverage. ' +
              'When density is thin or none, escalate to external literature search. ' +
              'For exact quotes or numbers, use wiki_source(slug) to locate the underlying artifact.',
          },
        },
      })
    },
  }
}

interface SearchFilterValues {
  year_gte?: number
  year_lte?: number
  datasets?: string[]
  concepts?: string[]
  methods?: string[]
  paper_type?: string
  has_code?: boolean
  source_tier?: string
}

/**
 * Intersect facet indices according to the filter spec. Returns null
 * (= no filter constraint applied) when the filter object is empty.
 */
function buildCandidateSet(filters?: SearchFilterValues): Set<string> | null {
  if (!filters) return null
  const definedKeys = Object.entries(filters).filter(([, v]) => v !== undefined)
  if (definedKeys.length === 0) return null

  let current: Set<string> | null = null

  const applyIntersection = (add: Set<string>): void => {
    if (current === null) {
      current = add
      return
    }
    const next = new Set<string>()
    for (const slug of current) {
      if (add.has(slug)) next.add(slug)
    }
    current = next
  }

  if (filters.datasets && filters.datasets.length > 0) {
    const byDataset = loadBy('dataset')
    const union = new Set<string>()
    for (const d of filters.datasets) {
      const slugs = byDataset[d.toLowerCase()] ?? []
      for (const s of slugs) union.add(s)
    }
    applyIntersection(union)
  }

  if (filters.concepts && filters.concepts.length > 0) {
    const byConcept = loadBy('concept')
    // all-of semantics: paper must appear in every requested concept
    for (const c of filters.concepts) {
      const slugs = new Set(byConcept[c.toLowerCase()] ?? [])
      applyIntersection(slugs)
    }
  }

  if (filters.paper_type) {
    const byType = loadBy('paper-type')
    applyIntersection(new Set(byType[filters.paper_type] ?? []))
  }

  if (filters.methods && filters.methods.length > 0) {
    const byMethods = loadBy('methods')
    // any-of semantics: paper must mention at least one of the requested methods
    const union = new Set<string>()
    for (const m of filters.methods) {
      const slugs = byMethods[m.toLowerCase()] ?? []
      for (const s of slugs) union.add(s)
    }
    applyIntersection(union)
  }

  if (filters.year_gte !== undefined || filters.year_lte !== undefined) {
    const byYear = loadBy('year')
    const years = Object.keys(byYear)
      .map(y => parseInt(y, 10))
      .filter(y => Number.isFinite(y))
    const lo = filters.year_gte ?? 0
    const hi = filters.year_lte ?? 9999
    const union = new Set<string>()
    for (const y of years) {
      if (y >= lo && y <= hi) {
        for (const s of byYear[String(y)] ?? []) union.add(s)
      }
    }
    applyIntersection(union)
  }

  // has_code / source_tier require scanning sidecars — cheapest path is to
  // iterate `current` (or all papers) and filter via the parsed page
  if (filters.has_code !== undefined || filters.source_tier !== undefined) {
    const candidates: string[] = current ? Array.from(current as Set<string>) : listAllPaperSlugs()
    const keep = new Set<string>()
    for (const slug of candidates) {
      const page = readPaperPage(slug)
      if (!page?.sidecar) continue
      if (filters.has_code && !page.sidecar.code_url) continue
      if (filters.source_tier && page.sidecar.source_tier !== filters.source_tier) continue
      keep.add(slug)
    }
    current = keep
  }

  return current
}

function listAllPaperSlugs(): string[] {
  const dir = join(getWikiRoot(), 'papers')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

// ── wiki_get ───────────────────────────────────────────────────────────────

export function createWikiGetTool(): AgentTool {
  return {
    name: 'wiki_get',
    label: 'Wiki Get',
    description: `Read a paper or concept page from the local wiki memory in a targeted way.

Section namespaces:
- page:*   — Markdown body sections (page:summary, page:contributions, page:methodology, page:results, page:limitations, page:related, page:full).
             These are the human-readable memory narrative written by the wiki agent.
- meta:*   — structured memory sidecar fields (meta:tldr, meta:paper_type, meta:task, meta:methods, meta:datasets, meta:findings, meta:concept_edges, meta:aliases, meta:baselines, meta:source_tier, meta:parse_quality).
- lenses   — accumulated project-specific interpretations (project_lenses).

IMPORTANT: Both page:* and meta:* are MEMORY VIEWS. Neither is source evidence. page:* is prose and meta:* is structured, but they share the same epistemic status. For quoted numbers, direct citations, or careful comparisons, call wiki_source(slug) to locate the underlying paper artifact and read from there.`,
    parameters: Type.Object({
      slug: Type.String(),
      sections: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { slug, sections } = params as { slug: string; sections?: string[] }
      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_get', { success: true, data: 'Wiki not available.' })
      }

      const page = readPaperPage(slug) ?? readConceptPage(slug)
      if (!page) {
        return toAgentResult('wiki_get', {
          success: false,
          error: `No wiki page found for slug: ${slug}`,
        })
      }

      // Default: return a compact bundle
      const requested = sections && sections.length > 0 ? sections : ['meta:tldr', 'meta:paper_type', 'lenses']

      const out: Record<string, unknown> = { slug, title: page.title }
      for (const section of requested) {
        out[section] = readSection(page, section)
      }

      return toAgentResult('wiki_get', { success: true, data: out })
    },
  }
}

function readSection(page: PageParsed, section: string): unknown {
  if (section === 'page:full') return page.body
  if (section.startsWith('page:')) {
    const headings = PAGE_SECTION_HEADINGS[section]
    if (!headings) return { unavailable: true, reason: 'unknown-section' }
    for (const name of headings) {
      const content = extractMarkdownSection(page.body, name)
      if (content) return content
    }
    return { unavailable: true, reason: 'section-not-in-body' }
  }

  if (!page.sidecar) {
    return { unavailable: true, reason: 'no-sidecar' }
  }

  if (section === 'lenses') return page.sidecar.project_lenses ?? []

  if (section.startsWith('meta:')) {
    const field = section.slice(5) as keyof WikiPaperMemoryMeta
    return page.sidecar[field] ?? { unavailable: true, reason: 'field-absent' }
  }

  return { unavailable: true, reason: 'unknown-section' }
}

// ── wiki_coverage ──────────────────────────────────────────────────────────

export function createWikiCoverageTool(): AgentTool {
  return {
    name: 'wiki_coverage',
    label: 'Wiki Coverage',
    description:
      'Check what LOCAL MEMORY the wiki has accumulated about a topic. ' +
      'Call this before external literature search to decide whether we are starting from zero or already have a useful shortlist. ' +
      'Returns paper counts by facet + a density verdict. ' +
      'CRITICAL: Density describes LOCAL MEMORY only, not field coverage. Even "dense" local memory does not mean the field is covered; it only means we have accumulated prior work on this topic.',
    parameters: Type.Object({
      topic: Type.Optional(Type.String()),
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { topic } = params as { topic?: string }
      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_coverage', { success: true, data: 'Wiki not available.' })
      }

      const facets = loadFacets()
      if (!facets) {
        return toAgentResult('wiki_coverage', {
          success: true,
          data: {
            local_memory: 'empty',
            note: 'Indices not built yet. Let the wiki agent process papers first.',
          },
        })
      }

      if (!topic) {
        return toAgentResult('wiki_coverage', {
          success: true,
          data: {
            global: summarizeFacets(facets),
            note:
              'Local memory density only — NOT an assessment of the literature. ' +
              'Use wiki_search(query) to probe a specific topic.',
          },
        })
      }

      // Run an internal BM25 search and summarize
      const bm25 = loadBm25Index()
      if (!bm25 || bm25.numDocs === 0) {
        return toAgentResult('wiki_coverage', {
          success: true,
          data: { topic, local_memory: 'empty' },
        })
      }

      const aliases = loadAliasMap()
      const { tokens, expansions } = expandQueryTokens(topic, aliases)
      const hits = scoreQuery(bm25, tokens)
      const matchedSlugs = new Set(hits.map(h => h.slug))

      // Tally paper_types, source_tiers, concepts among matched papers
      const paperTypes: Record<string, number> = {}
      const sourceTiers: Record<string, number> = {}
      const conceptHits: Record<string, number> = {}
      for (const slug of matchedSlugs) {
        const page = readPaperPage(slug)
        if (!page?.sidecar) continue
        paperTypes[page.sidecar.paper_type] = (paperTypes[page.sidecar.paper_type] ?? 0) + 1
        sourceTiers[page.sidecar.source_tier] = (sourceTiers[page.sidecar.source_tier] ?? 0) + 1
        for (const edge of page.sidecar.concept_edges ?? []) {
          conceptHits[edge.slug] = (conceptHits[edge.slug] ?? 0) + 1
        }
      }

      const density =
        matchedSlugs.size === 0
          ? 'none'
          : matchedSlugs.size < 5
          ? 'thin'
          : matchedSlugs.size < 15
          ? 'moderate'
          : 'dense'

      return toAgentResult('wiki_coverage', {
        success: true,
        data: {
          topic,
          local_memory: density,
          matched_papers: matchedSlugs.size,
          paper_types: paperTypes,
          source_tiers: sourceTiers,
          top_concepts: Object.entries(conceptHits)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([slug, count]) => ({ slug, count })),
          alias_expansions_used: expansions,
          note:
            density === 'none' || density === 'thin'
              ? 'Local memory is thin on this topic. Escalate to external literature search.'
              : 'Local memory has prior coverage on this topic. This does NOT mean the field is covered — consult source artifacts for exact claims.',
        },
      })
    },
  }
}

function summarizeFacets(f: Facets) {
  return {
    total_papers: f.numPapers,
    paper_types: f.paperTypes,
    source_tiers: f.sourceTiers,
    top_concepts: f.topConcepts.slice(0, 15),
    top_datasets: f.topDatasets.slice(0, 10),
    top_methods: f.topMethods.slice(0, 10),
    years: f.years,
  }
}

// ── wiki_facets ────────────────────────────────────────────────────────────

export function createWikiFacetsTool(): AgentTool {
  return {
    name: 'wiki_facets',
    label: 'Wiki Facets',
    description:
      'Enumerate the top values of a facet across local wiki memory. ' +
      'Useful for discovering the vocabulary already present before forming a search query. ' +
      'These are navigation aids, not trust judgments.',
    parameters: Type.Object({
      facet: Type.Union([
        Type.Literal('datasets'),
        Type.Literal('concepts'),
        Type.Literal('methods'),
        Type.Literal('year'),
        Type.Literal('paper_type'),
        Type.Literal('source_tier'),
      ]),
      limit: Type.Optional(Type.Number({ default: 30 })),
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { facet, limit = 30 } = params as { facet: string; limit?: number }
      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_facets', { success: true, data: 'Wiki not available.' })
      }

      const facets = loadFacets()
      if (!facets) {
        return toAgentResult('wiki_facets', {
          success: true,
          data: { unavailable: true, reason: 'indices not built' },
        })
      }

      let values: Array<{ name: string; count: number }> = []
      switch (facet) {
        case 'datasets': values = facets.topDatasets; break
        case 'concepts': values = facets.topConcepts.map(c => ({ name: c.slug, count: c.count })); break
        case 'methods': values = facets.topMethods; break
        case 'year': values = Object.entries(facets.years).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })); break
        case 'paper_type': values = Object.entries(facets.paperTypes).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })); break
        case 'source_tier': values = Object.entries(facets.sourceTiers).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })); break
      }

      return toAgentResult('wiki_facets', {
        success: true,
        data: { facet, values: values.slice(0, limit) },
      })
    },
  }
}

// ── wiki_neighbors ─────────────────────────────────────────────────────────

export function createWikiNeighborsTool(): AgentTool {
  return {
    name: 'wiki_neighbors',
    label: 'Wiki Neighbors',
    description:
      'Find papers related to a given paper slug via shared concepts or baseline comparisons. ' +
      'Exploratory traversal — spurious edges cost one extra exploration step, nothing more.',
    parameters: Type.Object({
      slug: Type.String(),
      relation: Type.Optional(Type.Union([
        Type.Literal('shares_concept'),
        Type.Literal('baseline_of'),
        Type.Literal('all'),
      ])),
      limit: Type.Optional(Type.Number({ default: 20 })),
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { slug, relation = 'all', limit = 20 } = params as {
        slug: string
        relation?: string
        limit?: number
      }

      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_neighbors', { success: true, data: 'Wiki not available.' })
      }

      const graph = loadGraph()
      if (graph.length === 0) {
        return toAgentResult('wiki_neighbors', {
          success: true,
          data: { neighbors: [], note: 'Graph not built yet.' },
        })
      }

      const page = readPaperPage(slug)
      if (!page) {
        return toAgentResult('wiki_neighbors', { success: false, error: `No paper for slug: ${slug}` })
      }

      // Neighbors via shared concepts
      const myConcepts = new Set((page.sidecar?.concept_edges ?? []).map(e => e.slug))
      const neighborScores: Record<string, { slug: string; shared: string[] }> = {}

      if (relation === 'shares_concept' || relation === 'all') {
        for (const edge of graph) {
          if (edge.from === slug) continue
          if (myConcepts.has(edge.to)) {
            const entry = neighborScores[edge.from] ?? { slug: edge.from, shared: [] }
            if (!entry.shared.includes(edge.to)) entry.shared.push(edge.to)
            neighborScores[edge.from] = entry
          }
        }
      }

      // Neighbors via baseline references (sidecar baselines[].canonicalKey)
      const baselineNeighbors: string[] = []
      if (relation === 'baseline_of' || relation === 'all') {
        if (page.sidecar?.baselines) {
          const processed = readProcessedWatermark()
          for (const b of page.sidecar.baselines) {
            if (b.canonicalKey && processed.has(b.canonicalKey)) {
              const target = processed.get(b.canonicalKey)
              if (target?.slug) baselineNeighbors.push(target.slug)
            }
          }
        }
      }

      const sorted = Object.values(neighborScores)
        .sort((a, b) => b.shared.length - a.shared.length)
        .slice(0, limit)

      return toAgentResult('wiki_neighbors', {
        success: true,
        data: {
          slug,
          shares_concept: sorted.map(n => ({
            slug: n.slug,
            title: readPaperPage(n.slug)?.title ?? n.slug,
            shared_concepts: n.shared,
          })),
          baseline_of: baselineNeighbors.map(s => ({
            slug: s,
            title: readPaperPage(s)?.title ?? s,
          })),
          note: 'Memory-layer traversal only. Use wiki_get or wiki_source to read a specific neighbor.',
        },
      })
    },
  }
}

// ── wiki_source ────────────────────────────────────────────────────────────

export function createWikiSourceTool(): AgentTool {
  return {
    name: 'wiki_source',
    label: 'Wiki Source',
    description:
      'Bridge from a wiki paper slug to the closest available SOURCE-LAYER artifacts: project-local paper artifacts, cached converted fulltext, cached PDF, and canonical external references (DOI/arXiv URL). ' +
      'This is the tool to call when the coordinator needs exact numbers, direct quotes, or careful cross-paper comparisons. ' +
      'Wiki memory alone is never sufficient for citation-level precision — this tool is the required escalation path.',
    parameters: Type.Object({
      slug: Type.String(),
    }),
    execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
      const { slug } = params as { slug: string }
      const wikiRoot = getWikiRoot()
      if (!existsSync(wikiRoot)) {
        return toAgentResult('wiki_source', { success: true, data: 'Wiki not available.' })
      }

      // Find the canonicalKey for this slug via the processed watermark
      const processed = readProcessedWatermark()
      let canonicalKey: string | null = null
      for (const entry of processed.values()) {
        if (entry.slug === slug) {
          canonicalKey = entry.canonicalKey
          break
        }
      }

      if (!canonicalKey) {
        return toAgentResult('wiki_source', {
          success: false,
          error: `No processed watermark found for slug: ${slug}. The page may be a legacy RFC-003 body-only page.`,
        })
      }

      // Collect project artifacts from provenance
      const provenance = readProvenance()
      const projectArtifacts: Array<{
        project_path: string
        artifact_id: string
        path: string
        exists: boolean
      }> = []
      for (const entry of provenance) {
        if (entry.canonicalKey !== canonicalKey) continue
        const relPath = join('.research-pilot', 'artifacts', 'papers', `${entry.paperId}.md`)
        const absPath = join(entry.projectPath, relPath)
        projectArtifacts.push({
          project_path: entry.projectPath,
          artifact_id: entry.paperId,
          path: absPath,
          exists: existsSync(absPath),
        })
      }

      // Cached fulltext under the wiki
      const cachedFulltextPath = join(wikiRoot, 'converted', `${slug}.md`)
      const cachedFulltext = existsSync(cachedFulltextPath) ? cachedFulltextPath : null

      // Cached PDF (arxiv only for now — canonicalKey encodes arxiv ID)
      let cachedPdf: string | null = null
      if (canonicalKey.startsWith('arxiv:')) {
        const arxivId = canonicalKey.slice('arxiv:'.length)
        // Match the wiki downloader layout: raw/arxiv/<id>.pdf (with various id formats)
        const safe = arxivId.replace(/\//g, '_')
        const candidate = join(wikiRoot, 'raw', 'arxiv', `${safe}.pdf`)
        if (existsSync(candidate)) cachedPdf = candidate
      }

      // Canonical external references from canonicalKey
      const canonicalExternal: Record<string, string> = {}
      if (canonicalKey.startsWith('doi:')) {
        canonicalExternal.doi = canonicalKey.slice('doi:'.length)
      } else if (canonicalKey.startsWith('arxiv:')) {
        const id = canonicalKey.slice('arxiv:'.length)
        canonicalExternal.arxiv_id = id
        canonicalExternal.arxiv_url = `https://arxiv.org/abs/${id}`
      }

      return toAgentResult('wiki_source', {
        success: true,
        data: {
          slug,
          canonical_key: canonicalKey,
          project_artifacts: projectArtifacts.filter(a => a.exists).length > 0
            ? projectArtifacts
            : [],
          cached_fulltext: cachedFulltext,
          cached_pdf: cachedPdf,
          canonical_external: Object.keys(canonicalExternal).length > 0 ? canonicalExternal : null,
          note:
            projectArtifacts.length === 0 && !cachedFulltext && !cachedPdf
              ? 'No source-layer artifacts available. This paper only exists as wiki memory. ' +
                'Use canonical_external to pursue the paper externally, or run a fresh literature search.'
              : 'Source-layer artifacts located. Prefer cached_fulltext or project_artifacts for targeted reads; ' +
                'use cached_pdf for exact quotes or structured data (tables, figures).',
        },
      })
    },
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createWikiTools(): AgentTool[] {
  return [
    createWikiSearchTool(),
    createWikiGetTool(),
    createWikiCoverageTool(),
    createWikiFacetsTool(),
    createWikiNeighborsTool(),
    createWikiSourceTool(),
  ]
}
