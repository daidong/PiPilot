import React, { useEffect, useState, useMemo } from 'react'
import { StickyNote, FileText, AtSign } from 'lucide-react'

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
  doc: <FileText size={13} className="t-text-accent" />,
  file: <FileText size={13} className="t-text-secondary" />
}

const typeLabels: Record<string, string> = {
  note: 'Notes',
  doc: 'Docs',
  file: 'Files'
}

const typeOrder = ['note', 'doc', 'file']

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
    return typeOrder
      .filter((t) => groups[t]?.length > 0)
      .map((t) => ({ type: t, items: groups[t] }))
  }, [candidates])

  // Flat list for keyboard navigation
  const flatList = useMemo(() => {
    return grouped.flatMap((g) => g.items)
  }, [grouped])

  useEffect(() => {
    setLoading(true)
    api.getCandidates(query).then((result: MentionCandidate[]) => {
      setCandidates(result || [])
      setSelectedIdx(0)
      setLoading(false)
    }).catch(() => {
      setCandidates([])
      setLoading(false)
    })
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
          onSelect(`@${c.type}:${c.value}`)
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
      className="absolute z-50 w-72 max-h-64 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl"
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
            : 'Type to search notes, docs, or files'}
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.type}>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider t-text-muted t-bg-base sticky top-0 flex items-center gap-1.5">
              {typeIcons[group.type]}
              {typeLabels[group.type] || group.type}
              <span className="font-normal">({group.items.length})</span>
            </div>
            {group.items.map((c) => {
              flatIndex++
              const idx = flatIndex
              return (
                <button
                  key={`${c.type}-${c.value}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(`@${c.type}:${c.value}`)
                  }}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  className={`flex items-center gap-1.5 w-full px-3 py-1 text-xs text-left transition-colors ${
                    idx === selectedIdx ? 't-bg-elevated t-text' : 't-text-secondary t-bg-hover'
                  }`}
                >
                  <span className="truncate flex-1">{c.label}</span>
                  {c.detail && (
                    <span className="text-[10px] t-text-muted truncate max-w-[60px]">{c.detail}</span>
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
