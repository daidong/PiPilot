import React, { useEffect, useMemo, useState } from 'react'
import { Terminal } from 'lucide-react'

interface SlashCommand {
  name: string
  description: string
  args?: string
}

interface Props {
  query: string
  commands: SlashCommand[]
  onSelect: (command: string) => void
  onClose: () => void
}

export function CommandPopover({ query, commands, onSelect, onClose }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0)

  const filtered = useMemo(() => {
    if (!query) return commands
    const q = query.toLowerCase()
    return commands.filter((c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    )
  }, [query, commands])

  useEffect(() => {
    setSelectedIdx(0)
  }, [filtered.length])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIdx((s) => Math.min(s + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIdx((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[selectedIdx]) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(filtered[selectedIdx].name)
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [filtered, selectedIdx, onSelect, onClose])

  if (filtered.length === 0) {
    return (
      <div
        className="absolute z-50 w-72 rounded-xl border t-border t-bg-surface shadow-xl"
        style={{ bottom: '100%', left: 48, marginBottom: 8 }}
      >
        <div className="px-3 py-3 text-xs t-text-muted">
          No matching commands for "/{query}"
        </div>
      </div>
    )
  }

  return (
    <div
      className="absolute z-50 w-80 max-h-64 overflow-y-auto rounded-xl border t-border t-bg-surface shadow-xl"
      style={{ bottom: '100%', left: 48, marginBottom: 8 }}
    >
      <div className="px-3 py-2 border-b t-border flex items-center gap-2 text-xs t-text-secondary">
        <Terminal size={12} />
        <span>Commands</span>
      </div>

      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(cmd.name)
          }}
          className={`flex items-start gap-2 w-full px-3 py-2 text-left transition-colors ${
            i === selectedIdx ? 't-bg-elevated' : 't-bg-hover'
          }`}
        >
          <code className="text-sm text-teal-500 shrink-0">{cmd.name}</code>
          <div className="flex-1 min-w-0">
            <p className="text-xs t-text-secondary truncate">{cmd.description}</p>
            {cmd.args && (
              <p className="text-xs t-text-muted truncate">{cmd.args}</p>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}
