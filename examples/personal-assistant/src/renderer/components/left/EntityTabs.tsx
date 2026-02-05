import React, { useEffect, useCallback, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StickyNote, FileText, Upload, MessageSquare, Trash2, Bookmark, Layers, Check, FileSpreadsheet, FileImage, Presentation, FileCode, File, CheckSquare, Eye, EyeOff } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useChatStore } from '../../stores/chat-store'

/** File type icon for doc entities based on extension */
function DocFileIcon({ filePath, className, size }: { filePath?: string; className?: string; size?: number }) {
  const ext = filePath?.split('.').pop()?.toLowerCase() || ''
  const s = size ?? 12
  const props = { size: s, className }
  switch (ext) {
    case 'pdf':
      return <FileText {...props} />
    case 'xlsx': case 'xls': case 'csv':
      return <FileSpreadsheet {...props} />
    case 'pptx': case 'ppt':
      return <Presentation {...props} />
    case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': case 'svg':
      return <FileImage {...props} />
    case 'html': case 'htm': case 'json': case 'xml': case 'md': case 'txt':
      return <FileCode {...props} />
    default:
      return <File {...props} />
  }
}

// Hover preview tooltip with project card/working set/delete actions (RFC-009)
function HoverPreview({
  entity,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onProjectCard,
  onWorkingSet,
  onDelete,
  confirmDelete,
  isInWorkingSet
}: {
  entity: EntityItem
  anchorRect: DOMRect
  onMouseEnter: () => void
  onMouseLeave: () => void
  onProjectCard: () => void
  onWorkingSet: () => void
  onDelete: () => void
  confirmDelete: boolean
  isInWorkingSet: boolean
}) {
  const content = entity.content || entity.description || ''
  const isProjectCard = entity.pinned || entity.projectCard

  const top = Math.min(anchorRect.top, window.innerHeight - 320)

  return (
    <div
      className="fixed z-50 w-80 max-h-72 overflow-y-auto rounded-lg border t-border t-bg-surface shadow-xl"
      style={{ left: 230, top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="px-3 py-2 border-b t-border flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold t-text truncate">{entity.title}</h4>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* RFC-009: Project Card toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onProjectCard() }}
            className={`p-1 rounded ${isProjectCard ? 'text-blue-400' : 't-text-muted hover:text-blue-400'}`}
            title={isProjectCard ? 'Remove from Project Cards' : 'Add to Project Cards'}
          >
            <Bookmark size={13} />
          </button>
          {/* RFC-009: Working Set toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onWorkingSet() }}
            className={`p-1 rounded ${isInWorkingSet ? 'text-blue-400' : 't-text-muted hover:text-blue-400'}`}
            title={isInWorkingSet ? 'Remove from Working Set' : 'Add to Working Set'}
          >
            <Layers size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className={`p-1 rounded transition-colors ${confirmDelete ? 'text-red-500' : 't-text-muted hover:text-red-400'}`}
            title={confirmDelete ? 'Click again to confirm' : 'Delete'}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {content && (
        <div className="px-3 py-2">
          <div className="md-prose text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content.length > 600 ? content.slice(0, 600) + '...' : content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

const tabs = [
  { key: 'todos' as const, label: 'Todos', icon: CheckSquare },
  { key: 'notes' as const, label: 'Notes', icon: StickyNote },
  { key: 'docs' as const, label: 'Docs', icon: FileText }
]

function EntityRow({ entity, workingSetIds }: { entity: EntityItem; workingSetIds: Set<string> }) {
  // RFC-009: Use new method names with legacy aliases
  const toggleProjectCard = useEntityStore((s) => s.toggleProjectCard)
  const toggleWorkingSet = useEntityStore((s) => s.toggleWorkingSet)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const openPreview = useUIStore((s) => s.openPreview)
  const closePreview = useUIStore((s) => s.closePreview)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const requestScrollTo = useChatStore((s) => s.requestScrollTo)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHover, setShowHover] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const showTimeoutRef = useRef<number | null>(null)
  const hideTimeoutRef = useRef<number | null>(null)
  const confirmResetRef = useRef<number | null>(null)

  const messageId = entity.provenance?.messageId as string | undefined
  const isProjectCard = entity.pinned || entity.projectCard
  const isInWorkingSet = workingSetIds.has(entity.id)

  const cancelHide = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }

  const handleMouseEnter = () => {
    cancelHide()
    showTimeoutRef.current = window.setTimeout(() => {
      if (rowRef.current) {
        setAnchorRect(rowRef.current.getBoundingClientRect())
        setShowHover(true)
      }
    }, 400)
  }

  const handleMouseLeave = () => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    if (confirmDelete) return
    hideTimeoutRef.current = window.setTimeout(() => {
      setShowHover(false)
    }, 300)
  }

  const handleProvenanceClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (messageId) requestScrollTo(messageId)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      confirmResetRef.current = window.setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    if (confirmResetRef.current) clearTimeout(confirmResetRef.current)
    setShowHover(false)
    await deleteEntity(entity.id)
    if (previewEntity?.id === entity.id) closePreview()
    setConfirmDelete(false)
  }

  return (
    <div>
      <div
        ref={rowRef}
        className="flex items-center gap-1.5 px-2 py-1 rounded t-bg-hover transition-colors cursor-pointer"
        onClick={() => openPreview(entity)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {showHover && anchorRect && (
          <HoverPreview
            entity={entity}
            anchorRect={anchorRect}
            onMouseEnter={cancelHide}
            onMouseLeave={handleMouseLeave}
            onProjectCard={() => toggleProjectCard(entity.id)}
            onWorkingSet={() => toggleWorkingSet(entity.id)}
            onDelete={handleDelete}
            confirmDelete={confirmDelete}
            isInWorkingSet={isInWorkingSet}
          />
        )}
        {/* RFC-009: Status dot - blue for Project Card and Working Set */}
        <span className={`w-1 h-1 rounded-full shrink-0 ${
          isProjectCard ? 'bg-blue-400' : isInWorkingSet ? 'bg-blue-400' : 't-bg-elevated'
        }`} />
        {entity.type === 'doc' && (
          <DocFileIcon filePath={entity.filePath} className="shrink-0 t-text-muted" size={12} />
        )}
        <div className="min-w-0 flex-1">
          <span className="text-xs t-text truncate block">{entity.title}</span>
          {entity.type === 'doc' && entity.description && (
            <span className="text-[10px] t-text-muted truncate block">{entity.description}</span>
          )}
        </div>
      </div>
      {messageId && (
        <button
          onClick={handleProvenanceClick}
          className="flex items-center gap-1 ml-4 pl-2 py-0.5 text-[10px] t-text-muted hover:text-blue-400 transition-colors border-l t-border"
          title="Scroll to source message"
        >
          <MessageSquare size={9} />
          <span>from chat</span>
        </button>
      )}
    </div>
  )
}

