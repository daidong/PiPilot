/**
 * Wiki Indexer — RFC-005 §9, §13 Phase 2.
 *
 * Walks papers/*.md, parses each memory sidecar, and writes a set of
 * deterministic indices under `index/`. All indices are fully derivable
 * and can be nuked + rebuilt at any time.
 *
 * Output files:
 *   - bm25.json        — inverted token index (see bm25.ts)
 *   - aliases.json     — alias → canonical slug map
 *   - by-dataset.json  — dataset name (lowercased) → [slug]
 *   - by-concept.json  — concept slug → [slug]
 *   - by-year.json     — year → [slug]
 *   - by-paper-type.json — paper_type → [slug]
 *   - graph.jsonl      — typed edges {from, to, type}
 *   - facets.json      — top-level counts for wiki_coverage
 *
 * MUST be called under withWikiLock (it rewrites files in index/).
 */

import { existsSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getWikiRoot } from './types.js'
import { safeReadFile, safeWriteFile } from './io.js'
import { parsePaperPage } from './meta-parser.js'
import type { WikiPaperMemoryMeta } from './memory-schema.js'
import { Bm25Builder, type Bm25Index, tokenize } from './bm25.js'

// ── File path helpers ──────────────────────────────────────────────────────

function indexDir(): string {
  return join(getWikiRoot(), 'index')
}

