import { useState, useMemo, useEffect } from 'react'
import type { PaperRecord, ReviewRecord } from '@/lib/types'

interface PapersTabProps {
  papers: PaperRecord[]
  reviews: ReviewRecord[]
  onRefresh: () => Promise<void>
  onReadReview: (reviewId: string) => Promise<string>
}

const PAGE_SIZE = 50

function relevanceBadge(score?: number) {
  if (score == null) return 't-bg-elevated t-border'
  if (score >= 8) return 'bg-emerald-500/20 border-emerald-500/30'
  if (score >= 6) return 'bg-amber-500/20 border-amber-500/30'
  return 't-bg-elevated t-border'
}

function truncateAuthors(authors: string[], max = 3): string {
  if (authors.length === 0) return 'Unknown authors'
  if (authors.length <= max) return authors.join(', ')
  return `${authors.slice(0, max).join(', ')} +${authors.length - max}`
}

export function PapersTab({ papers, reviews, onRefresh, onReadReview }: PapersTabProps) {
  // Paper list state
  const [searchQuery, setSearchQuery] = useState('')
  const [sortByRelevance, setSortByRelevance] = useState(true)
  const [activeSourceFilters, setActiveSourceFilters] = useState<Set<string>>(new Set())
  const [expandedPaperId, setExpandedPaperId] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Review state
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null)
  const [reviewContent, setReviewContent] = useState<string>('')
  const [reviewLoading, setReviewLoading] = useState(false)

  // Reset visible count when filters change
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [activeSourceFilters, searchQuery, sortByRelevance])

  // Source counts for filter pills
  const sourceCounts = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const p of papers) {
      const src = p.externalSource || 'unknown'
      grouped.set(src, (grouped.get(src) ?? 0) + 1)
    }
    return Array.from(grouped.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [papers])

  // Filtered + sorted papers
  const filteredPapers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let result = papers

    if (activeSourceFilters.size > 0) {
      result = result.filter((p) => activeSourceFilters.has(p.externalSource || 'unknown'))
    }

    if (q) {
      result = result.filter((p) => {
        const searchable = [p.title, p.abstract, ...p.authors, p.venue ?? '', p.citeKey, ...(p.tags || [])].join(' ').toLowerCase()
        return searchable.includes(q)
      })
    }

    const sorted = [...result].sort((a, b) => {
      if (sortByRelevance) {
        const scoreA = a.relevanceScore ?? 0
        const scoreB = b.relevanceScore ?? 0
        if (scoreB !== scoreA) return scoreB - scoreA
      }
      return (b.updatedAt || '').localeCompare(a.updatedAt || '')
    })

    return sorted
  }, [papers, activeSourceFilters, searchQuery, sortByRelevance])

  const visiblePapers = filteredPapers.slice(0, visibleCount)
  const remaining = filteredPapers.length - visibleCount
  const isFiltered = activeSourceFilters.size > 0 || searchQuery.trim() !== ''

  function toggleSourceFilter(source: string) {
    setActiveSourceFilters((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

  function clearFilters() {
    setActiveSourceFilters(new Set())
    setSearchQuery('')
  }

  async function handleExpandReview(reviewId: string) {
    if (expandedReviewId === reviewId) {
      setExpandedReviewId(null)
      setReviewContent('')
      return
    }
    setExpandedReviewId(reviewId)
    setReviewLoading(true)
    try {
      const content = await onReadReview(reviewId)
      setReviewContent(content)
    } catch {
      setReviewContent('Failed to load review content.')
    } finally {
      setReviewLoading(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium">Paper Library ({papers.length})</div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSortByRelevance((v) => !v)}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
              title={sortByRelevance ? 'Sorted by relevance' : 'Sorted by date'}
            >
              {sortByRelevance ? '★ Relevance' : '↓ Date'}
            </button>
            <button
              onClick={onRefresh}
              className="rounded-md border t-border px-2 py-1 text-[11px] t-hoverable"
            >
              Refresh
            </button>
          </div>
        </div>
        <div className="mt-1 text-[11px] t-text-muted">
          Papers discovered through literature search across all sessions.
        </div>

        {/* Search */}
        <div className="mt-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by title, author, abstract…"
            className="w-full rounded-lg border t-border t-bg-primary px-2.5 py-1.5 text-[11px] placeholder:t-text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          />
        </div>

        {/* Source filter pills */}
        {sourceCounts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {sourceCounts.map(([source, count]) => {
              const active = activeSourceFilters.has(source)
              return (
                <button
                  key={source}
                  onClick={() => toggleSourceFilter(source)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    active
                      ? 'border-teal-500/60 bg-teal-500/10 t-accent-teal font-medium'
                      : 't-border t-hoverable'
                  }`}
                >
                  {source} · {count}
                </button>
              )
            })}
          </div>
        )}

        {/* Filter status */}
        {isFiltered && (
          <div className="mt-2 flex items-center justify-between text-[11px] t-text-muted">
            <span>Showing {filteredPapers.length} of {papers.length}</span>
            <button onClick={clearFilters} className="t-hoverable underline">
              Clear filters
            </button>
          </div>
        )}
      </div>

      {/* Paper list */}
      {filteredPapers.length === 0 ? (
        <div className="rounded-xl t-bg-elevated p-4 text-sm t-text-secondary">
          {papers.length === 0 ? 'No papers found yet. Papers will appear here after literature search runs.' : 'No papers match your filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visiblePapers.map((paper) => {
            const isExpanded = expandedPaperId === paper.id
            return (
              <div
                key={paper.id}
                className={`rounded-xl border p-3 transition-colors cursor-pointer ${
                  isExpanded ? 'border-teal-500/40 bg-teal-500/5' : 't-border hover:t-bg-elevated'
                }`}
                onClick={() => setExpandedPaperId(isExpanded ? null : paper.id)}
              >
                {/* Collapsed header */}
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium leading-snug" title={paper.title}>
                      {paper.title}
                    </div>
                    <div className="mt-0.5 text-[11px] t-text-secondary">
                      {truncateAuthors(paper.authors)}
                      {paper.year && <span> · {paper.year}</span>}
                      {paper.venue && <span> · {paper.venue}</span>}
                    </div>
                  </div>
                  {paper.relevanceScore != null && (
                    <span
                      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${relevanceBadge(paper.relevanceScore)}`}
                      title={`Relevance: ${paper.relevanceScore}/10`}
                    >
                      {paper.relevanceScore}
                    </span>
                  )}
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div
                    className="mt-3 border-t border-current/10 pt-3 space-y-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Abstract */}
                    {paper.abstract && (
                      <div>
                        <div className="text-[10px] font-medium t-text-muted mb-0.5">Abstract</div>
                        <p className="text-[11px] t-text-secondary leading-relaxed">{paper.abstract}</p>
                      </div>
                    )}

                    {/* Metadata grid */}
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
                      {paper.doi && (
                        <>
                          <span className="t-text-muted">DOI</span>
                          <a
                            href={`https://doi.org/${paper.doi}`}
                            target="_blank"
                            rel="noreferrer"
                            className="t-hoverable underline truncate"
                          >
                            {paper.doi}
                          </a>
                        </>
                      )}
                      {paper.citeKey && (
                        <>
                          <span className="t-text-muted">Cite key</span>
                          <span className="t-text-secondary">{paper.citeKey}</span>
                        </>
                      )}
                      {paper.citationCount != null && (
                        <>
                          <span className="t-text-muted">Citations</span>
                          <span className="t-text-secondary">{paper.citationCount.toLocaleString()}</span>
                        </>
                      )}
                      {paper.externalSource && (
                        <>
                          <span className="t-text-muted">Source</span>
                          <span className="t-text-secondary">{paper.externalSource}</span>
                        </>
                      )}
                    </div>

                    {/* Tags */}
                    {paper.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {paper.tags.map((tag) => (
                          <span key={tag} className="rounded-md t-bg-elevated border t-border px-1.5 py-0.5 text-[10px]">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Links */}
                    <div className="flex gap-2 text-[11px]">
                      {paper.url && (
                        <a href={paper.url} target="_blank" rel="noreferrer" className="t-hoverable underline">
                          View source
                        </a>
                      )}
                      {paper.pdfUrl && (
                        <a href={paper.pdfUrl} target="_blank" rel="noreferrer" className="t-hoverable underline">
                          PDF
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Show more */}
          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
              className="w-full rounded-xl border t-border p-2.5 text-[11px] t-text-secondary t-hoverable text-center"
            >
              Show more ({remaining} remaining)
            </button>
          )}
        </div>
      )}

      {/* Literature Reviews */}
      {reviews.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 rounded-xl t-bg-elevated p-3 text-xs">
            <div className="font-medium">Literature Reviews ({reviews.length})</div>
            <div className="mt-1 text-[11px] t-text-muted">
              Full literature review documents generated during research.
            </div>
          </div>

          <div className="space-y-2">
            {reviews.map((review) => {
              const isExpanded = expandedReviewId === review.id
              return (
                <div
                  key={review.id}
                  className={`rounded-xl border p-3 transition-colors cursor-pointer ${
                    isExpanded ? 'border-violet-500/40 bg-violet-500/5' : 't-border hover:t-bg-elevated'
                  }`}
                  onClick={() => handleExpandReview(review.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium">{review.id}</div>
                      <div className="mt-0.5 text-[11px] t-text-secondary">
                        {new Date(review.createdAt).toLocaleString()}
                        {review.paperCount > 0 && <span> · {review.paperCount} papers referenced</span>}
                      </div>
                    </div>
                    <span className="text-[11px] t-text-muted">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  </div>

                  {isExpanded && (
                    <div
                      className="mt-3 border-t border-current/10 pt-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {reviewLoading ? (
                        <div className="text-[11px] t-text-muted">Loading…</div>
                      ) : (
                        <pre className="max-h-96 overflow-auto rounded-lg t-bg-elevated p-3 text-[11px] whitespace-pre-wrap break-words leading-relaxed">
                          {reviewContent || 'Empty review.'}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
