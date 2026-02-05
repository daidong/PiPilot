import React, { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Bookmark, Layers, StickyNote, BookOpen, Database, Trash2, Pencil } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore } from '../../stores/entity-store'

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={16} className="text-yellow-500" />,
  paper: <BookOpen size={16} className="text-blue-500" />,
  data: <Database size={16} className="text-green-500" />
}

// File extension categories
const EXTERNAL_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'pdf',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'
])
const CSV_EXTS = new Set(['csv', 'tsv'])
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'toml', 'cfg'])

function getExtension(filePath: string): string {
  return (filePath.split('.').pop() || '').toLowerCase()
}

/** Parse CSV content into rows (handles quoted fields) */
function parseCsv(content: string, separator = ','): string[][] {
  const lines = content.split('\n').filter(l => l.trim())
  return lines.map(line => {
    const cells: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === separator && !inQuotes) {
        cells.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    cells.push(current.trim())
    return cells
  })
}

/** Render a CSV/TSV table */
function CsvPreview({ content, separator }: { content: string; separator: string }) {
  const rows = parseCsv(content, separator)
  if (rows.length === 0) return <p className="text-xs t-text-muted">Empty file</p>
  const header = rows[0]
  const body = rows.slice(1, 201) // limit to 200 data rows
  const truncated = rows.length > 201

  return (
    <div className="overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="text-left px-2 py-1 border t-border font-semibold t-text" style={{ background: 'var(--color-bg-elevated)' }}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-0.5 border t-border t-text-secondary">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="text-xs t-text-muted mt-2 px-2">Showing first 200 rows of {rows.length - 1} total</p>
      )}
    </div>
  )
}

