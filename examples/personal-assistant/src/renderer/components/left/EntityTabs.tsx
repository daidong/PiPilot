import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  StickyNote,
  FileText,
  CheckSquare,
  Mail,
  Calendar,
  Layers,
  Upload,
  Circle,
  CheckCircle2,
  Trash2,
  Link2
} from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useChatStore } from '../../stores/chat-store'

const tabs = [
  { key: 'todos' as const, label: 'Todos', icon: CheckSquare },
  { key: 'notes' as const, label: 'Notes', icon: StickyNote },
  { key: 'docs' as const, label: 'Docs', icon: FileText },
  { key: 'mail' as const, label: 'Mail', icon: Mail },
  { key: 'calendar' as const, label: 'Calendar', icon: Calendar },
  { key: 'focus' as const, label: 'Focus', icon: Layers }
]

function EntityRow({ entity, inFocus }: { entity: EntityItem; inFocus: boolean }) {
  const openPreview = useUIStore((s) => s.openPreview)
  const toggleFocus = useEntityStore((s) => s.toggleFocus)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const requestScrollTo = useChatStore((s) => s.requestScrollTo)

  const subtitle = entity.type === 'mail'
    ? [entity.from, entity.subject].filter(Boolean).join(' | ')
    : entity.type === 'calendar'
      ? [entity.calendarName, entity.startAt].filter(Boolean).join(' | ')
      : entity.type === 'doc'
        ? (entity.description || entity.filePath)
        : undefined

  return (
    <div className="group rounded-md hover:t-bg-hover">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          className={`w-2 h-2 rounded-full shrink-0 ${inFocus ? 'bg-teal-400' : 't-bg-elevated'}`}
          title={inFocus ? 'Remove from focus' : 'Add to focus'}
          onClick={() => toggleFocus(entity.id)}
        />
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => openPreview(entity)}
        >
          <span className="text-xs t-text truncate block">{entity.title}</span>
          {subtitle && <span className="text-[10px] t-text-muted truncate block">{subtitle}</span>}
        </button>
        <button
          className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:t-bg-hover"
          title="Focus"
          onClick={() => toggleFocus(entity.id)}
        >
          <Link2 size={12} />
        </button>
        <button
          className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
          title="Delete"
          onClick={() => deleteEntity(entity.id)}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {entity.provenance?.messageId && (
        <button
          onClick={() => requestScrollTo(entity.provenance?.messageId)}
          className="ml-4 pl-2 py-0.5 text-[10px] t-text-muted hover:text-blue-400 transition-colors border-l t-border"
          title="Scroll to source message"
        >
          from chat
        </button>
      )}
    </div>
  )
}

function TodoRow({ todo, inFocus }: { todo: EntityItem; inFocus: boolean }) {
  const toggleTodoComplete = useEntityStore((s) => s.toggleTodoComplete)
  const openPreview = useUIStore((s) => s.openPreview)
  const toggleFocus = useEntityStore((s) => s.toggleFocus)

  const completed = todo.status === 'completed'

  return (
    <div className="rounded-md hover:t-bg-hover flex items-center gap-1.5 px-2 py-1">
      <button
        onClick={() => toggleTodoComplete(todo.id)}
        className="shrink-0"
        title={completed ? 'Mark as pending' : 'Mark as completed'}
      >
        {completed ? <CheckCircle2 size={13} className="text-green-500" /> : <Circle size={13} className="t-text-muted" />}
      </button>
      <button
        className={`min-w-0 flex-1 text-left ${completed ? 'line-through opacity-60' : ''}`}
        onClick={() => openPreview(todo)}
      >
        <span className="text-xs t-text truncate block">{todo.title}</span>
      </button>
      <button
        className={`w-2 h-2 rounded-full shrink-0 ${inFocus ? 'bg-teal-400' : 't-bg-elevated'}`}
        title={inFocus ? 'Remove from focus' : 'Add to focus'}
        onClick={() => toggleFocus(todo.id)}
      />
    </div>
  )
}

export function EntityTabs() {
  const leftTab = useUIStore((s) => s.leftTab)
  const setLeftTab = useUIStore((s) => s.setLeftTab)
  const { notes, docs, todos, mail, calendar, focus, refreshAll } = useEntityStore()
  const [showCompleted, setShowCompleted] = useState(true)

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const focusIds = useMemo(() => new Set(focus.map(item => item.id)), [focus])

  const filteredTodos = useMemo(() => {
    if (showCompleted) return todos
    return todos.filter((t) => t.status !== 'completed')
  }, [todos, showCompleted])

  const items: EntityItem[] = (() => {
    switch (leftTab) {
      case 'todos': return filteredTodos
      case 'notes': return notes
      case 'docs': return docs
      case 'mail': return mail
      case 'calendar': return calendar
      case 'focus': return focus
      default: return []
    }
  })()

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const api = (window as any).api
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize)
          binary += String.fromCharCode(...chunk)
        }
        const base64 = btoa(binary)
        await api.dropFile(file.name, base64, leftTab)
      } catch (err) {
        console.error(`Failed to drop file ${file.name}:`, err)
      }
    }
    refreshAll()
  }, [leftTab, refreshAll])

  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-1 px-2 pb-2 border-b t-border overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = leftTab === tab.key
          return (
            <button
              key={tab.key}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-md text-xs whitespace-nowrap ${active ? 't-bg-surface t-text' : 't-text-muted hover:t-bg-hover'}`}
              onClick={() => setLeftTab(tab.key)}
            >
              <Icon size={12} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {leftTab === 'todos' && todos.some(t => t.status === 'completed') && (
        <div className="px-3 py-2 border-b t-border">
          <label className="inline-flex items-center gap-1.5 text-[11px] t-text-muted">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
            />
            Show completed
          </label>
        </div>
      )}

      {(leftTab === 'notes' || leftTab === 'docs') && (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="mx-2 mt-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-blue-400/40"
        >
          <Upload size={16} className="mx-auto mb-1 t-text-muted" />
          <p className="text-xs t-text-muted">Drop files here</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {items.length === 0 ? (
          <p className="text-xs t-text-muted px-2 py-4 text-center">
            {leftTab === 'todos' ? 'No todos yet' : `No ${leftTab} items`}
          </p>
        ) : leftTab === 'todos' ? (
          items.map(todo => (
            <TodoRow key={todo.id} todo={todo} inFocus={focusIds.has(todo.id)} />
          ))
        ) : (
          items.map(entity => (
            <EntityRow key={entity.id} entity={entity} inFocus={focusIds.has(entity.id)} />
          ))
        )}
      </div>
    </div>
  )
}