function TodoRow({ todo, workingSetIds }: { todo: EntityItem; workingSetIds: Set<string> }) {
  const toggleTodoComplete = useEntityStore((s) => s.toggleTodoComplete)
  // RFC-009: Use new method names
  const toggleProjectCard = useEntityStore((s) => s.toggleProjectCard)
  const toggleWorkingSet = useEntityStore((s) => s.toggleWorkingSet)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const openPreview = useUIStore((s) => s.openPreview)
  const closePreview = useUIStore((s) => s.closePreview)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const requestScrollTo = useChatStore((s) => s.requestScrollTo)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHover, setShowHover] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const showTimeoutRef = useRef<number | null>(null)
  const hideTimeoutRef = useRef<number | null>(null)
  const confirmResetRef = useRef<number | null>(null)

  const messageId = todo.provenance?.messageId as string | undefined
  const isCompleted = todo.status === 'completed'
  const isProjectCard = todo.pinned || todo.projectCard
  const isInWorkingSet = workingSetIds.has(todo.id)

  const cancelHide = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }

  const handleMouseEnter = () => {
    cancelHide()
    showTimeoutRef.current = window.setTimeout(() => {
      if (rowRef.current) {
        setAnchorRect(rowRef.current.getBoundingClientRect())
        setShowHover(true)
      }
    }, 400)
  }

  const handleMouseLeave = () => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current)
      showTimeoutRef.current = null
    }
    if (confirmDelete) return
    hideTimeoutRef.current = window.setTimeout(() => {
      setShowHover(false)
    }, 300)
  }

  const handleCheckboxClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await toggleTodoComplete(todo.id)
  }

  const handleProvenanceClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (messageId) requestScrollTo(messageId)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      confirmResetRef.current = window.setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    if (confirmResetRef.current) clearTimeout(confirmResetRef.current)
    setShowHover(false)
    await deleteEntity(todo.id)
    if (previewEntity?.id === todo.id) closePreview()
    setConfirmDelete(false)
  }

  return (
    <div>
      <div
        ref={rowRef}
        className="flex items-center gap-1.5 px-2 py-1 rounded t-bg-hover transition-colors cursor-pointer"
        onClick={() => openPreview(todo)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {showHover && anchorRect && (
          <HoverPreview
            entity={todo}
            anchorRect={anchorRect}
            onMouseEnter={cancelHide}
            onMouseLeave={handleMouseLeave}
            onProjectCard={() => toggleProjectCard(todo.id)}
            onWorkingSet={() => toggleWorkingSet(todo.id)}
            onDelete={handleDelete}
            confirmDelete={confirmDelete}
            isInWorkingSet={isInWorkingSet}
          />
        )}
        {/* Checkbox for completion */}
        <button
          onClick={handleCheckboxClick}
          className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
            isCompleted
              ? 'bg-green-500 border-green-500 text-white'
              : 't-border hover:border-green-400'
          }`}
          title={isCompleted ? 'Mark as pending' : 'Mark as completed'}
        >
          {isCompleted && <Check size={10} strokeWidth={3} />}
        </button>
        {/* RFC-009: Status dot - blue for Project Card and Working Set */}
        <span className={`w-1 h-1 rounded-full shrink-0 ${
          isProjectCard ? 'bg-blue-400' : isInWorkingSet ? 'bg-blue-400' : 't-bg-elevated'
        }`} />
        <div className="min-w-0 flex-1">
          <span className={`text-xs truncate block ${
            isCompleted ? 'line-through t-text-muted' : 't-text'
          }`}>
            {todo.title}
          </span>
        </div>
      </div>
      {messageId && (
        <button
          onClick={handleProvenanceClick}
          className="flex items-center gap-1 ml-6 pl-2 py-0.5 text-[10px] t-text-muted hover:text-blue-400 transition-colors border-l t-border"
          title="Scroll to source message"
        >
          <MessageSquare size={9} />
          <span>from chat</span>
        </button>
      )}
    </div>
  )
}

export function EntityTabs() {
  const leftTab = useUIStore((s) => s.leftTab)
  const setLeftTab = useUIStore((s) => s.setLeftTab)
  // RFC-009: Get workingSet for status dot logic
  const { notes, docs, todos, workingSet, workingSetRuntime, refreshAll } = useEntityStore()
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => {
    refreshAll()
  }, [])

  // RFC-009: Create Set of working set IDs for efficient lookup
  const workingSetIds = new Set([...(workingSet || []), ...(workingSetRuntime || [])].map(e => e.id))

  // Filter todos based on showCompleted state
  const filteredTodos = showCompleted
    ? todos
    : todos.filter((t) => t.status !== 'completed')

  const entities: Record<string, EntityItem[]> = {
    todos: filteredTodos,
    notes,
    docs
  }

  const items = entities[leftTab] || []

  // Count completed todos for display
  const completedCount = todos.filter((t) => t.status === 'completed').length

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
        const buffer = await file.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(buffer).reduce((s, b) => s + String.fromCharCode(b), '')
        )
        await api.dropFile(file.name, base64, leftTab)
      } catch (err) {
        console.error(`Failed to drop file ${file.name}:`, err)
      }
    }
    refreshAll()
  }, [leftTab, refreshAll])

  return (
    <div>
      {/* Tab bar */}
      <div className="flex border-b t-border px-2">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setLeftTab(key)}
            className={`no-drag flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              leftTab === key
                ? 'border-blue-400 t-text'
                : 'border-transparent t-text-muted hover:t-text-secondary'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Show completed toggle for todos tab */}
      {leftTab === 'todos' && completedCount > 0 && (
        <button
          onClick={() => setShowCompleted(!showCompleted)}
          className="flex items-center gap-1.5 mx-2 mt-2 px-2 py-1 text-xs t-text-muted hover:t-text transition-colors rounded t-bg-hover"
        >
          {showCompleted ? <EyeOff size={12} /> : <Eye size={12} />}
          <span>{showCompleted ? 'Hide' : 'Show'} completed ({completedCount})</span>
        </button>
      )}

      {/* Drop zone - only for notes and docs */}
      {leftTab !== 'todos' && (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="mx-2 mt-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-blue-400/40"
        >
          <Upload size={16} className="mx-auto mb-1 t-text-muted" />
          <p className="text-xs t-text-muted">
            Drop files here to add {leftTab}
          </p>
        </div>
      )}

      {/* Entity list */}
      <div className="px-1 py-2 space-y-0.5">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs t-text-muted text-center">
            {leftTab === 'todos'
              ? (showCompleted ? 'No todos yet' : 'No pending todos')
              : `No ${leftTab} yet`}
          </p>
        ) : leftTab === 'todos' ? (
          items.map((e) => <TodoRow key={e.id} todo={e} workingSetIds={workingSetIds} />)
        ) : (
          items.map((e) => <EntityRow key={e.id} entity={e} workingSetIds={workingSetIds} />)
        )}
      </div>
    </div>
  )
}
