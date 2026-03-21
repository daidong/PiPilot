import React, { useEffect, useCallback, useMemo, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const remarkPlugins = [remarkGfm]
import {
  BookMarked,
  BookOpen,
  FolderOpen,
  Upload,
  MessageSquare,
  Trash2,
  ChevronRight,
  ChevronDown,
  FileSpreadsheet,
  FlaskConical,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useChatStore } from '../../stores/chat-store'
import { WorkspaceTree } from './WorkspaceTree'

function HoverPreview({
  entity,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onDelete,
  confirmDelete
}: {
  entity: EntityItem
  anchorRect: DOMRect
  onMouseEnter: () => void
  onMouseLeave: () => void
  onDelete: () => void
  confirmDelete: boolean
}) {
  const content = entity.content || entity.abstract || ''
  const top = Math.min(anchorRect.top, window.innerHeight - 320)

  return (
    <div
      className="fixed z-50 w-80 max-h-72 overflow-y-auto rounded-lg border t-border t-bg-surface shadow-xl"
      style={{ left: 280, top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="px-3 py-2 border-b t-border flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold t-text truncate">{entity.title}</h4>
          {entity.type === 'paper' && entity.authors?.length > 0 && (
            <p className="text-[11px] t-text-muted truncate mt-0.5">
              {entity.authors.slice(0, 3).join(', ')}{entity.authors.length > 3 ? ' et al.' : ''}
              {entity.year ? ` (${entity.year})` : ''}
            </p>
          )}
        </div>
        {entity.id !== 'agent-md' && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className={`p-1 rounded transition-colors ${confirmDelete ? 't-text-error' : 't-text-muted hover:t-text-error-soft'}`}
              title={confirmDelete ? 'Click again to confirm' : 'Delete'}
              aria-label={confirmDelete ? `Confirm delete ${entity.title}` : `Delete ${entity.title}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
      {content && (
        <div className="px-3 py-2">
          <div className="md-prose text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            <ReactMarkdown remarkPlugins={remarkPlugins}>
              {content.length > 600 ? content.slice(0, 600) + '...' : content}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

const tabs = [
  { key: 'library' as const, label: 'Library', icon: BookMarked },
  { key: 'papers' as const, label: 'Papers', icon: BookOpen },
  { key: 'files' as const, label: 'Files', icon: FolderOpen }
]

const EntityRow = React.memo(function EntityRow({ entity }: { entity: EntityItem }) {
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const enrichingPapers = useEntityStore((s) => s.enrichingPapers)
  const isEnriching = enrichingPapers.has(entity.id)
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
    hideTimeoutRef.current = window.setTimeout(() => setShowHover(false), 300)
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
            onDelete={handleDelete}
            confirmDelete={confirmDelete}
          />
        )}
        {isEnriching ? (
          <Loader2 size={10} className="shrink-0 t-text-accent-soft animate-spin" />
        ) : (
          <span className="w-1 h-1 rounded-full shrink-0 t-bg-elevated" />
        )}
        <span className="text-xs t-text truncate">{entity.title}</span>
      </div>
      {messageId && (
        <button
          onClick={handleProvenanceClick}
          className="flex items-center gap-1 ml-4 pl-2 py-0.5 text-[10px] t-text-muted hover:t-text-accent-soft transition-colors border-l t-border"
          title="Scroll to source message"
        >
          <MessageSquare size={9} />
          <span>from chat</span>
        </button>
      )}
    </div>
  )
})

function DataTreeView({ items }: { items: EntityItem[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const openPreview = useUIStore((s) => s.openPreview)
  const topLevel: EntityItem[] = []
  const grouped = new Map<string, EntityItem[]>()

  for (const item of items) {
    const tags: string[] = item.tags || []
    const runId: string | undefined = item.runId
    if (tags.includes('auto-generated') && runId) {
      const group = grouped.get(runId) || []
      group.push(item)
      grouped.set(runId, group)
    } else {
      topLevel.push(item)
    }
  }

  const toggleGroup = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  return (
    <>
      {topLevel.map((e) => (
        <div key={e.id} className="flex items-center gap-1">
          <FileSpreadsheet size={13} className="shrink-0 t-text-muted ml-2" />
          <div className="flex-1 min-w-0"><EntityRow entity={e} /></div>
        </div>
      ))}
      {Array.from(grouped.entries()).map(([runId, children]) => {
        const isOpen = expanded.has(runId)
        const label = children[0]?.runLabel || runId
        return (
          <div key={runId}>
            <div className="flex items-center gap-1 px-2 py-1 rounded t-bg-hover transition-colors cursor-pointer">
              <button
                onClick={() => toggleGroup(runId)}
                className="shrink-0 t-text-muted hover:t-text"
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <FlaskConical size={13} className="shrink-0 t-text-accent" />
              <span className="text-xs t-text truncate" onClick={() => openPreview(children[0])}>
                Analysis: {label}
              </span>
            </div>
            {isOpen && (
              <div className="pl-4">
                {children.map((e) => <EntityRow key={e.id} entity={e} />)}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Library tab content: shows notes + data (everything except papers) */
function LibraryContent({
  notes,
  data,
  refreshAll
}: {
  notes: EntityItem[]
  data: EntityItem[]
  refreshAll: () => Promise<void>
}) {
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
        const content = await file.text()
        await api.dropFile(file.name, content, 'notes')
      } catch (err) {
        console.error(`Failed to drop file ${file.name}:`, err)
      }
    }
    refreshAll()
  }, [refreshAll])

  const allItems = useMemo(() => [...notes, ...data], [notes, data])

  return (
    <>
      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className="mx-2 mt-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-[var(--color-accent-soft)]/40"
      >
        <Upload size={16} className="mx-auto mb-1 t-text-accent-soft" />
        <p className="text-xs t-text-muted">Drop files here</p>
      </div>

      <div className="px-1 py-2 space-y-0.5 overflow-y-auto min-h-0 flex-1">
        {allItems.length === 0 ? (
          <p className="px-3 py-4 text-xs t-text-muted text-center">No items yet</p>
        ) : (
          <>
            {notes.length > 0 && (
              <>
                <p className="text-[10px] t-text-accent-soft uppercase tracking-wider px-2 pt-1 pb-0.5">Notes ({notes.length})</p>
                {notes.map((e) => <EntityRow key={e.id} entity={e} />)}
              </>
            )}
            {data.length > 0 && (
              <>
                <p className="text-[10px] t-text-accent-soft uppercase tracking-wider px-2 pt-2 pb-0.5">Data ({data.length})</p>
                <DataTreeView items={data} />
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** Papers tab content: shows papers with enrich button */
function PapersContent({
  papers,
  refreshAll
}: {
  papers: EntityItem[]
  refreshAll: () => Promise<void>
}) {
  const { setEnriching, clearEnriching, clearAllEnriching } = useEntityStore()
  const [isEnrichingAll, setIsEnrichingAll] = useState(false)

  const handleEnrichAll = useCallback(async () => {
    const api = (window as any).api
    setIsEnrichingAll(true)
    const unsub = api.onEnrichProgress((info: { paperId: string; status: string }) => {
      if (info.status === 'enriching') setEnriching(info.paperId)
      else clearEnriching(info.paperId)
    })
    try {
      await api.enrichAllPapers(papers.map((p: any) => p.id))
      await refreshAll()
    } finally {
      unsub()
      clearAllEnriching()
      setIsEnrichingAll(false)
    }
  }, [refreshAll, setEnriching, clearEnriching, clearAllEnriching, papers])

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
        const content = await file.text()
        await api.dropFile(file.name, content, 'papers')
      } catch (err) {
        console.error(`Failed to drop file ${file.name}:`, err)
      }
    }
    refreshAll()
  }, [refreshAll])

  return (
    <>
      <div className="flex items-center px-3 pt-2 pb-1">
        <span className="text-[10px] t-text-muted">{papers.length} papers</span>
        <button
          onClick={handleEnrichAll}
          disabled={isEnrichingAll}
          className="no-drag ml-auto flex items-center gap-1 px-2 py-1 text-[10px] t-text-muted hover:t-text-accent-soft transition-colors disabled:opacity-50"
          title="Enrich metadata for all papers"
        >
          {isEnrichingAll ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          <span>Enrich</span>
        </button>
      </div>

      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className="mx-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-[var(--color-accent-soft)]/40"
      >
        <Upload size={16} className="mx-auto mb-1 t-text-muted" />
        <p className="text-xs t-text-muted">Drop files here to add papers</p>
      </div>

      <div className="px-1 py-2 space-y-0.5 overflow-y-auto min-h-0 flex-1">
        {papers.length === 0 ? (
          <p className="px-3 py-4 text-xs t-text-muted text-center">No papers yet</p>
        ) : (
          papers.map((e) => <EntityRow key={e.id} entity={e} />)
        )}
      </div>
    </>
  )
}

export function EntityTabs() {
  const leftTab = useUIStore((s) => s.leftTab)
  const setLeftTab = useUIStore((s) => s.setLeftTab)
  const notes = useEntityStore((s) => s.notes)
  const papers = useEntityStore((s) => s.papers)
  const data = useEntityStore((s) => s.data)
  const refreshAll = useEntityStore((s) => s.refreshAll)

  useEffect(() => {
    refreshAll()
  }, [])

  const renderContent = () => {
    switch (leftTab) {
      case 'library':
        return <LibraryContent notes={notes} data={data} refreshAll={refreshAll} />
      case 'papers':
        return <PapersContent papers={papers} refreshAll={refreshAll} />
      case 'files':
        return <WorkspaceTree />
      default:
        return null
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex border-b t-border px-1" role="tablist" aria-label="Content categories">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={leftTab === key}
            onClick={() => setLeftTab(key)}
            className={`no-drag flex items-center gap-1 px-2 py-2 text-[11px] font-medium border-b-2 transition-colors ${
              leftTab === key
                ? 'border-[var(--color-accent-soft)] t-text-accent'
                : 'border-transparent t-text-muted hover:t-text-secondary'
            }`}
            title={label}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {renderContent()}
      </div>
    </div>
  )
}
