import React, { useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive } from 'lucide-react'
import type { UseFindInScopeResult } from '../../hooks/use-find-in-scope'

interface FindBarProps {
  open: boolean
  onClose: () => void
  find: UseFindInScopeResult
  // Tailwind classes for the outermost wrapper. Lets the caller decide
  // positioning (absolute in a relative container, sticky inside a scroll
  // viewport, etc). Defaults to top-right absolute positioning.
  className?: string
}

/**
 * Compact find/search bar that overlays a scope (chat or preview). Stateless
 * about *what* it searches — that's `find` (from useFindInScope). This
 * component only renders the input + counter + nav controls.
 *
 * Keyboard inside the input:
 *   Enter        — next match
 *   Shift+Enter  — previous match
 *   Esc          — close (calls onClose)
 *   Alt+C        — toggle case sensitivity
 *
 * The bar is opt-in: render it conditionally on `open`. When unmounted the
 * hook clears its highlights automatically.
 */
export function FindBar({
  open,
  onClose,
  find,
  className = 'absolute top-2 right-3 z-20',
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus + select on open. Selecting lets the user re-type immediately
  // without manually clearing the previous query.
  useEffect(() => {
    if (open) {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }
  }, [open])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) find.prev()
      else find.next()
      return
    }
    if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      find.toggleCaseSensitive()
    }
  }

  const counter = find.query
    ? find.total === 0
      ? 'No results'
      : `${find.current}/${find.total}`
    : ''

  return (
    <div
      data-find-skip
      className={`${className} flex items-center gap-1 px-2 py-1 rounded-md t-bg-elevated border t-border shadow-md backdrop-blur`}
      role="search"
      aria-label="Find in panel"
    >
      <input
        ref={inputRef}
        type="text"
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        spellCheck={false}
        className="bg-transparent outline-none text-xs t-text w-32 placeholder:t-text-muted"
        aria-label="Find query"
      />
      <span
        className="text-[10px] tabular-nums t-text-muted min-w-[3.5rem] text-right select-none"
        aria-live="polite"
      >
        {counter}
      </span>
      <button
        onClick={find.toggleCaseSensitive}
        title="Match case (Alt+C)"
        aria-pressed={find.caseSensitive}
        className={`p-1 rounded transition-colors ${
          find.caseSensitive ? 't-text-accent' : 't-text-muted hover:t-text'
        }`}
      >
        <CaseSensitive size={13} />
      </button>
      <button
        onClick={find.prev}
        disabled={find.total === 0}
        title="Previous (Shift+Enter)"
        className="p-1 rounded t-text-muted hover:t-text disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronUp size={13} />
      </button>
      <button
        onClick={find.next}
        disabled={find.total === 0}
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
  )
}
