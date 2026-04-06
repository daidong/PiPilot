import React, { useMemo, useState, useCallback } from 'react'
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

// ─── Sub-topic tree sidebar ───────────────────────────────────────────────────

function TopicTree({
  papers,
  selectedTopic,
  onSelect
}: {
  papers: EntityItem[]
  selectedTopic: string | null
  onSelect: (topic: string | null) => void
}) {
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of papers) {
      const topic = (p.subTopic as string) || 'Uncategorized'
      counts.set(topic, (counts.get(topic) || 0) + 1)
    }
    // Sort by count desc
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [papers])

  return (
    <div className="w-48 shrink-0 border-r t-border overflow-y-auto py-2">
      <button
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
          selectedTopic === null
            ? 't-text-accent font-medium bg-[var(--color-accent-soft)]/10'
            : 't-text-secondary hover:t-bg-hover'
        }`}
      >
        All Topics ({papers.length})
      </button>
      {topicCounts.map(([topic, count]) => (
        <button
          key={topic}
          onClick={() => onSelect(selectedTopic === topic ? null : topic)}
          className={`w-full text-left px-3 py-1.5 text-xs transition-colors truncate ${
            selectedTopic === topic
              ? 't-text-accent font-medium bg-[var(--color-accent-soft)]/10'
              : 't-text-secondary hover:t-bg-hover'
          }`}
          title={topic}
        >
          {topic} ({count})
        </button>
      ))}
    </div>
  )
}

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
  onPreview
}: {
  paper: EntityItem
  expanded: boolean
  onToggle: () => void
  onPreview: () => void
}) {
  const authors = (paper.authors as string[]) || []
  const authorStr =
    authors.length <= 3
      ? authors.join(', ')
      : `${authors.slice(0, 2).join(', ')} et al.`
  const keyFindings = (paper.keyFindings as string[]) || []

  return (
    <div className="border-b t-border last:border-b-0">
      <div
        className="flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-accent-soft)]/5 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <button className="shrink-0 t-text-muted">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* Title + authors */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] t-text font-medium truncate leading-tight">
            {paper.title}
          </p>
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

        {/* Citations */}
        <span className="shrink-0 text-[11px] t-text-muted tabular-nums w-12 text-right">
          {(paper.citationCount as number) != null ? paper.citationCount : '—'}
        </span>

        {/* Preview button */}
        <button
          onClick={(e) => { e.stopPropagation(); onPreview() }}
          className="shrink-0 p-1 rounded t-text-muted hover:t-text-accent-soft transition-colors"
          title="Open detail"
        >
          <BookOpen size={14} />
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
            {paper.externalSource && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                {paper.externalSource as string}
              </span>
            )}
            {paper.addedInRound && (
              <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
                {paper.addedInRound as string}
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
      {/* Simple progress bar */}
      <div className="flex-1 max-w-48">
        <div className="h-1.5 rounded-full t-bg-elevated overflow-hidden">
          <div
            className="h-full rounded-full t-gradient-accent-h"
            style={{
              width: `${Math.min(100, (highRelevance / Math.max(papers.length, 1)) * 100)}%`,
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar() {
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
            placeholder="Search papers by title, author, abstract..."
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
          Filters
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

export function LiteratureView() {
  const papers = useEntityStore((s) => s.papers)
  const filter = useUIStore((s) => s.literatureFilter)
  const setFilter = useUIStore((s) => s.setLiteratureFilter)
  const openPreview = useUIStore((s) => s.openPreview)
  const [expandedId, setExpandedId] = useState<string | null>(null)

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

  // Filter + sort papers
  const filtered = useMemo(() => {
    let result = [...papers]

    // Text search
    if (filter.search.trim()) {
      const q = filter.search.toLowerCase()
      result = result.filter((p) => {
        const title = (p.title || '').toLowerCase()
        const abstract = ((p.abstract as string) || '').toLowerCase()
        const authors = ((p.authors as string[]) || []).join(' ').toLowerCase()
        return title.includes(q) || abstract.includes(q) || authors.includes(q)
      })
    }

    // Sub-topic filter
    if (filter.subTopic) {
      result = result.filter(
        (p) => ((p.subTopic as string) || 'Uncategorized') === filter.subTopic
      )
    }

    // Min score
    if (filter.minScore > 0) {
      result = result.filter((p) => ((p.relevanceScore as number) || 0) >= filter.minScore)
    }

    // Source
    if (filter.source) {
      result = result.filter((p) => (p.externalSource as string) === filter.source)
    }

    // Round
    if (filter.round) {
      result = result.filter((p) => (p.addedInRound as string) === filter.round)
    }

    // Sort
    result.sort((a, b) => {
      const dir = filter.sortDir === 'desc' ? -1 : 1
      switch (filter.sortBy) {
        case 'year': {
          const ay = (a.year as number) || 0
          const by = (b.year as number) || 0
          return (ay - by) * dir
        }
        case 'relevance': {
          const as2 = (a.relevanceScore as number) || 0
          const bs = (b.relevanceScore as number) || 0
          return (as2 - bs) * dir
        }
        case 'citations': {
          const ac = (a.citationCount as number) || 0
          const bc = (b.citationCount as number) || 0
          return (ac - bc) * dir
        }
        case 'title':
          return a.title.localeCompare(b.title) * dir
        default:
          return 0
      }
    })

    return result
  }, [papers, filter])

  const hasTopics = papers.some((p) => p.subTopic)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <FilterBar />

      <div className="flex-1 flex min-h-0">
        {/* Topic tree — only show if papers have sub-topics */}
        {hasTopics && (
          <TopicTree
            papers={papers}
            selectedTopic={filter.subTopic}
            onSelect={(topic) => setFilter({ subTopic: topic })}
          />
        )}

        {/* Paper table */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Table header */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-b t-border t-bg-surface">
            <div className="w-5" /> {/* chevron spacer */}
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
            <SortHeader
              label="Cites"
              sortKey="citations"
              currentSort={filter.sortBy}
              currentDir={filter.sortDir}
              onSort={handleSort}
              className="w-12 justify-end"
            />
            <div className="w-8" /> {/* action spacer */}
          </div>

          {/* Paper rows */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-8">
                <BookOpen size={32} className="t-text-muted mb-3 opacity-40" />
                <p className="text-sm t-text-muted">
                  {papers.length === 0
                    ? 'No papers yet. Use the chat to search for literature.'
                    : 'No papers match your filters.'}
                </p>
              </div>
            ) : (
              filtered.map((paper) => (
                <PaperRow
                  key={paper.id}
                  paper={paper}
                  expanded={expandedId === paper.id}
                  onToggle={() =>
                    setExpandedId(expandedId === paper.id ? null : paper.id)
                  }
                  onPreview={() => openPreview(paper)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <CoverageBar papers={filtered} />
    </div>
  )
}
