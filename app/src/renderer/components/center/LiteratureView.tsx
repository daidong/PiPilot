import React, { useMemo, useState, useCallback, useEffect } from 'react'
import {
  Search,
  ArrowUpDown,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Star,
  BookOpen,
  Filter,
  X
} from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { WikiReaderPanel } from './WikiReaderPanel'
import {
  makeSearchable,
  scorePaper,
  tokenizeQuery,
  type SearchablePaper,
} from '../../../../../lib/search/paper-match'
import type { WikiPaperMeta } from '../../../../../lib/wiki/paper-meta-cache'

const api = (window as any).api

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score?: number }) {
  if (score == null) return null
  const color =
    score >= 8 ? 'text-emerald-500' : score >= 6 ? 'text-amber-500' : 't-text-muted'
  return (
    <span className={`text-[11px] font-medium tabular-nums ${color}`} title="Relevance score">
      {score}/10
    </span>
  )
}

// ─── Sort header cell ─────────────────────────────────────────────────────────

type SortKey = 'year' | 'relevance' | 'citations' | 'title'

function SortHeader({
  label,
  sortKey,
  currentSort,
  currentDir,
  onSort,
  className
}: {
  label: string
  sortKey: SortKey
  currentSort: SortKey
  currentDir: 'asc' | 'desc'
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = currentSort === sortKey
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors ${
        active ? 't-text-accent' : 't-text-muted hover:t-text-secondary'
      } ${className || ''}`}
    >
      {label}
      {active && (
        <ArrowUpDown size={10} className={currentDir === 'asc' ? 'rotate-180' : ''} />
      )}
    </button>
  )
}

// ─── Paper row ────────────────────────────────────────────────────────────────

function PaperRow({
  paper,
  expanded,
  onToggle,
  wikiSlug,
  isActive,
  source = 'project'
}: {
  paper: EntityItem
  expanded: boolean
  onToggle: () => void
  wikiSlug?: string | null
  isActive?: boolean
  source?: 'project' | 'wiki'
}) {
  const setWikiSlug = useUIStore((s) => s.setWikiReaderSlug)
  const authors = (paper.authors as string[]) || []
  const authorStr =
    authors.length <= 3
      ? authors.join(', ')
      : `${authors.slice(0, 2).join(', ')} et al.`
  const keyFindings = (paper.keyFindings as string[]) || []
  const isWiki = source === 'wiki'

  return (
    <div className={`border-b t-border last:border-b-0 ${isActive ? 'bg-[var(--color-accent-soft)]/8' : ''} ${isWiki ? 'border-l-2 border-l-[var(--color-accent-soft)]' : ''}`}>
      <div
        className={`flex items-center gap-3 px-3 py-2 transition-colors cursor-pointer ${
          isActive ? 'bg-[var(--color-accent-soft)]/10' : 'hover:bg-[var(--color-accent-soft)]/5'
        }`}
        onClick={onToggle}
      >
        <button className="shrink-0 t-text-muted">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Title + authors */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-[13px] t-text font-medium truncate leading-tight">
              {paper.title}
            </p>
            {isWiki && (
              <span
                className="shrink-0 px-1.5 py-0 text-[9px] uppercase tracking-wider rounded t-text-accent bg-[var(--color-accent-soft)]/15 border border-[var(--color-accent-soft)]/30"
                title="From paper wiki — not in this project"
              >
                Wiki
              </span>
            )}
          </div>
          <p className="text-[11px] t-text-muted truncate mt-0.5">
            {authorStr}
          </p>
        </div>

        {/* Year */}
        <span className="shrink-0 text-[11px] t-text-muted tabular-nums w-10 text-right">
          {(paper.year as number) || '—'}
        </span>

        {/* Score */}
        <div className="shrink-0 w-10 text-right">
          <ScoreBadge score={paper.relevanceScore as number | undefined} />
        </div>

        {/* Open in wiki reader */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setWikiSlug(wikiSlug || `paper:${paper.id}`)
          }}
          className={`shrink-0 p-1 rounded transition-colors ${
            wikiSlug
              ? 't-text-accent-soft hover:t-text-accent'
              : 't-text-muted hover:t-text-accent-soft'
          }`}
          title={wikiSlug ? 'View wiki page' : 'View paper details'}
        >
          <BookOpen size={13} />
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-10 pb-3 space-y-2">
          {/* Metadata chips */}
          <div className="flex flex-wrap gap-1.5">
            {paper.venue && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                {paper.venue as string}
              </span>
            )}
            {paper.subTopic && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-accent-soft)]/10 t-text-accent">
                {paper.subTopic as string}
              </span>
            )}
            {paper.doi && !(paper.doi as string).startsWith('unknown:') && (
              <a
                href={`https://doi.org/${paper.doi}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                DOI <ExternalLink size={8} />
              </a>
            )}
            {paper.url && (
              <a
                href={paper.url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Link <ExternalLink size={8} />
              </a>
            )}
          </div>

          {/* Abstract */}
          {paper.abstract && (
            <p className="text-xs t-text-secondary leading-relaxed">
              {(paper.abstract as string).length > 500
                ? (paper.abstract as string).slice(0, 500) + '...'
                : paper.abstract as string}
            </p>
          )}

          {/* Relevance justification */}
          {paper.relevanceJustification && (
            <div className="flex items-start gap-1.5">
              <Star size={11} className="shrink-0 mt-0.5 t-text-accent-soft" />
              <p className="text-[11px] t-text-muted italic">
                {paper.relevanceJustification as string}
              </p>
            </div>
          )}

          {/* Key findings */}
          {keyFindings.length > 0 && (
            <div>
              <p className="text-[10px] t-text-muted uppercase tracking-wider mb-1">Key Findings</p>
              <ul className="space-y-0.5">
                {keyFindings.map((f, i) => (
                  <li key={i} className="text-xs t-text-secondary flex items-start gap-1.5">
                    <span className="shrink-0 mt-1 w-1 h-1 rounded-full bg-[var(--color-accent-soft)]" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Wiki status pill ─────────────────────────────────────────────────────────
// Compact live indicator for the background Paper Wiki agent. Subscribes to
// `wiki:status` events so the state dot and progress update in real time.
// Self-hides when the agent is disabled (model = none) so it doesn't clutter
// the bar when the feature is turned off.

interface WikiStatusShape {
  state: 'processing' | 'idle' | 'paused' | 'disabled'
  processed: number
  pending: number
  totalInWiki: number
  lastRunAt?: string
}

function WikiStatusPill() {
  const [status, setStatus] = useState<WikiStatusShape | null>(null)

  useEffect(() => {
    let cancelled = false
    api.wikiGetStatus?.().then((s: WikiStatusShape | null) => {
      if (!cancelled) setStatus(s)
    }).catch(() => {})
    const unsub = api.onWikiStatus?.((s: WikiStatusShape) => setStatus(s))
    return () => { cancelled = true; unsub?.() }
  }, [])

  if (!status || status.state === 'disabled') return null

  const isProcessing = status.state === 'processing'
  const isPaused = status.state === 'paused'

  // Progress: processed / (processed + pending) within the current batch.
  // When idle, we show totalInWiki instead of a progress bar.
  const totalInBatch = status.processed + status.pending
  const pct = totalInBatch > 0 ? Math.round((status.processed / totalInBatch) * 100) : 0

  const dotClass = isProcessing
    ? 'bg-blue-500 animate-pulse'
    : isPaused
      ? 'bg-yellow-500'
      : 'bg-emerald-500'

  const label = isProcessing
    ? `Wiki · processing${totalInBatch > 0 ? ` ${status.processed}/${totalInBatch}` : ''}`
    : isPaused
      ? 'Wiki · paused'
      : `Wiki · idle${status.totalInWiki > 0 ? ` · ${status.totalInWiki} pages` : ''}`

  return (
    <div
      className="ml-auto flex items-center gap-2 shrink-0"
      title={status.lastRunAt ? `Last tick: ${new Date(status.lastRunAt).toLocaleString()}` : undefined}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className="t-text-muted tabular-nums">{label}</span>
      {isProcessing && totalInBatch > 0 && (
        <div className="w-16 h-1 rounded-full t-bg-elevated overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Coverage bar ─────────────────────────────────────────────────────────────

function CoverageBar({ papers }: { papers: EntityItem[] }) {
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) {
      const topic = (p.subTopic as string) || 'Uncategorized'
      counts.set(topic, (counts.get(topic) || 0) + 1)
    }
    return counts
  }, [papers])

  const scored = papers.filter((p) => (p.relevanceScore as number) != null)
  const avgScore =
    scored.length > 0
      ? scored.reduce((s, p) => s + ((p.relevanceScore as number) || 0), 0) / scored.length
      : 0
  const highRelevance = papers.filter((p) => ((p.relevanceScore as number) || 0) >= 7).length

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t t-border t-bg-surface text-[11px] t-text-muted">
      <span>{papers.length} papers</span>
      <span>{topicCounts.size} topics</span>
      {scored.length > 0 && (
        <span>avg score: {avgScore.toFixed(1)}</span>
      )}
      {highRelevance > 0 && (
        <span className="t-text-accent-soft">{highRelevance} highly relevant</span>
      )}
      <div className="max-w-48 w-48">
        <div className="h-1.5 rounded-full t-bg-elevated overflow-hidden">
          <div
            className="h-full rounded-full t-gradient-accent-h"
            style={{
              width: `${Math.min(100, (highRelevance / Math.max(papers.length, 1)) * 100)}%`,
            }}
          />
        </div>
      </div>
      <WikiStatusPill />
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar({ topics }: { topics: string[] }) {
  const filter = useUIStore((s) => s.literatureFilter)
  const setFilter = useUIStore((s) => s.setLiteratureFilter)
  const [showFilters, setShowFilters] = useState(false)

  const hasActiveFilters = filter.minScore > 0 || filter.source || filter.round

  return (
    <div className="px-4 py-2 border-b t-border space-y-2">
      <div className="flex items-center gap-2">
        {/* Search */}
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 t-text-muted" />
          <input
            type="text"
            value={filter.search}
            onChange={(e) => setFilter({ search: e.target.value })}
            placeholder="Search papers..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border t-border t-bg-surface t-text focus:outline-none focus:border-[var(--color-accent-soft)]"
          />
          {filter.search && (
            <button
              onClick={() => setFilter({ search: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 t-text-muted hover:t-text"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Topic dropdown */}
        {topics.length > 0 && (
          <select
            value={filter.subTopic || ''}
            onChange={(e) => setFilter({ subTopic: e.target.value || null })}
            className="px-2 py-1.5 text-xs rounded-lg border t-border t-bg-surface t-text max-w-40"
          >
            <option value="">All topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg border t-border transition-colors ${
            hasActiveFilters
              ? 'border-[var(--color-accent-soft)] t-text-accent'
              : 't-text-muted hover:t-text-secondary'
          }`}
        >
          <Filter size={12} />
          {hasActiveFilters && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-soft)]" />
          )}
        </button>
      </div>

      {/* Expanded filters */}
      {showFilters && (
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1 t-text-muted">
            Min score:
            <input
              type="number"
              min={0}
              max={10}
              value={filter.minScore}
              onChange={(e) => setFilter({ minScore: Number(e.target.value) })}
              className="w-12 px-1.5 py-0.5 rounded border t-border t-bg-surface t-text text-center"
            />
          </label>
          {hasActiveFilters && (
            <button
              onClick={() => setFilter({ minScore: 0, source: null, round: null })}
              className="text-[10px] t-text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

// ─── Row view-model ───────────────────────────────────────────────────────

interface SearchRow {
  key: string                // stable React key, also the activeRowKey target
  source: 'project' | 'wiki'
  paper: EntityItem          // real EntityItem for project rows, pseudo for wiki
  wikiSlug?: string          // wiki page slug if known
  searchable: SearchablePaper
}

/** Build a pseudo-EntityItem from a wiki paper meta so PaperRow can render it. */
function wikiMetaToEntityItem(meta: WikiPaperMeta): EntityItem {
  return {
    id: `wiki:${meta.slug}`,
    type: 'paper',
    title: meta.title,
    authors: meta.authors,
    year: meta.year,
    venue: meta.venue,
    abstract: meta.tldr,   // show tldr as abstract preview for wiki rows
  }
}

export function LiteratureView() {
  const papers = useEntityStore((s) => s.papers)
  const filter = useUIStore((s) => s.literatureFilter)
  const setFilter = useUIStore((s) => s.setLiteratureFilter)
  const wikiReaderSlug = useUIStore((s) => s.wikiReaderSlug)
  const setWikiSlug = useUIStore((s) => s.setWikiReaderSlug)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  // Wiki slug lookup: paperId → slug (batch loaded once)
  const [wikiSlugs, setWikiSlugs] = useState<Record<string, string>>({})
  // Wiki paper metadata, loaded once per session for cross-project search
  const [wikiMeta, setWikiMeta] = useState<WikiPaperMeta[]>([])

  useEffect(() => {
    let cancelled = false
    api.wikiPaperSlugMap?.().then((map: Record<string, string>) => {
      if (!cancelled && map) setWikiSlugs(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [papers])

  useEffect(() => {
    let cancelled = false
    api.wikiListPaperMeta?.().then((list: WikiPaperMeta[]) => {
      if (!cancelled && Array.isArray(list)) setWikiMeta(list)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Sort toggle
  const handleSort = useCallback(
    (key: SortKey) => {
      if (filter.sortBy === key) {
        setFilter({ sortDir: filter.sortDir === 'desc' ? 'asc' : 'desc' })
      } else {
        setFilter({ sortBy: key, sortDir: key === 'title' ? 'asc' : 'desc' })
      }
    },
    [filter.sortBy, filter.sortDir, setFilter]
  )

  // Collect topics for dropdown
  const topics = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) {
      const topic = (p.subTopic as string)
      if (topic) counts.set(topic, (counts.get(topic) || 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
  }, [papers])

  // ── Row view-models: project rows + wiki-only rows (deduped) ─────────────

  const projectRows = useMemo<SearchRow[]>(() => {
    return papers.map((p) => ({
      key: `project:${p.id}`,
      source: 'project',
      paper: p,
      wikiSlug: wikiSlugs[p.id],
      searchable: makeSearchable({
        title: p.title || '',
        authors: (p.authors as string[]) || [],
        venue: p.venue as string | undefined,
        tldr: undefined,
        abstract: p.abstract as string | undefined,
      }),
    }))
  }, [papers, wikiSlugs])

  const wikiOnlyRows = useMemo<SearchRow[]>(() => {
    // `wikiSlugs` is already a canonicalKey-driven mapping (buildPaperSlugMap()
    // in lib/wiki/io.ts pairs project papers to wiki pages by canonical key),
    // so a slug hit here implies a canonical match too. No separate canonicalKey
    // index is needed on the renderer side.
    const usedSlugs = new Set(Object.values(wikiSlugs))

    return wikiMeta
      .filter((m) => !usedSlugs.has(m.slug))
      .map((m) => ({
        key: `wiki:${m.slug}`,
        source: 'wiki' as const,
        paper: wikiMetaToEntityItem(m),
        wikiSlug: m.slug,
        searchable: makeSearchable({
          title: m.title,
          authors: m.authors,
          venue: m.venue,
          tldr: m.tldr,
        }),
      }))
  }, [wikiMeta, papers, wikiSlugs])

  // ── Filter + sort into the final row list ────────────────────────────────

  const filteredRows = useMemo<SearchRow[]>(() => {
    const query = filter.search.trim()
    const tokens = query ? tokenizeQuery(query) : []
    const searching = tokens.length > 0

    // Non-search filters apply only to project rows. Wiki rows always bypass
    // them — they're the secondary recall pool and don't carry those fields.
    const passesProjectFilters = (p: EntityItem): boolean => {
      if (filter.subTopic && ((p.subTopic as string) || 'Uncategorized') !== filter.subTopic) return false
      if (filter.minScore > 0 && ((p.relevanceScore as number) || 0) < filter.minScore) return false
      if (filter.source && (p.externalSource as string) !== filter.source) return false
      if (filter.round && (p.addedInRound as string) !== filter.round) return false
      return true
    }

    type Scored = { row: SearchRow; score: number }
    const scored: Scored[] = []

    for (const row of projectRows) {
      if (!passesProjectFilters(row.paper)) continue
      if (searching) {
        const s = scorePaper(tokens, row.searchable)
        if (s == null) continue
        scored.push({ row, score: s })
      } else {
        scored.push({ row, score: 0 })
      }
    }

    if (searching) {
      for (const row of wikiOnlyRows) {
        const s = scorePaper(tokens, row.searchable)
        if (s == null) continue
        scored.push({ row, score: s })
      }
    }

    const dir = filter.sortDir === 'desc' ? -1 : 1
    const compareSortKey = (a: EntityItem, b: EntityItem): number => {
      switch (filter.sortBy) {
        case 'year': return (((a.year as number) || 0) - ((b.year as number) || 0)) * dir
        case 'relevance': return (((a.relevanceScore as number) || 0) - ((b.relevanceScore as number) || 0)) * dir
        case 'citations': return (((a.citationCount as number) || 0) - ((b.citationCount as number) || 0)) * dir
        case 'title': return a.title.localeCompare(b.title) * dir
        default: return 0
      }
    }

    scored.sort((a, b) => {
      if (searching) {
        // matchScore desc primary, current sort key as tie-break
        if (a.score !== b.score) return b.score - a.score
      }
      return compareSortKey(a.row.paper, b.row.paper)
    })

    return scored.map((s) => s.row)
  }, [projectRows, wikiOnlyRows, filter])

  // Auto-select first row in wiki reader when none is selected
  useEffect(() => {
    if (wikiReaderSlug || filteredRows.length === 0) return
    const first = filteredRows[0]
    if (first.source === 'wiki') {
      setWikiSlug(first.wikiSlug!)
    } else {
      setWikiSlug(first.wikiSlug || `paper:${first.paper.id}`)
    }
  }, [filteredRows, wikiReaderSlug, setWikiSlug])

  // Which row is currently active in the reader (for highlighting)
  const activeRowKey = useMemo<string | null>(() => {
    if (!wikiReaderSlug) return null
    if (wikiReaderSlug.startsWith('paper:')) {
      return `project:${wikiReaderSlug.slice('paper:'.length)}`
    }
    // A real wiki slug. First try to match a project row that points to it.
    for (const [paperId, slug] of Object.entries(wikiSlugs)) {
      if (slug === wikiReaderSlug) return `project:${paperId}`
    }
    // Otherwise it must be a wiki-only row.
    return `wiki:${wikiReaderSlug}`
  }, [wikiReaderSlug, wikiSlugs])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <FilterBar topics={topics} />

      <div className="flex-1 flex min-h-0">
        {/* Paper table */}
        <div className="w-1/2 flex flex-col min-w-0 border-r t-border">
          {/* Table header */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-b t-border t-bg-surface">
            <div className="w-5" />
            <div className="flex-1">
              <SortHeader
                label="Title"
                sortKey="title"
                currentSort={filter.sortBy}
                currentDir={filter.sortDir}
                onSort={handleSort}
              />
            </div>
            <SortHeader
              label="Year"
              sortKey="year"
              currentSort={filter.sortBy}
              currentDir={filter.sortDir}
              onSort={handleSort}
              className="w-10 justify-end"
            />
            <SortHeader
              label="Score"
              sortKey="relevance"
              currentSort={filter.sortBy}
              currentDir={filter.sortDir}
              onSort={handleSort}
              className="w-10 justify-end"
            />
            <div className="w-8" />
          </div>

          {/* Paper rows */}
          <div className="flex-1 overflow-y-auto">
            {filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-8">
                <BookOpen size={32} className="t-text-muted mb-3 opacity-40" />
                <p className="text-sm t-text-muted">
                  {papers.length === 0
                    ? 'No papers yet. Use the chat to search for literature.'
                    : 'No papers match your filters.'}
                </p>
              </div>
            ) : (
              filteredRows.map((row) => (
                <PaperRow
                  key={row.key}
                  paper={row.paper}
                  source={row.source}
                  expanded={expandedKey === row.key}
                  isActive={activeRowKey === row.key}
                  onToggle={() => {
                    setExpandedKey(expandedKey === row.key ? null : row.key)
                    if (row.source === 'wiki') {
                      setWikiSlug(row.wikiSlug!)
                    } else {
                      setWikiSlug(row.wikiSlug || `paper:${row.paper.id}`)
                    }
                  }}
                  wikiSlug={row.wikiSlug}
                />
              ))
            )}
          </div>
        </div>

        {/* Wiki reader panel — always visible */}
        <div className="w-1/2 min-w-0">
          <WikiReaderPanel />
        </div>
      </div>

      <CoverageBar papers={filteredRows.filter((r) => r.source === 'project').map((r) => r.paper)} />
    </div>
  )
}
