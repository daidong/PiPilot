import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Named CSS Highlight keys. The runtime style below references the same
// names via ::highlight(...), so keep them in sync.
const HL_MATCH = 'find-match'
const HL_ACTIVE = 'find-active'
const HIGHLIGHT_STYLE_ID = 'research-copilot-find-highlights'
const HIGHLIGHT_STYLE = `
::highlight(${HL_MATCH}) {
  background-color: rgba(224, 168, 32, 0.35);
  color: inherit;
}
::highlight(${HL_ACTIVE}) {
  background-color: rgba(224, 168, 32, 0.85);
  color: #1b1713;
}
html.dark ::highlight(${HL_MATCH}) {
  background-color: rgba(255, 213, 0, 0.30);
}
html.dark ::highlight(${HL_ACTIVE}) {
  background-color: rgba(255, 175, 0, 0.85);
  color: #141a1e;
}
`

interface CSSWithHighlights {
  highlights?: {
    set: (name: string, hl: unknown) => void
    delete: (name: string) => boolean
  }
}

// Browsers without the API (older Electron, Safari < 17.2) silently no-op.
// We feature-detect once at module load.
const HIGHLIGHT_SUPPORTED =
  typeof CSS !== 'undefined' &&
  typeof (CSS as CSSWithHighlights).highlights?.set === 'function' &&
  typeof (window as any).Highlight === 'function'

function ensureHighlightStyle(): void {
  if (!HIGHLIGHT_SUPPORTED || document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = HIGHLIGHT_STYLE
  document.head.appendChild(style)
}

export interface UseFindInScopeResult {
  query: string
  setQuery: (q: string) => void
  caseSensitive: boolean
  toggleCaseSensitive: () => void
  total: number
  current: number // 1-based index of active match; 0 when no matches
  next: () => void
  prev: () => void
  clear: () => void
  supported: boolean
}

// Skip hidden/non-content subtrees. We don't search inside <script>/<style>,
// the FindBar itself, or any element opted out via data-find-skip.
function shouldSkipElement(el: Element): boolean {
  const tag = el.tagName
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true
  if ((el as HTMLElement).dataset?.findSkip != null) return true
  return false
}

function collectTextNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return shouldSkipElement(node as Element)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP
      }
      // text node
      const t = (node as Text).data
      if (!t || !t.trim()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) out.push(n as Text)
  return out
}

function buildRanges(root: Node, query: string, caseSensitive: boolean): Range[] {
  if (!query) return []
  const nodes = collectTextNodes(root)
  const needle = caseSensitive ? query : query.toLowerCase()
  const ranges: Range[] = []
  for (const node of nodes) {
    const hay = caseSensitive ? node.data : node.data.toLowerCase()
    let from = 0
    while (from <= hay.length - needle.length) {
      const idx = hay.indexOf(needle, from)
      if (idx === -1) break
      const r = document.createRange()
      r.setStart(node, idx)
      r.setEnd(node, idx + needle.length)
      ranges.push(r)
      from = idx + needle.length
    }
  }
  return ranges
}

/**
 * Search a DOM subtree for a query and highlight matches via the CSS Custom
 * Highlight API. Live-updates when the container's contents change (new chat
 * messages, edits in markdown editor) by re-scanning on a debounced
 * MutationObserver.
 *
 * Scope is determined by the ref passed in. The hook is inert until `query`
 * is non-empty, so mounting it is cheap.
 */
