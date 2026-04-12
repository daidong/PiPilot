import React, { useState, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, BookOpen, X, ExternalLink } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'

const api = (window as any).api
const remarkPlugins = [remarkGfm]

/**
 * Fallback view when a paper has no wiki page — shows metadata + abstract.
 */
function PaperFallback({ paper }: { paper: EntityItem }) {
  const authors = (paper.authors as string[]) || []
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold t-text leading-tight">{paper.title}</h1>
      {authors.length > 0 && (
        <p className="text-xs t-text-muted">{authors.join(', ')}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {paper.year && (
          <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
            {paper.year as number}
          </span>
        )}
        {paper.venue && (
          <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-muted">
            {paper.venue as string}
          </span>
        )}
        {paper.doi && !(paper.doi as string).startsWith('unknown:') && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-accent hover:underline"
          >
            DOI <ExternalLink size={8} />
          </a>
        )}
        {paper.relevanceScore != null && (
          <span className="px-1.5 py-0.5 text-[10px] rounded t-bg-elevated t-text-accent">
            {paper.relevanceScore as number}/10
          </span>
        )}
      </div>
      {paper.abstract && (
        <div>
          <p className="text-[10px] t-text-muted uppercase tracking-wider mb-1 font-medium">Abstract</p>
          <p className="text-xs t-text-secondary leading-relaxed">{paper.abstract as string}</p>
        </div>
      )}
      {paper.relevanceJustification && (
        <div>
          <p className="text-[10px] t-text-muted uppercase tracking-wider mb-1 font-medium">Relevance</p>
          <p className="text-xs t-text-secondary italic leading-relaxed">{paper.relevanceJustification as string}</p>
        </div>
      )}
      {(paper.keyFindings as string[] || []).length > 0 && (
        <div>
          <p className="text-[10px] t-text-muted uppercase tracking-wider mb-1 font-medium">Key Findings</p>
          <ul className="space-y-0.5">
            {(paper.keyFindings as string[]).map((f, i) => (
              <li key={i} className="text-xs t-text-secondary flex items-start gap-1.5">
                <span className="shrink-0 mt-1 w-1 h-1 rounded-full bg-[var(--color-accent-soft)]" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] t-text-muted italic pt-2">
        No wiki page available for this paper yet.
      </p>
    </div>
  )
}

/**
 * WikiReaderPanel — right-side split panel in Literature view.
 * Shows wiki page if available, or paper metadata fallback.
 */
export function WikiReaderPanel() {
  const slug = useUIStore((s) => s.wikiReaderSlug)
  const setSlug = useUIStore((s) => s.setWikiReaderSlug)
  const goBack = useUIStore((s) => s.wikiReaderBack)
  const history = useUIStore((s) => s.wikiReaderHistory)
  const papers = useEntityStore((s) => s.papers)

  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Check if this is a paper:ID pseudo-slug (no wiki page)
  const isPaperFallback = slug?.startsWith('paper:')
  const fallbackPaper = isPaperFallback
    ? papers.find((p) => p.id === slug!.replace('paper:', ''))
    : null

  useEffect(() => {
    if (!slug || isPaperFallback) { setContent(null); return }
    let cancelled = false
    setLoading(true)
    api.wikiReadPage?.(slug).then((md: string | null) => {
      if (!cancelled) { setContent(md); setLoading(false) }
    }).catch(() => {
      if (!cancelled) { setContent(null); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [slug, isPaperFallback])

  // Process markdown: convert paper markers to links, strip remaining comments, handle [[slug]]
  const processedContent = useMemo(() => {
    if (!content) return null
    return content
      // Convert <!-- paper:slug --> ... <!-- /paper:slug --> into headed sections with a title link
      .replace(/<!--\s*paper:(\S+)\s*-->([\s\S]*?)<!--\s*\/paper:\1\s*-->/g,
        (_match: string, paperSlug: string, body: string) => {
          // Extract paper title from first line: *Title*, "Title", **Title**, or In *Title*
          const firstLine = body.trim().split('\n')[0] || ''
          const titleMatch = firstLine.match(/\*{1,2}([^*]+)\*{1,2}/) || firstLine.match(/"([^"]+)"/)
          const title = titleMatch ? titleMatch[1] : paperSlug
          return `\n---\n### [${title}](#wiki:${paperSlug})\n${body.trim()}\n`
        })
      // Strip any remaining HTML comments
      .replace(/<!--[\s\S]*?-->/g, '')
      // Convert [[slug]] to clickable links
      .replace(/\[\[([^\]]+)\]\]/g,
        (_match: string, innerSlug: string) => `[${innerSlug}](#wiki:${innerSlug})`)
  }, [content])

  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const anchor = target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (href?.startsWith('#wiki:')) {
      e.preventDefault()
      setSlug(href.replace('#wiki:', ''))
    }
  }, [setSlug])

  // Empty state
  if (!slug) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <BookOpen size={28} className="t-text-muted mb-2.5 opacity-30" />
        <p className="text-xs t-text-muted">
          Select a paper or concept to view details.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b t-border t-bg-surface shrink-0">
        <button
          onClick={goBack}
          disabled={history.length === 0}
          className="p-1 rounded t-text-muted hover:t-text transition-colors disabled:opacity-30"
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="flex-1 text-[11px] t-text-muted truncate font-mono">
          {isPaperFallback ? fallbackPaper?.title || slug : slug}
        </span>
        <button
          onClick={() => setSlug(null)}
          className="p-1 rounded t-text-muted hover:t-text transition-colors"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3" onClick={handleLinkClick}>
        {loading ? (
          <p className="text-xs t-text-muted animate-pulse">Loading...</p>
        ) : isPaperFallback && fallbackPaper ? (
          <PaperFallback paper={fallbackPaper} />
        ) : processedContent ? (
          <div className="md-prose text-sm" style={{ color: 'var(--color-text)' }}>
            <ReactMarkdown remarkPlugins={remarkPlugins}>
              {processedContent}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs t-text-muted">No wiki page found for this slug.</p>
        )}
      </div>
    </div>
  )
}