export function EntityPreviewPanel() {
  const rawEntity = useUIStore((s) => s.previewEntity)
  const closePreview = useUIStore((s) => s.closePreview)
  // RFC-009: Use new method names
  const toggleProjectCard = useEntityStore((s) => s.toggleProjectCard)
  const toggleWorkingSet = useEntityStore((s) => s.toggleWorkingSet)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const updateEntity = useEntityStore((s) => s.updateEntity)
  // RFC-009: Derive live project card/working set state from entity store
  const projectCardsIds = useEntityStore((s) => s.projectCards)
  const workingSetIds = useEntityStore((s) => s.workingSet)
  // RFC-009: Check both legacy 'pinned' and new 'projectCard' fields
  const isProjectCard = rawEntity
    ? rawEntity.pinned || rawEntity.projectCard || projectCardsIds.some((p) => p.id === rawEntity.id)
    : false
  const isInWorkingSet = rawEntity
    ? workingSetIds.some((p) => p.id === rawEntity.id)
    : false
  const entity = rawEntity
    ? { ...rawEntity }
    : null
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Loaded file content for data entities
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileType, setFileType] = useState<'text' | 'external' | 'csv' | null>(null)
  const [loading, setLoading] = useState(false)

  // Reset editing state when entity changes
  useEffect(() => {
    setEditing(false)
    setEditTitle(entity?.title ?? '')
    setEditContent('')
  }, [entity?.id])

  // Auto-resize textarea when editing
  useEffect(() => {
    if (editing && textareaRef.current) {
      const ta = textareaRef.current
      ta.style.height = 'auto'
      ta.style.height = ta.scrollHeight + 'px'
    }
  }, [editing, editContent])

  // Load file content for data entities with a filePath
  useEffect(() => {
    setFileContent(null)
    setFileType(null)

    if (!entity?.filePath) return

    const ext = getExtension(entity.filePath)
    const api = (window as any).api

    if (EXTERNAL_EXTS.has(ext)) {
      setFileType('external')
    } else if (CSV_EXTS.has(ext)) {
      setFileType('csv')
      setLoading(true)
      api.readFile(entity.filePath).then((res: any) => {
        if (res.success && res.content) {
          setFileContent(res.content)
        }
        setLoading(false)
      })
    } else if (TEXT_EXTS.has(ext) || !ext) {
      // Default to text for known text extensions or extensionless files
      setFileType('text')
      setLoading(true)
      api.readFile(entity.filePath).then((res: any) => {
        if (res.success && res.content) {
          setFileContent(res.content)
        }
        setLoading(false)
      })
    } else {
      // Try reading as text for unknown extensions
      setFileType('text')
      setLoading(true)
      api.readFile(entity.filePath).then((res: any) => {
        if (res.success && res.content) {
          setFileContent(res.content)
        }
        setLoading(false)
      })
    }
  }, [entity?.id, entity?.filePath])

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

  const getEntityContent = (): string => {
    return entity.content || entity.abstract || entity.valueText || ''
  }

  const toggleEditing = async () => {
    if (editing) {
      // Exiting edit mode — save changes
      const updates: { title?: string; content?: string } = {}
      const trimmedTitle = editTitle.trim()
      if (trimmedTitle && trimmedTitle !== entity.title) {
        updates.title = trimmedTitle
      }
      if (editContent !== getEntityContent()) {
        updates.content = editContent
      }
      if (Object.keys(updates).length > 0) {
        await updateEntity(entity.id, updates)
        // Update the preview entity in UI store so content refreshes immediately
        useUIStore.getState().openPreview({
          ...entity,
          title: updates.title ?? entity.title,
          content: entity.type === 'paper' ? entity.content : (updates.content ?? entity.content),
          abstract: entity.type === 'paper' ? (updates.content ?? entity.abstract) : entity.abstract
        })
      }
      setEditing(false)
    } else {
      // Entering edit mode
      setEditTitle(entity.title)
      setEditContent(getEntityContent())
      setEditing(true)
    }
  }

  // Determine what to render in the content area
  const renderContent = () => {
    // If this is a data entity with a filePath, use the loaded file content
    if (entity.filePath && fileType) {
      if (fileType === 'external') {
        return (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="text-sm t-text-secondary">{getExtension(entity.filePath!).toUpperCase()} file</p>
            <button
              onClick={() => (window as any).api.openFile(entity.filePath)}
              className="px-4 py-2 rounded bg-teal-500 hover:bg-teal-600 text-white text-sm"
            >
              Open in default app
            </button>
          </div>
        )
      }

      if (loading) {
        return <p className="text-xs t-text-muted animate-pulse">Loading file preview...</p>
      }

      if (fileType === 'csv' && fileContent) {
        const ext = getExtension(entity.filePath)
        return <CsvPreview content={fileContent} separator={ext === 'tsv' ? '\t' : ','} />
      }

      if (fileType === 'text' && fileContent) {
        const ext = getExtension(entity.filePath)
        const isMarkdown = ext === 'md' || ext === 'markdown'
        if (isMarkdown) {
          return (
            <div className="md-prose" style={{ color: 'var(--color-text)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown>
            </div>
          )
        }
        // Plain text or code — render in a monospace pre block
        return (
          <pre className="text-xs whitespace-pre-wrap break-words t-text font-mono leading-relaxed">{fileContent}</pre>
        )
      }

      // Fallback: show file path
      return <p className="text-xs t-text-muted">{entity.filePath}</p>
    }

    // Non-data entities or data entities without filePath: use existing content fields
    if (editing) {
      return (
        <textarea
          ref={textareaRef}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="w-full min-h-[200px] text-sm t-text bg-transparent outline-none resize-none font-mono leading-relaxed"
          placeholder="Enter content..."
        />
      )
    }

    const content = entity.content || entity.abstract || entity.valueText || 'No content available.'
    return (
      <div className="md-prose" style={{ color: 'var(--color-text)' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col border-l t-border t-bg-base pt-10 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b t-border">
        {typeIcons[entity.type] || null}
        {editing ? (
          <input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="flex-1 text-sm font-semibold t-text bg-transparent border-b border-teal-400 outline-none min-w-0"
          />
        ) : (
          <h2 className="flex-1 text-sm font-semibold t-text truncate">{entity.title}</h2>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={toggleEditing}
            className={`p-1 rounded transition-colors ${editing ? 'text-teal-400' : 't-text-muted hover:text-teal-400'}`}
            title={editing ? 'Save changes' : 'Edit'}
          >
            <Pencil size={14} />
          </button>
          {/* RFC-009: Project Card toggle */}
          <button
            onClick={() => toggleProjectCard(entity.id)}
            className={`p-1 rounded transition-colors ${isProjectCard ? 'text-teal-400' : 't-text-muted t-bg-hover'}`}
            title={isProjectCard ? 'Remove from Project Cards' : 'Mark as Project Card'}
          >
            <Bookmark size={14} />
          </button>
          {/* RFC-009: Working Set toggle */}
          <button
            onClick={() => toggleWorkingSet(entity.id)}
            className={`p-1 rounded transition-colors ${isInWorkingSet ? 'text-teal-400' : 't-text-muted t-bg-hover'}`}
            title={isInWorkingSet ? 'Remove from Working Set' : 'Add to Working Set'}
          >
            <Layers size={14} />
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
          {entity.doi && <p>DOI: <a href={`https://doi.org/${entity.doi}`} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline">{entity.doi}</a></p>}
          {entity.citationCount != null && <p>Citations: {entity.citationCount}</p>}
          {entity.url && <p>URL: <a href={entity.url} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline break-all">{entity.url}</a></p>}
          {entity.pdfUrl && <p>PDF: <a href={entity.pdfUrl} target="_blank" rel="noreferrer" className="text-teal-400 hover:underline break-all">{entity.pdfUrl}</a></p>}
          {entity.citeKey && <p>Cite key: <code className="t-bg-surface px-1 rounded">{entity.citeKey}</code></p>}
          {entity.externalSource && <p>Source: {entity.externalSource}</p>}
          {entity.relevanceScore != null && <p>Relevance: {entity.relevanceScore}/10</p>}
          {entity.enrichmentSource && <p>Enriched via: {entity.enrichmentSource}</p>}
          {entity.enrichedAt && <p>Enriched at: {new Date(entity.enrichedAt).toLocaleDateString()}</p>}
          {entity.tags?.length > 0 && (
            <p className="flex items-center gap-1 flex-wrap">
              Tags: {entity.tags.map((t: string) => (
                <span key={t} className="inline-block t-bg-surface px-1.5 py-0.5 rounded">{t}</span>
              ))}
            </p>
          )}
          {entity.bibtex && (
            <details className="mt-1">
              <summary className="cursor-pointer hover:text-teal-400">BibTeX</summary>
              <pre className="mt-1 p-2 t-bg-surface rounded text-[11px] font-mono whitespace-pre-wrap break-all">{entity.bibtex}</pre>
            </details>
          )}
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
        {renderContent()}
      </div>
    </div>
  )
}
