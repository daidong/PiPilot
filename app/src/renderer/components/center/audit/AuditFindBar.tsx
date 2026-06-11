import { useEffect, useRef, type KeyboardEvent } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { AuditSearchMatch } from './audit-search'

interface AuditFindBarProps {
  open: boolean
  query: string
  onQueryChange: (query: string) => void
  caseSensitive: boolean
  onToggleCaseSensitive: () => void
  matches: AuditSearchMatch[]
  activeIndex: number
  onSelectIndex: (index: number) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function AuditFindBar({
  open,
  query,
  onQueryChange,
  caseSensitive,
  onToggleCaseSensitive,
  matches,
  activeIndex,
  onSelectIndex,
  onNext,
  onPrev,
  onClose,
}: AuditFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const el = inputRef.current
    el?.focus()
    el?.select()
  }, [open])

  if (!open) return null

  const active = matches[activeIndex] ?? null
  const counter = query.trim()
    ? matches.length === 0
      ? 'No results'
      : `${activeIndex + 1}/${matches.length}`
    : ''

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrev()
      else onNext()
      return
    }
    if (event.altKey && (event.key === 'c' || event.key === 'C')) {
      event.preventDefault()
      onToggleCaseSensitive()
    }
  }

  return (
    <div
      data-find-skip
      className="absolute top-3 right-12 z-30 w-[min(520px,calc(100%-96px))] rounded-md border t-border-subtle t-bg-surface/95 backdrop-blur shadow-sm"
      role="search"
      aria-label="Search provenance input and output"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b t-border-subtle">
        <Search size={13} className="t-text-muted flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search provenance input/output"
          spellCheck={false}
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px] t-text placeholder:t-text-muted"
        />
        <span className="text-[10px] tabular-nums t-text-muted min-w-[4.5rem] text-right select-none">
          {counter}
        </span>
        <button
          onClick={onToggleCaseSensitive}
          title="Match case (Alt+C)"
          aria-pressed={caseSensitive}
          className={`p-1 rounded transition-colors ${
            caseSensitive ? 't-text-accent' : 't-text-muted hover:t-text'
          }`}
        >
          <CaseSensitive size={13} />
        </button>
        <button
          onClick={onPrev}
          disabled={matches.length === 0}
          title="Previous (Shift+Enter)"
          className="p-1 rounded t-text-muted hover:t-text disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronUp size={13} />
        </button>
        <button
          onClick={onNext}
          disabled={matches.length === 0}
          title="Next (Enter)"
          className="p-1 rounded t-text-muted hover:t-text disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronDown size={13} />
        </button>
        <button
          onClick={onClose}
          title="Close (Esc)"
          className="p-1 rounded t-text-muted hover:t-text"
        >
          <X size={13} />
        </button>
      </div>

      {query.trim() && matches.length > 0 && (
        <div className="max-h-56 overflow-y-auto p-1.5 space-y-1">
          {matches.slice(0, 80).map((match, index) => (
            <button
              key={match.id}
              onClick={() => onSelectIndex(index)}
              className={`w-full text-left rounded px-2 py-1.5 transition-colors ${
                index === activeIndex ? 't-bg-accent-2-muted t-text' : 't-text-secondary hover:t-bg-hover'
              }`}
              title={match.nodeId}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[9px] uppercase tracking-wider t-text-muted font-semibold">{match.nodeKind}</span>
                <span className="text-[10px] t-text-accent font-mono truncate">{match.field}</span>
                <span className="text-[11px] t-text truncate">{match.nodeLabel}</span>
              </div>
              <div className="text-[10.5px] leading-snug mt-0.5 line-clamp-2 break-words">
                <HighlightedExcerpt match={match} />
              </div>
            </button>
          ))}
          {matches.length > 80 && (
            <div className="px-2 py-1 text-[10px] t-text-muted">
              Showing first 80 of {matches.length} matches. Use Enter to keep cycling.
            </div>
          )}
        </div>
      )}

      {query.trim() && matches.length === 0 && (
        <div className="px-3 py-2 text-[11px] t-text-muted">No input/output text matches.</div>
      )}

      {active && (
        <div className="px-3 py-1.5 border-t t-border-subtle text-[10px] t-text-muted truncate">
          Active: {active.nodeLabel} · {active.eventName ?? active.field}
        </div>
      )}
    </div>
  )
}

function HighlightedExcerpt({ match }: { match: AuditSearchMatch }) {
  const before = match.excerpt.slice(0, match.matchStart)
  const hit = match.excerpt.slice(match.matchStart, match.matchEnd)
  const after = match.excerpt.slice(match.matchEnd)
  return (
    <>
      {before}
      <mark className="rounded px-0.5 bg-amber-300/70 text-zinc-950">{hit}</mark>
      {after}
    </>
  )
}
