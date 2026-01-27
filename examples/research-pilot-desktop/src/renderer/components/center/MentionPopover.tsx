import React, { useEffect, useState } from 'react'
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
  note: <StickyNote size={14} className="text-yellow-500" />,
  paper: <BookOpen size={14} className="text-blue-500" />,
  data: <Database size={14} className="text-green-500" />,
  file: <FileText size={14} className="t-text-secondary" />
}

export function MentionPopover({ query, onSelect, onClose }: Props) {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [loading, setLoading] = useState(true)

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
        setSelectedIdx((s) => Math.min(s + 1, candidates.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIdx((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (candidates[selectedIdx]) {
          e.preventDefault()
          e.stopPropagation()
          const c = candidates[selectedIdx]
          onSelect(`@${c.type}:${c.value}`)
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [candidates, selectedIdx, onSelect, onClose])

  return (
    <div
      className="absolute z-50 w-72 max-h-56 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl"
      style={{ bottom: '100%', left: 48, marginBottom: 8 }}
    >
      <div className="px-3 py-2 border-b t-border flex items-center gap-2 text-xs t-text-secondary">
        <AtSign size={12} />
        <span>Mention an entity{query ? `: "${query}"` : ''}</span>
      </div>

      {loading ? (
        <div className="px-3 py-3 text-xs t-text-muted">Loading...</div>
      ) : candidates.length === 0 ? (
        <div className="px-3 py-3 text-xs t-text-muted">
          {query
            ? `No matches for "${query}". Try @note:, @paper:, @data:, or @file:`
            : 'Type to search notes, papers, data, or files'}
        </div>
      ) : (
        candidates.map((c, i) => (
          <button
            key={`${c.type}-${c.value}`}
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(`@${c.type}:${c.value}`)
            }}
            className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors ${
              i === selectedIdx ? 't-bg-elevated t-text' : 't-text-secondary t-bg-hover'
            }`}
          >
            {typeIcons[c.type] || <AtSign size={14} className="t-text-muted" />}
            <span className="truncate flex-1">{c.label}</span>
            {c.detail && (
              <span className="text-xs t-text-muted truncate max-w-[80px]">{c.detail}</span>
            )}
            <span className="text-xs t-text-muted">{c.type}</span>
          </button>
        ))
      )}
    </div>
  )
}