function ensureIndexDir(): void {
  const dir = indexDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export const INDEX_FILES = {
  bm25: 'bm25.json',
  aliases: 'aliases.json',
  byDataset: 'by-dataset.json',
  byConcept: 'by-concept.json',
  byYear: 'by-year.json',
  byPaperType: 'by-paper-type.json',
  byMethods: 'by-methods.json',
  graph: 'graph.jsonl',
  facets: 'facets.json',
} as const

// ── Supporting types ───────────────────────────────────────────────────────

export interface GraphEdge {
  from: string            // paper slug
  to: string              // concept slug or other paper slug
  type: 'concept'         // 'introduces' | 'uses' | ... carried in `relation`
  relation?: string
}

export interface Facets {
  numPapers: number
  sourceTiers: Record<string, number>
  paperTypes: Record<string, number>
  topConcepts: Array<{ slug: string; count: number }>
  topDatasets: Array<{ name: string; count: number }>
  topMethods: Array<{ name: string; count: number }>
  years: Record<string, number>
}

export interface IndexedPaper {
  slug: string
  title: string
  tldr?: string
  paper_type: WikiPaperMemoryMeta['paper_type']
  source_tier: WikiPaperMemoryMeta['source_tier']
  year?: number
  datasets: string[]       // lowercased dataset names
  concepts: string[]       // concept slugs this paper links to
  methods: string[]
  aliases: string[]
  has_code: boolean
  sidecar: WikiPaperMemoryMeta
  body: string
}

// ── Parsing helpers ────────────────────────────────────────────────────────

function parseTitleFromBody(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

function parseYearFromBody(body: string): number | null {
  // Looks for "**Year:** 2023" or "**Year:** 2023-01" in the header line
  const m = body.match(/\*\*Year:\*\*\s*(\d{4})/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  return Number.isFinite(y) && y > 1900 && y < 3000 ? y : null
}

// ── Main entry ─────────────────────────────────────────────────────────────

export interface RebuildResult {
  numPapers: number
  numTokens: number
  numAliases: number
  numEdges: number
}

export function rebuildMemoryIndex(): RebuildResult {
  ensureIndexDir()

  const root = getWikiRoot()
  const papersDir = join(root, 'papers')
  if (!existsSync(papersDir)) {
    return { numPapers: 0, numTokens: 0, numAliases: 0, numEdges: 0 }
  }

  const files = readdirSync(papersDir).filter(f => f.endsWith('.md'))
  const papers: IndexedPaper[] = []

  // 1. Parse every paper page
  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const content = safeReadFile(join(papersDir, file))
    if (!content) continue

    const parsed = parsePaperPage(content, slug)
    const body = parsed.body

    const title = parseTitleFromBody(body) ?? slug
    const year = parseYearFromBody(body) ?? undefined

    // Legacy body-only pages get a synthetic "empty" indexed entry so that
    // BM25 still catches body prose but facets reflect only sidecar-equipped
    // papers.
    if (!parsed.sidecar) {
      papers.push({
        slug,
        title,
        paper_type: 'method',   // placeholder for legacy pages — facet filters skip them
        source_tier: 'abstract-only',  // conservative default for legacy
        year,
        datasets: [],
        concepts: [],
        methods: [],
        aliases: [],
        has_code: false,
        sidecar: null as unknown as WikiPaperMemoryMeta,  // marker for legacy
        body,
      })
      continue
    }

    const sidecar = parsed.sidecar
    papers.push({
      slug,
      title,
      tldr: sidecar.tldr,
      paper_type: sidecar.paper_type,
      source_tier: sidecar.source_tier,
      year,
      datasets: (sidecar.datasets ?? []).map(d => d.name.toLowerCase()),
      concepts: (sidecar.concept_edges ?? []).map(e => e.slug),
      methods: sidecar.methods ?? [],
      aliases: sidecar.aliases ?? [],
      has_code: Boolean(sidecar.code_url),
      sidecar,
      body,
    })
  }

  // 2. BM25 index
  const bm25 = buildBm25(papers)
  safeWriteFile(join(indexDir(), INDEX_FILES.bm25), JSON.stringify(bm25))

  // 3. Alias map
  const aliases = buildAliasMap(papers)
  safeWriteFile(join(indexDir(), INDEX_FILES.aliases), JSON.stringify(aliases, null, 2))

  // 4. Inverted facet indices
  const byDataset = invertBy(papers, p => p.datasets)
  const byConcept = invertBy(papers, p => p.concepts)
  const byPaperType = invertBy(papers, p => p.sidecar ? [p.paper_type] : [])
  const byYear = invertBy(papers, p => p.year ? [String(p.year)] : [])
  const byMethods = invertBy(papers, p => p.methods)

  safeWriteFile(join(indexDir(), INDEX_FILES.byDataset), JSON.stringify(byDataset, null, 2))
  safeWriteFile(join(indexDir(), INDEX_FILES.byConcept), JSON.stringify(byConcept, null, 2))
  safeWriteFile(join(indexDir(), INDEX_FILES.byPaperType), JSON.stringify(byPaperType, null, 2))
  safeWriteFile(join(indexDir(), INDEX_FILES.byYear), JSON.stringify(byYear, null, 2))
  safeWriteFile(join(indexDir(), INDEX_FILES.byMethods), JSON.stringify(byMethods, null, 2))

  // 5. Concept graph (one line per typed edge)
  const edges: GraphEdge[] = []
  for (const p of papers) {
    if (!p.sidecar) continue
    for (const edge of p.sidecar.concept_edges ?? []) {
      edges.push({ from: p.slug, to: edge.slug, type: 'concept', relation: edge.relation })
    }
  }
  const graphContent = edges.map(e => JSON.stringify(e)).join('\n') + (edges.length > 0 ? '\n' : '')
  safeWriteFile(join(indexDir(), INDEX_FILES.graph), graphContent)

  // 6. Facets (top-level counts for wiki_coverage)
  const facets = buildFacets(papers, byConcept, byDataset)
  safeWriteFile(join(indexDir(), INDEX_FILES.facets), JSON.stringify(facets, null, 2))

  return {
    numPapers: papers.length,
    numTokens: Object.keys(bm25.postings).length,
    numAliases: Object.keys(aliases).length,
    numEdges: edges.length,
  }
}

// ── BM25 builder ───────────────────────────────────────────────────────────

function buildBm25(papers: IndexedPaper[]): Bm25Index {
  const builder = new Bm25Builder()

  for (const p of papers) {
    builder.addField(p.slug, 'title', p.title)
    if (p.tldr) builder.addField(p.slug, 'tldr', p.tldr)

    // Alias field is one of the biggest retrieval wins
    for (const alias of p.aliases) {
      builder.addField(p.slug, 'alias', alias)
    }

    // Dataset names, methods, and tasks as separate weighted fields
    for (const ds of p.sidecar?.datasets ?? []) {
      builder.addField(p.slug, 'dataset_name', ds.name)
      if (ds.alias) builder.addField(p.slug, 'dataset_name', ds.alias)
    }
    for (const m of p.methods) {
      builder.addField(p.slug, 'methods', m)
    }
    for (const t of p.sidecar?.task ?? []) {
      builder.addField(p.slug, 'task', t)
    }
    for (const f of p.sidecar?.findings ?? []) {
      builder.addField(p.slug, 'finding_statement', f.statement)
    }
    for (const e of p.sidecar?.concept_edges ?? []) {
      // The slug itself — expand hyphens to spaces so "flash-attention" tokenizes
      builder.addField(p.slug, 'concept_title', e.slug.replace(/-/g, ' '))
    }

    // Body headings get medium weight
    const headings = Array.from(p.body.matchAll(/^#+\s+(.+?)\s*$/gm)).map(m => m[1])
    for (const h of headings) builder.addField(p.slug, 'heading', h)

    // Full body prose (after stripping headings) as lowest-weight fallback
    builder.addField(p.slug, 'body', p.body)
  }

  return builder.build()
}

// ── Alias map ──────────────────────────────────────────────────────────────

/**
 * Build alias → canonical slug map.
 * Sources: each paper's `aliases[]` and `concept_edges[].slug`.
 * Conflict resolution: first-writer-wins (RFC-005 §7.2 note).
 */
function buildAliasMap(papers: IndexedPaper[]): Record<string, string> {
  const map: Record<string, string> = {}

  const addAlias = (rawAlias: string, canonical: string) => {
    const key = rawAlias.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!key) return
    if (!(key in map)) map[key] = canonical
  }

  // Paper aliases → paper slug
  for (const p of papers) {
    for (const alias of p.aliases) {
      addAlias(alias, p.slug)
    }
  }

  // Concept slugs → themselves (plus space-separated form for natural queries)
  // e.g., "flash-attention" → "flash-attention" and "flash attention" → "flash-attention"
  const seenConcepts = new Set<string>()
  for (const p of papers) {
    for (const concept of p.concepts) {
      if (seenConcepts.has(concept)) continue
      seenConcepts.add(concept)
      addAlias(concept, concept)
      addAlias(concept.replace(/-/g, ' '), concept)
    }
  }

  return map
}

// ── Inverted facet index helpers ───────────────────────────────────────────

function invertBy(
  papers: IndexedPaper[],
  extract: (p: IndexedPaper) => string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const p of papers) {
    for (const key of extract(p)) {
      if (!key) continue
      const k = key.toLowerCase()
      if (!out[k]) out[k] = []
      if (!out[k].includes(p.slug)) out[k].push(p.slug)
    }
  }
  return out
}

// ── Facets ─────────────────────────────────────────────────────────────────

function buildFacets(
  papers: IndexedPaper[],
  byConcept: Record<string, string[]>,
  byDataset: Record<string, string[]>,
): Facets {
  const sourceTiers: Record<string, number> = {}
  const paperTypes: Record<string, number> = {}
  const years: Record<string, number> = {}
  const methodCounts: Record<string, number> = {}

  for (const p of papers) {
    if (p.sidecar) {
      sourceTiers[p.source_tier] = (sourceTiers[p.source_tier] ?? 0) + 1
      paperTypes[p.paper_type] = (paperTypes[p.paper_type] ?? 0) + 1
    }
    if (p.year !== undefined) {
      const key = String(p.year)
      years[key] = (years[key] ?? 0) + 1
    }
    for (const m of p.methods) {
      const key = m.toLowerCase()
      methodCounts[key] = (methodCounts[key] ?? 0) + 1
    }
  }

  const topFrom = (counts: Record<string, number>, limit: number) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)

  const topConcepts = topFrom(
    Object.fromEntries(Object.entries(byConcept).map(([k, v]) => [k, v.length])),
    30,
  ).map(([slug, count]) => ({ slug, count }))

  const topDatasets = topFrom(
    Object.fromEntries(Object.entries(byDataset).map(([k, v]) => [k, v.length])),
    30,
  ).map(([name, count]) => ({ name, count }))

  const topMethods = topFrom(methodCounts, 30).map(([name, count]) => ({ name, count }))

  return {
    numPapers: papers.length,
    sourceTiers,
    paperTypes,
    topConcepts,
    topDatasets,
    topMethods,
    years,
  }
}

// ── Loaders (used by wiki_* tools) ─────────────────────────────────────────

export function loadBm25Index(): Bm25Index | null {
  const content = safeReadFile(join(indexDir(), INDEX_FILES.bm25))
  if (!content) return null
  try { return JSON.parse(content) as Bm25Index } catch { return null }
}

export function loadAliasMap(): Record<string, string> {
  const content = safeReadFile(join(indexDir(), INDEX_FILES.aliases))
  if (!content) return {}
  try { return JSON.parse(content) as Record<string, string> } catch { return {} }
}

export function loadBy(kind: 'dataset' | 'concept' | 'year' | 'paper-type' | 'methods'): Record<string, string[]> {
  const file = {
    dataset: INDEX_FILES.byDataset,
    concept: INDEX_FILES.byConcept,
    year: INDEX_FILES.byYear,
    'paper-type': INDEX_FILES.byPaperType,
    methods: INDEX_FILES.byMethods,
  }[kind]
  const content = safeReadFile(join(indexDir(), file))
  if (!content) return {}
  try { return JSON.parse(content) as Record<string, string[]> } catch { return {} }
}

export function loadFacets(): Facets | null {
  const content = safeReadFile(join(indexDir(), INDEX_FILES.facets))
  if (!content) return null
  try { return JSON.parse(content) as Facets } catch { return null }
}

export function loadGraph(): GraphEdge[] {
  const content = safeReadFile(join(indexDir(), INDEX_FILES.graph))
  if (!content) return []
  const out: GraphEdge[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* skip */ }
  }
  return out
}

/**
 * Query alias expansion. Given a query string, split into tokens,
 * run each through the alias map, and return the expanded token set
 * (originals + any alias targets).
 */
export function expandQueryTokens(query: string, aliases: Record<string, string>): { tokens: string[]; expansions: string[] } {
  const tokens = tokenize(query)
  const expanded = new Set<string>(tokens)
  const expansions: string[] = []

  // Try the whole lowercased query as a single alias lookup first
  const whole = query.toLowerCase().replace(/\s+/g, ' ').trim()
  if (whole in aliases) {
    const target = aliases[whole]
    for (const t of tokenize(target.replace(/-/g, ' '))) expanded.add(t)
    expansions.push(`${whole} → ${target}`)
  }

  // Also try individual tokens (e.g., "flash-attn" → "flash-attention")
  for (const t of tokens) {
    if (t in aliases && aliases[t] !== t) {
      const target = aliases[t]
      for (const et of tokenize(target.replace(/-/g, ' '))) expanded.add(et)
      expansions.push(`${t} → ${target}`)
    }
  }

  return { tokens: Array.from(expanded), expansions }
}
