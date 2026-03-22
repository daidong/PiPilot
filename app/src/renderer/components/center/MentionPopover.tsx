import React, { useEffect, useState, useMemo } from 'react'
import { StickyNote, BookOpen, Database, FileText, AtSign } from 'lucide-react'

const api = (window as any).api

interface MentionCandidate {
  type: string
  id?: string
  value: string
  label: string
  detail?: string
}

interface Props {
  query: string
  onSelect: (value: string) => void
  onClose: () => void
}

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={13} className="t-text-warning" />,
  paper: <BookOpen size={13} className="t-text-info" />,
  data: <Database size={13} className="t-text-success" />,
  file: <FileText size={13} className="t-text-secondary" />
}

const typeLabels: Record<string, string> = {
  note: 'Notes',
  paper: 'Papers',
  data: 'Data',
  file: 'Files'
}

const typeOrder = ['note', 'paper', 'data', 'file']

/** Wrap value in quotes if it contains spaces so the parser handles it correctly */
function formatMention(c: MentionCandidate): string {
  const needsQuotes = c.value.includes(' ')
  return needsQuotes ? `@${c.type}:"${c.value}"` : `@${c.type}:${c.value}`
}

export function MentionPopover({ query, onSelect, onClose }: Props) {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loading, setLoading] = useState(true)

  // Group candidates by type
  const grouped = useMemo(() => {
    const groups: Record<string, MentionCandidate[]> = {}
    for (const c of candidates) {
      if (!groups[c.type]) groups[c.type] = []
      groups[c.type].push(c)
    }
    // Return in defined order
    return typeOrder
      .filter((t) => groups[t]?.length > 0)
      .map((t) => ({ type: t, items: groups[t] }))
  }, [candidates])

  // Flat list for keyboard navigation
  const flatList = useMemo(() => {
    return grouped.flatMap((g) => g.items)
  }, [grouped])

  useEffect(() => {
    let stale = false
    setLoading(true)
    console.log(`[MentionPopover] fetching candidates for query="${query}"`)
    api.getCandidates(query).then((result: MentionCandidate[]) => {
      if (stale) return
      console.log(`[MentionPopover] got ${result?.length ?? 0} candidates for query="${query}"`)
      setCandidates(result || [])
      setSelectedIdx(0)
      setLoading(false)
    }).catch((err: any) => {
      if (stale) return
      console.error('[MentionPopover] getCandidates error:', err)
      setCandidates([])
      setLoading(false)
    })
    return () => { stale = true }
  }, [query])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIdx((s) => Math.min(s + 1, flatList.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIdx((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (flatList[selectedIdx]) {
          e.preventDefault()
          e.stopPropagation()
          const c = flatList[selectedIdx]
          onSelect(formatMention(c))
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [flatList, selectedIdx, onSelect, onClose])

  // Track flat index for rendering
  let flatIndex = -1

  return (
    <div
      className="absolute z-50 w-96 max-h-64 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl"
      style={{ bottom: '100%', left: 48, marginBottom: 8 }}
    >
      <div className="px-3 py-1.5 border-b t-border flex items-center gap-2 text-xs t-text-secondary">
        <AtSign size={11} />
        <span>Mention{query ? `: "${query}"` : ''}</span>
      </div>

      {loading ? (
        <div className="px-3 py-3 text-xs t-text-muted">Loading...</div>
      ) : flatList.length === 0 ? (
        <div className="px-3 py-3 text-xs t-text-muted">
          {query
            ? `No matches for "${query}"`
            : 'Type to search notes, papers, data, or files'}
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.type}>
            {/* Category header */}
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider t-text-muted t-bg-base sticky top-0 flex items-center gap-1.5">
              {typeIcons[group.type]}
              {typeLabels[group.type] || group.type}
              <span className="font-normal">({group.items.length})</span>
            </div>
            {/* Items in category */}
            {group.items.map((c) => {
              flatIndex++
              const idx = flatIndex
              return (
                <button
                  key={`${c.type}-${c.value}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(formatMention(c))
                  }}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  className={`flex items-center gap-1.5 w-full px-3 py-1 text-xs text-left transition-colors ${
                    idx === selectedIdx ? 't-bg-elevated t-text' : 't-text-secondary t-bg-hover'
                  }`}
                >
                  <span className="truncate flex-1">{c.label}</span>
                  {c.detail && (
                    <span className="text-[10px] t-text-muted truncate max-w-[100px]">{c.detail}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))
      )}
    </div>
  )
}
