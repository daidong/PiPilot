import React, { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Pin, CheckSquare, StickyNote, BookOpen, Database, Trash2, Pencil, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useEntityStore } from '../../stores/entity-store'

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={16} className="text-yellow-500" />,
  paper: <BookOpen size={16} className="text-blue-500" />,
  data: <Database size={16} className="text-green-500" />
}

// File extension categories
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])
const PDF_EXTS = new Set(['pdf'])
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

/** Shared zoom toolbar */
function ZoomToolbar({ zoom, onZoomIn, onZoomOut, onReset }: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}) {
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b t-border shrink-0">
      <button onClick={onZoomOut} className="p-1 rounded t-text-muted t-bg-hover" title="Zoom out (Ctrl -)">
        <ZoomOut size={14} />
      </button>
      <span className="text-xs t-text-secondary w-12 text-center">{Math.round(zoom * 100)}%</span>
      <button onClick={onZoomIn} className="p-1 rounded t-text-muted t-bg-hover" title="Zoom in (Ctrl +)">
        <ZoomIn size={14} />
      </button>
      <button onClick={onReset} className="p-1 rounded t-text-muted t-bg-hover ml-1" title="Reset zoom (Ctrl 0)">
        <RotateCcw size={13} />
      </button>
    </div>
  )
}

/** Hook for zoom state + keyboard shortcuts */
function useZoom(step = 0.2, min = 0.4, max = 3) {
  const [zoom, setZoom] = useState(1)
  const zoomIn = () => setZoom((z) => Math.min(z + step, max))
  const zoomOut = () => setZoom((z) => Math.max(z - step, min))
  const resetZoom = () => setZoom(1)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn() }
      if (e.key === '-') { e.preventDefault(); zoomOut() }
      if (e.key === '0') { e.preventDefault(); resetZoom() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return { zoom, zoomIn, zoomOut, resetZoom }
}

/** Image preview with zoom — 100% = fit container width */
function ImagePreview({ dataUrl }: { dataUrl: string }) {
  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom()
  const containerRef = useRef<HTMLDivElement>(null)
  const [baseWidth, setBaseWidth] = useState<number>(0)
  const [aspectRatio, setAspectRatio] = useState<number>(1)

  // Measure container width as baseline for 100% zoom
  useEffect(() => {
    if (containerRef.current) {
      setBaseWidth(containerRef.current.clientWidth - 32) // minus padding
    }
  }, [])

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth > 0) {
      setAspectRatio(img.naturalHeight / img.naturalWidth)
    }
    // Also measure container if not yet set
    if (!baseWidth && containerRef.current) {
      setBaseWidth(containerRef.current.clientWidth - 32)
    }
  }, [baseWidth])

  const displayWidth = baseWidth > 0 ? baseWidth * zoom : undefined

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ZoomToolbar zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
      <div ref={containerRef} className="flex-1 overflow-auto min-h-0 p-4">
        <div style={displayWidth ? { width: displayWidth, height: displayWidth * aspectRatio } : undefined}>
          <img
            src={dataUrl}
            alt="Preview"
            className="rounded"
            onLoad={handleLoad}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      </div>
    </div>
  )
}

/** PDF preview via custom local-file:// protocol + iframe */
function PdfPreview({ absPath }: { absPath: string }) {
  // Use registered custom protocol to serve the file
  const src = `local-file:///${encodeURIComponent(absPath).replace(/%2F/g, '/')}`

  return (
    <div className="flex-1 min-h-0">
      <iframe src={src} className="w-full h-full border-0" style={{ minHeight: '80vh' }} />
    </div>
  )
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

  // Loaded file content for data entities
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [binaryDataUrl, setBinaryDataUrl] = useState<string | null>(null)
  const [pdfAbsPath, setPdfAbsPath] = useState<string | null>(null)
  const [fileType, setFileType] = useState<'text' | 'image' | 'pdf' | 'csv' | null>(null)
  const [loading, setLoading] = useState(false)

  // Reset editing state when entity changes
  useEffect(() => {
    setEditing(false)
    setEditTitle(entity?.title ?? '')
  }, [entity?.id])

  // Load file content for data entities with a filePath
  useEffect(() => {
    setFileContent(null)
    setBinaryDataUrl(null)
    setPdfAbsPath(null)
    setFileType(null)

    if (!entity?.filePath) return

    const ext = getExtension(entity.filePath)
    const api = (window as any).api

    if (IMAGE_EXTS.has(ext)) {
      setFileType('image')
      setLoading(true)
      api.readFileBinary(entity.filePath).then((res: any) => {
        if (res.success && res.base64) {
          setBinaryDataUrl(`data:${res.mime};base64,${res.base64}`)
        }
        setLoading(false)
      })
    } else if (PDF_EXTS.has(ext)) {
      setFileType('pdf')
      setLoading(true)
      api.resolvePath(entity.filePath).then((res: any) => {
        if (res.success && res.absPath) {
          setPdfAbsPath(res.absPath)
        }
        setLoading(false)
      })
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

  // Determine what to render in the content area
  const renderContent = () => {
    // If this is a data entity with a filePath, use the loaded file content
    if (entity.filePath && fileType) {
      if (loading) {
        return <p className="text-xs t-text-muted animate-pulse">Loading file preview...</p>
      }

      if (fileType === 'image' && binaryDataUrl) {
        return <ImagePreview dataUrl={binaryDataUrl} />
      }

      if (fileType === 'pdf' && pdfAbsPath) {
        return <PdfPreview absPath={pdfAbsPath} />
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
            onBlur={commitRename}
            onKeyDown={handleRenameKeyDown}
            className="flex-1 text-sm font-semibold t-text bg-transparent border-b border-orange-400 outline-none min-w-0"
          />
        ) : (
          <h2 className="flex-1 text-sm font-semibold t-text truncate">{entity.title}</h2>
        )}

        <div className="flex items-center gap-1">
          {!editing && (
            <button
              onClick={startEditing}
              className="p-1 rounded transition-colors t-text-muted hover:text-orange-400"
              title="Rename"
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
