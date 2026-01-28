import React, { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Pin, CheckSquare, StickyNote, BookOpen, Database, Brain, Trash2, Pencil } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore } from '../../stores/entity-store'

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={16} className="text-yellow-500" />,
  paper: <BookOpen size={16} className="text-blue-500" />,
  data: <Database size={16} className="text-green-500" />,
  memory: <Brain size={16} className="text-purple-500" />
}

export function EntityPreviewPanel() {
  const entity = useUIStore((s) => s.previewEntity)
  const closePreview = useUIStore((s) => s.closePreview)
  const togglePin = useEntityStore((s) => s.togglePin)
  const toggleSelect = useEntityStore((s) => s.toggleSelect)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const renameNote = useEntityStore((s) => s.renameNote)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')

  // Reset editing state when entity changes
  useEffect(() => {
    setEditing(false)
    setEditTitle(entity?.title ?? '')
  }, [entity?.id])

  if (!entity) return null

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 2000)
      return
    }
    await deleteEntity(entity.id)
    closePreview()
  }

  const startEditing = () => {
    setEditTitle(entity.title)
    setEditing(true)
  }

  const commitRename = async () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== entity.title) {
      await renameNote(entity.id, trimmed)
    }
    setEditing(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
    if (e.key === 'Escape') { setEditing(false) }
  }

  const content = entity.content || entity.abstract || entity.valueText || entity.filePath || 'No content available.'

  return (
    <div className="w-[480px] flex flex-col border-l t-border t-bg-base pt-10 shrink-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b t-border">
        {typeIcons[entity.type] || null}
        {editing ? (
          <input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKeyDown}
            className="flex-1 text-sm font-semibold t-text bg-transparent border-b border-orange-400 outline-none min-w-0"
          />
        ) : (
          <h2 className="flex-1 text-sm font-semibold t-text truncate">{entity.title}</h2>
        )}

        <div className="flex items-center gap-1">
          {entity.type === 'note' && !editing && (
            <button
              onClick={startEditing}
              className="p-1 rounded transition-colors t-text-muted hover:text-orange-400"
              title="Rename note"
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            onClick={() => togglePin(entity.id)}
            className={`p-1 rounded transition-colors ${entity.pinned ? 'text-orange-400' : 't-text-muted t-bg-hover'}`}
            title={entity.pinned ? 'Unpin' : 'Pin'}
          >
            <Pin size={14} />
          </button>
          <button
            onClick={() => toggleSelect(entity.id)}
            className={`p-1 rounded transition-colors ${entity.selectedForAI ? 'text-blue-400' : 't-text-muted t-bg-hover'}`}
            title={entity.selectedForAI ? 'Deselect' : 'Select for AI'}
          >
            <CheckSquare size={14} />
          </button>
          <button
            onClick={handleDelete}
            className={`p-1 rounded transition-colors ${
              confirmDelete ? 'text-red-500' : 't-text-muted t-bg-hover'
            }`}
            title={confirmDelete ? 'Click again to confirm delete' : 'Delete'}
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={closePreview}
            className="p-1 rounded t-text-muted t-bg-hover transition-colors"
            title="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Metadata row */}
      {entity.type === 'paper' && (
        <div className="px-4 py-2 border-b t-border text-xs t-text-secondary space-y-1">
          {entity.authors?.length > 0 && <p>Authors: {entity.authors.join(', ')}</p>}
          {entity.year && <p>Year: {entity.year}</p>}
          {entity.venue && <p>Venue: {entity.venue}</p>}
          {entity.citeKey && <p>Cite key: <code className="t-bg-surface px-1 rounded">{entity.citeKey}</code></p>}
        </div>
      )}

      {entity.type === 'memory' && (
        <div className="px-4 py-2 border-b t-border text-xs t-text-secondary space-y-1">
          {entity.namespace && <p>Namespace: <code className="t-bg-surface px-1 rounded">{entity.namespace}</code></p>}
          {entity.createdAt && <p>Created: {new Date(entity.createdAt).toLocaleString()}</p>}
        </div>
      )}

      {entity.type === 'data' && entity.schema && (
        <div className="px-4 py-2 border-b t-border text-xs t-text-secondary">
          <p>File: {entity.name}</p>
          {entity.schema.rowCount != null && <p>Rows: {entity.schema.rowCount}</p>}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="md-prose" style={{ color: 'var(--color-text)' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
