import React, { useEffect, useCallback, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { StickyNote, BookOpen, Database, Upload, MessageSquare, Trash2, Bookmark, Layers, ChevronRight, ChevronDown, FileSpreadsheet, FlaskConical, Loader2, RefreshCw } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useChatStore } from '../../stores/chat-store'

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
  const content = entity.content || entity.abstract || entity.valueText || ''
  const isProjectCard = entity.pinned || entity.projectCard

  // Position to the right of the sidebar (fixed position)
  // Left sidebar is ~220px, so position preview at ~230px from left
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
          {entity.type === 'paper' && entity.authors?.length > 0 && (
            <p className="text-[11px] t-text-muted truncate mt-0.5">
              {entity.authors.slice(0, 3).join(', ')}{entity.authors.length > 3 ? ' et al.' : ''}
              {entity.year ? ` (${entity.year})` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* RFC-009: Project Card toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onProjectCard() }}
            className={`p-1 rounded ${isProjectCard ? 'text-teal-400' : 't-text-muted hover:text-teal-400'}`}
            title={isProjectCard ? 'Remove from Project Cards' : 'Add to Project Cards'}
          >
            <Bookmark size={13} />
          </button>
          {/* RFC-009: Working Set toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onWorkingSet() }}
            className={`p-1 rounded ${isInWorkingSet ? 'text-teal-400' : 't-text-muted hover:text-teal-400'}`}
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
  { key: 'notes' as const, label: 'Notes', icon: StickyNote },
  { key: 'data' as const, label: 'Data', icon: Database },
  { key: 'papers' as const, label: 'Papers', icon: BookOpen }
]

function EntityRow({ entity, workingSetIds }: { entity: EntityItem; workingSetIds: Set<string> }) {
  // RFC-009: Use new method names
  const toggleProjectCard = useEntityStore((s) => s.toggleProjectCard)
  const toggleWorkingSet = useEntityStore((s) => s.toggleWorkingSet)
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
    // Delay before showing hover preview
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
    // Don't hide while waiting for delete confirmation
    if (confirmDelete) return
    // Delay before hiding so user can move mouse to preview
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
      // First click: arm confirmation, keep popup alive
      setConfirmDelete(true)
      confirmResetRef.current = window.setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    // Second click: actually delete
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
        {isEnriching ? (
          <Loader2 size={10} className="shrink-0 text-teal-400 animate-spin" />
        ) : (
          /* RFC-009: Status dot - teal for Project Card and Working Set */
          <span className={`w-1 h-1 rounded-full shrink-0 ${
            isProjectCard ? 'bg-teal-400' : isInWorkingSet ? 'bg-teal-400' : 't-bg-elevated'
          }`} />
        )}
        <span className="text-xs t-text truncate">{entity.title}</span>
      </div>
      {messageId && (
        <button
          onClick={handleProvenanceClick}
          className="flex items-center gap-1 ml-4 pl-2 py-0.5 text-[10px] t-text-muted hover:text-teal-400 transition-colors border-l t-border"
          title="Scroll to source message"
        >
          <MessageSquare size={9} />
          <span>from chat</span>
        </button>
      )}
    </div>
  )
}

function DataTreeView({ items, workingSetIds }: { items: EntityItem[]; workingSetIds: Set<string> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const openPreview = useUIStore((s) => s.openPreview)

  // Partition: top-level (no 'auto-generated' tag) vs grouped by runId
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
          <div className="flex-1 min-w-0"><EntityRow entity={e} workingSetIds={workingSetIds} /></div>
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
              <FlaskConical size={13} className="shrink-0 text-purple-400" />
              <span
                className="text-xs t-text truncate"
                onClick={() => openPreview(children[0])}
              >
                Analysis: {label}
              </span>
            </div>
            {isOpen && (
              <div className="pl-4">
                {children.map((e) => <EntityRow key={e.id} entity={e} workingSetIds={workingSetIds} />)}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function EntityTabs() {
  const leftTab = useUIStore((s) => s.leftTab)
  const setLeftTab = useUIStore((s) => s.setLeftTab)
  // RFC-009: Get workingSet for status dot logic
  const { notes, papers, data, workingSet, refreshAll, setEnriching, clearEnriching, clearAllEnriching } = useEntityStore()
  const [isEnrichingAll, setIsEnrichingAll] = useState(false)

  useEffect(() => {
    refreshAll()
  }, [])

  // RFC-009: Create Set of working set IDs for efficient lookup
  const workingSetIds = new Set(workingSet.map(e => e.id))

  const handleEnrichAll = useCallback(async () => {
    const api = (window as any).api
    setIsEnrichingAll(true)
    const unsub = api.onEnrichProgress((info: { paperId: string; status: string }) => {
      if (info.status === 'enriching') {
        setEnriching(info.paperId)
      } else {
        clearEnriching(info.paperId)
      }
    })
    try {
      await api.enrichAllPapers(papers.map((p: any) => p.id))
      await refreshAll()
    } finally {
      unsub()
      clearAllEnriching()
      setIsEnrichingAll(false)
    }
  }, [refreshAll, setEnriching, clearEnriching, clearAllEnriching])

  const entities: Record<string, EntityItem[]> = {
    notes,
    papers,
    data
  }

  const items = entities[leftTab] || []

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
        await api.dropFile(file.name, content, leftTab)
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
                ? 'border-teal-400 t-text'
                : 'border-transparent t-text-muted hover:t-text-secondary'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
        {leftTab === 'papers' && (
          <button
            onClick={handleEnrichAll}
            disabled={isEnrichingAll}
            className="no-drag ml-auto flex items-center gap-1 px-2 py-1 text-[10px] t-text-muted hover:text-teal-400 transition-colors disabled:opacity-50"
            title="Enrich metadata for all papers"
          >
            {isEnrichingAll ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
          </button>
        )}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className="mx-2 mt-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-teal-400/40"
      >
        <Upload size={16} className="mx-auto mb-1 t-text-muted" />
        <p className="text-xs t-text-muted">
          Drop files here to add {leftTab}
        </p>
      </div>

      {/* Entity list */}
      <div className="px-1 py-2 space-y-0.5">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs t-text-muted text-center">
            No {leftTab} yet
          </p>
        ) : leftTab === 'data' ? (
          <DataTreeView items={items} workingSetIds={workingSetIds} />
        ) : (
          items.map((e) => <EntityRow key={e.id} entity={e} workingSetIds={workingSetIds} />)
        )}
      </div>
    </div>
  )
}
