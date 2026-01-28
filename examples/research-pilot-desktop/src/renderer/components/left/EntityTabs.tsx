import React, { useEffect, useCallback, useState } from 'react'
import { StickyNote, BookOpen, Database, Brain, Upload, MessageSquare, Trash2 } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useChatStore } from '../../stores/chat-store'

const tabs = [
  { key: 'notes' as const, label: 'Notes', icon: StickyNote },
  { key: 'data' as const, label: 'Data', icon: Database },
  { key: 'papers' as const, label: 'Papers', icon: BookOpen },
  { key: 'memory' as const, label: 'Mem', icon: Brain }
]

function EntityRow({ entity }: { entity: EntityItem }) {
  const togglePin = useEntityStore((s) => s.togglePin)
  const toggleSelect = useEntityStore((s) => s.toggleSelect)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const openPreview = useUIStore((s) => s.openPreview)
  const closePreview = useUIStore((s) => s.closePreview)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const requestScrollTo = useChatStore((s) => s.requestScrollTo)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const messageId = entity.provenance?.messageId as string | undefined

  const handleProvenanceClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (messageId) requestScrollTo(messageId)
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 2000)
      return
    }
    await deleteEntity(entity.id)
    if (previewEntity?.id === entity.id) closePreview()
    setConfirmDelete(false)
  }

  return (
    <div>
      <div
        className="group flex items-center gap-2 px-3 py-2 rounded-lg t-bg-hover transition-colors cursor-pointer"
        onClick={() => openPreview(entity)}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          entity.pinned ? 'bg-orange-400' : entity.selectedForAI ? 'bg-blue-400' : 't-bg-elevated'
        }`} />
        <span className="text-sm t-text truncate flex-1">{entity.title}</span>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); togglePin(entity.id) }}
            className={`text-xs px-1.5 py-0.5 rounded ${entity.pinned ? 'text-orange-400' : 't-text-muted hover:text-orange-400'}`}
            title={entity.pinned ? 'Unpin' : 'Pin'}
          >
            pin
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); toggleSelect(entity.id) }}
            className={`text-xs px-1.5 py-0.5 rounded ${entity.selectedForAI ? 'text-blue-400' : 't-text-muted hover:text-blue-400'}`}
            title={entity.selectedForAI ? 'Deselect' : 'Select'}
          >
            sel
          </button>
          <button
            onClick={handleDelete}
            className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
              confirmDelete ? 'text-red-500' : 't-text-muted hover:text-red-400'
            }`}
            title={confirmDelete ? 'Click again to confirm' : 'Delete'}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {messageId && (
        <button
          onClick={handleProvenanceClick}
          className="flex items-center gap-1.5 ml-6 pl-3 py-0.5 text-[11px] t-text-muted hover:text-orange-400 transition-colors border-l t-border"
          title="Scroll to source message"
        >
          <MessageSquare size={10} />
          <span>from chat reply</span>
        </button>
      )}
    </div>
  )
}

export function EntityTabs() {
  const leftTab = useUIStore((s) => s.leftTab)
  const setLeftTab = useUIStore((s) => s.setLeftTab)
  const { notes, papers, data, memory, refreshAll } = useEntityStore()

  useEffect(() => {
    refreshAll()
  }, [])

  const entities: Record<string, EntityItem[]> = {
    notes,
    papers,
    data,
    memory
  }

  const items = entities[leftTab] || []

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    // Files dropped — for now log, real implementation would call save-data / save-note
    for (const file of files) {
      console.log(`Dropped file: ${file.name} (${file.type}, ${file.size} bytes)`)
    }
  }, [])

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
                ? 'border-orange-400 t-text'
                : 'border-transparent t-text-muted hover:t-text-secondary'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Drop zone (hidden for memory tab) */}
      {leftTab !== 'memory' && (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="mx-2 mt-2 rounded-lg border-2 border-dashed t-border px-3 py-3 text-center transition-colors hover:border-orange-400/40"
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
            No {leftTab} yet
          </p>
        ) : (
          items.map((e) => <EntityRow key={e.id} entity={e} />)
        )}
      </div>
    </div>
  )
}