export function useFindInScope(
  scopeRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): UseFindInScopeResult {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState(0)
  const rangesRef = useRef<Range[]>([])

  const clearHighlights = useCallback(() => {
    if (!HIGHLIGHT_SUPPORTED) return
    const css = CSS as CSSWithHighlights
    css.highlights!.delete(HL_MATCH)
    css.highlights!.delete(HL_ACTIVE)
  }, [])

  // Apply the current ranges + active index to the browser highlight registry.
  const applyHighlights = useCallback((ranges: Range[], activeIdx: number) => {
    if (!HIGHLIGHT_SUPPORTED) return
    ensureHighlightStyle()
    const css = CSS as CSSWithHighlights
    if (ranges.length === 0) {
      css.highlights!.delete(HL_MATCH)
      css.highlights!.delete(HL_ACTIVE)
      return
    }
    const Highlight = (window as any).Highlight
    const others: Range[] = []
    let activeRange: Range | null = null
    for (let i = 0; i < ranges.length; i++) {
      if (i === activeIdx) activeRange = ranges[i]
      else others.push(ranges[i])
    }
    css.highlights!.set(HL_MATCH, new Highlight(...others))
    if (activeRange) css.highlights!.set(HL_ACTIVE, new Highlight(activeRange))
    else css.highlights!.delete(HL_ACTIVE)
  }, [])

  // Re-scan the scope. Preserves current index when possible (clamps to new total).
  const rescan = useCallback(() => {
    const root = scopeRef.current
    if (!root || !active || !query) {
      rangesRef.current = []
      setTotal(0)
      setCurrent(0)
      clearHighlights()
      return
    }
    const ranges = buildRanges(root, query, caseSensitive)
    rangesRef.current = ranges
    setTotal(ranges.length)
    setCurrent((prev) => {
      if (ranges.length === 0) return 0
      // Keep position if still in range; otherwise reset to 1.
      const next = Math.min(Math.max(prev, 1), ranges.length)
      return next
    })
  }, [scopeRef, active, query, caseSensitive, clearHighlights])

  // Re-apply highlights whenever ranges or current index change. Scrolls the
  // active match into view so the user actually sees what they typed.
  useEffect(() => {
    const ranges = rangesRef.current
    if (ranges.length === 0) {
      applyHighlights([], -1)
      return
    }
    const idx = current > 0 ? current - 1 : 0
    applyHighlights(ranges, idx)
    const r = ranges[idx]
    if (r) {
      // Use the start container's element to scroll. Range.getBoundingClientRect
      // is reliable, but element.scrollIntoView gives nicer behavior.
      const el = r.startContainer.parentElement
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [current, total, applyHighlights])

  // Trigger rescan on query/case/active changes.
  useEffect(() => {
    rescan()
  }, [rescan])

  // Watch the scope for content changes (new messages, edits) and rescan,
  // debounced to avoid thrashing during streaming.
  useEffect(() => {
    if (!active || !query) return
    const root = scopeRef.current
    if (!root) return
    let timer: number | null = null
    const schedule = () => {
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        rescan()
      }, 120)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      observer.disconnect()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [scopeRef, active, query, rescan])

  // Cleanup highlights on unmount or when the bar is closed.
  useEffect(() => {
    if (!active) clearHighlights()
    return () => clearHighlights()
  }, [active, clearHighlights])

  const next = useCallback(() => {
    setCurrent((prev) => {
      const t = rangesRef.current.length
      if (t === 0) return 0
      return prev >= t ? 1 : prev + 1
    })
  }, [])

  const prev = useCallback(() => {
    setCurrent((p) => {
      const t = rangesRef.current.length
      if (t === 0) return 0
      return p <= 1 ? t : p - 1
    })
  }, [])

  const clear = useCallback(() => {
    setQuery('')
    setTotal(0)
    setCurrent(0)
    rangesRef.current = []
    clearHighlights()
  }, [clearHighlights])

  const toggleCaseSensitive = useCallback(() => setCaseSensitive((v) => !v), [])

  return useMemo(
    () => ({
      query,
      setQuery,
      caseSensitive,
      toggleCaseSensitive,
      total,
      current,
      next,
      prev,
      clear,
      supported: HIGHLIGHT_SUPPORTED,
    }),
    [query, caseSensitive, toggleCaseSensitive, total, current, next, prev, clear],
  )
}
