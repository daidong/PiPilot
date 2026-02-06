import React, { useEffect, useState, useRef } from 'react'
import { Target, Pencil, Check } from 'lucide-react'
import { ProgressSteps } from '../right/ProgressSteps'

interface TaskAnchorView {
  currentGoal: string
  nowDoing: string
  blockedBy: string[]
  nextAction: string
  updatedAt: string
}

function InlineEditField({
  label,
  value,
  onSave
}: {
  label: string
  value: string
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  const handleSave = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    setEditing(false)
  }

  return (
    <div className="flex items-start gap-1.5 py-1">
      <span className="text-[10px] t-text-muted shrink-0 w-14 pt-0.5">{label}</span>
      {editing ? (
        <div className="flex-1 flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
            className="flex-1 text-xs t-text bg-transparent border-b border-teal-400 outline-none"
          />
          <button onClick={handleSave} className="p-0.5 text-teal-400">
            <Check size={11} />
          </button>
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-1 group cursor-pointer" onClick={() => setEditing(true)}>
          <span className="text-xs t-text flex-1">{value || '-'}</span>
          <Pencil size={9} className="t-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}
    </div>
  )
}

function BlockedByField({
  items,
  onSave
}: {
  items: string[]
  onSave: (items: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(items.join('; '))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(items.join('; '))
  }, [items])

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  const handleSave = () => {
    const parsed = draft.split(';').map(s => s.trim()).filter(Boolean)
    onSave(parsed)
    setEditing(false)
  }

  return (
    <div className="flex items-start gap-1.5 py-1">
      <span className="text-[10px] t-text-muted shrink-0 w-14 pt-0.5">Blocked</span>
      {editing ? (
        <div className="flex-1 flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
            className="flex-1 text-xs t-text bg-transparent border-b border-teal-400 outline-none"
            placeholder="Separate with semicolons"
          />
          <button onClick={handleSave} className="p-0.5 text-teal-400">
            <Check size={11} />
          </button>
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-1 group cursor-pointer" onClick={() => setEditing(true)}>
          <span className="text-xs t-text flex-1">
            {items.length > 0 ? items.join('; ') : '-'}
          </span>
          <Pencil size={9} className="t-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}
    </div>
  )
}

export function TasksPanel() {
  const [anchor, setAnchor] = useState<TaskAnchorView | null>(null)

  const loadAnchor = async () => {
    const api = (window as any).api
    const result = await api.taskAnchorGet()
    setAnchor(result?.anchor || null)
  }

  useEffect(() => {
    loadAnchor()
  }, [])

  const handleUpdate = async (patch: Partial<TaskAnchorView>) => {
    const api = (window as any).api
    await api.taskAnchorUpdate(patch)
    await loadAnchor()
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b t-border">
        <Target size={13} className="text-orange-400" />
        <span className="text-xs font-semibold t-text">Tasks</span>
      </div>

      <div className="px-2 py-2 overflow-y-auto min-h-0 flex-1 space-y-3">
        {/* Task Anchor */}
        <div>
          <h4 className="text-[10px] t-text-muted uppercase tracking-wider mb-1 px-1">Task Anchor</h4>
          {!anchor ? (
            <p className="text-xs t-text-muted px-1">No task anchor set yet</p>
          ) : (
            <div className="rounded-lg border t-border t-bg-surface px-2 py-1">
              <InlineEditField
                label="Goal"
                value={anchor.currentGoal}
                onSave={(v) => handleUpdate({ currentGoal: v })}
              />
              <InlineEditField
                label="Doing"
                value={anchor.nowDoing}
                onSave={(v) => handleUpdate({ nowDoing: v })}
              />
              <BlockedByField
                items={anchor.blockedBy}
                onSave={(v) => handleUpdate({ blockedBy: v })}
              />
              <InlineEditField
                label="Next"
                value={anchor.nextAction}
                onSave={(v) => handleUpdate({ nextAction: v })}
              />
              {anchor.updatedAt && (
                <p className="text-[9px] t-text-muted mt-1 text-right">
                  Updated: {new Date(anchor.updatedAt).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Progress Steps */}
        <div>
          <ProgressSteps />
        </div>
      </div>
    </div>
  )
}
