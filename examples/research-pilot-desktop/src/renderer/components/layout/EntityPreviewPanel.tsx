import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Layers, StickyNote, BookOpen, Database, Brain, Trash2, ArrowUp, ArrowDown, Save, ChevronUp, ChevronDown } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import type { LeftTab } from '../../stores/ui-store'
import { useEntityStore, type EntityItem, type FactItem } from '../../stores/entity-store'

const LazyMilkdownMarkdownEditor = lazy(async () => {
  const mod = await import('./MilkdownMarkdownEditor')
  return { default: mod.MilkdownMarkdownEditor }
})

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={16} className="text-yellow-500" />,
  paper: <BookOpen size={16} className="text-blue-500" />,
  data: <Database size={16} className="text-green-500" />,
  fact: <Brain size={16} className="text-purple-500" />
}

const EXTERNAL_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'pdf',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'
])
const CSV_EXTS = new Set(['csv', 'tsv'])

function getExtension(filePath: string): string {
  return (filePath.split('.').pop() || '').toLowerCase()
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim()
}

interface MarkdownFingerprint {
  length: number
  codeFenceCount: number
  mermaidFenceCount: number
  mathBlockCount: number
  imageCount: number
}

function buildFingerprint(markdown: string): MarkdownFingerprint {
  const source = markdown || ''
  const lines = source.split('\n')
  const codeFenceCount = lines.filter((line) => line.trimStart().startsWith('```')).length
  const mermaidFenceCount = lines.filter((line) => /^```mermaid\b/i.test(line.trimStart())).length
  const mathBlockCount = lines.filter((line) => line.trim() === '$$').length
  const imageCount = (source.match(/!\[[^\]]*]\([^)]+\)/g) || []).length
  return {
    length: source.length,
    codeFenceCount,
    mermaidFenceCount,
    mathBlockCount,
    imageCount
  }
}

function detectPotentialLoss(original: string, next: string): string[] {
  const before = buildFingerprint(original)
  const after = buildFingerprint(next)
  const issues: string[] = []

  if (before.length > 0 && after.length === 0) {
    issues.push('Output became empty.')
  }

  if (before.length > 0 && after.length > 0) {
    const ratio = after.length / before.length
    if (ratio < 0.2) {
      issues.push(`Content length dropped significantly (${Math.round(ratio * 100)}%).`)
    }
  }

  if (before.codeFenceCount > 0 && after.codeFenceCount === 0) {
    issues.push('All fenced code blocks disappeared.')
  }

  if (before.mermaidFenceCount > 0 && after.mermaidFenceCount === 0) {
    issues.push('Mermaid blocks disappeared.')
  }

  if (before.mathBlockCount >= 2 && after.mathBlockCount === 0) {
    issues.push('Math block delimiters ($$) disappeared.')
  }

  if (before.imageCount > 0 && after.imageCount === 0) {
    issues.push('Image links disappeared.')
  }

  return issues
}

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

function CsvPreview({ content, separator }: { content: string; separator: string }) {
  const rows = parseCsv(content, separator)
  if (rows.length === 0) return <p className="text-xs t-text-muted">Empty file</p>
  const header = rows[0]
  const body = rows.slice(1, 201)
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

function factToPreviewEntity(fact: FactItem): EntityItem {
  return {
    id: fact.id,
    type: 'fact',
    title: `${fact.namespace}/${fact.key}`,
    content: typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value, null, 2),
    valueText: fact.valueText,
    namespace: fact.namespace,
    key: fact.key,
    status: fact.status,
    confidence: fact.confidence,
    provenance: fact.provenance,
    derivedFromArtifactIds: fact.derivedFromArtifactIds,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt
  }
}

function usePreviewNavigation() {
  const previewSourceTab = useUIStore((s) => s.previewSourceTab)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const openPreview = useUIStore((s) => s.openPreview)
  const notes = useEntityStore((s) => s.notes)
  const papers = useEntityStore((s) => s.papers)
  const data = useEntityStore((s) => s.data)
  const facts = useEntityStore((s) => s.facts)
  const focus = useEntityStore((s) => s.focus)

  const list: EntityItem[] = (() => {
    switch (previewSourceTab) {
      case 'library':
        return [...notes, ...data]
      case 'papers':
        return papers
      case 'knowledge':
        return facts.map(factToPreviewEntity)
      case 'focus':
        return focus
      case 'tasks':
      case 'runs':
      default:
        return []
    }
  })()

  const currentIndex = previewEntity ? list.findIndex((item) => item.id === previewEntity.id) : -1
  const total = list.length
  const canNavigate = total > 1 && currentIndex >= 0

  const goNext = useCallback(() => {
    if (!canNavigate) return
    const nextIndex = (currentIndex + 1) % total
    openPreview(list[nextIndex])
  }, [canNavigate, currentIndex, total, list, openPreview])

  const goPrev = useCallback(() => {
    if (!canNavigate) return
    const prevIndex = (currentIndex - 1 + total) % total
    openPreview(list[prevIndex])
  }, [canNavigate, currentIndex, total, list, openPreview])

  return { canNavigate, goNext, goPrev, currentIndex, total }
}

export function EntityPreviewPanel() {
  const rawEntity = useUIStore((s) => s.previewEntity)
  const closePreview = useUIStore((s) => s.closePreview)
  const setPreviewEditorFocused = useUIStore((s) => s.setPreviewEditorFocused)
  const toggleFocus = useEntityStore((s) => s.toggleFocus)
  const deleteEntity = useEntityStore((s) => s.deleteEntity)
  const refreshAll = useEntityStore((s) => s.refreshAll)
  const promoteFact = useEntityStore((s) => s.promoteFact)
  const demoteFact = useEntityStore((s) => s.demoteFact)
  const focusItems = useEntityStore((s) => s.focus)

  const previewEditorFocused = useUIStore((s) => s.previewEditorFocused)
  const nav = usePreviewNavigation()

  const isInFocus = rawEntity ? focusItems.some((p) => p.id === rawEntity.id) : false
  const entity = rawEntity ? { ...rawEntity } : null

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [baselineMarkdown, setBaselineMarkdown] = useState('')
  const [editorSeedMarkdown, setEditorSeedMarkdown] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileType, setFileType] = useState<'text' | 'external' | 'csv' | null>(null)
  const [loading, setLoading] = useState(false)
  // In-place content update (passed to Milkdown to replace without rebuilding)
  const [externalMarkdown, setExternalMarkdown] = useState<string | undefined>(undefined)
  // Resolved absolute path for matching agent:file-created events
  const resolvedAbsPathRef = useRef<string | null>(null)
  // Track latest baseline for stale-closure comparisons
  const baselineRef = useRef('')

  const getArtifactMarkdownContent = (artifactLike: any): string => {
    if (!artifactLike) return ''
    if (artifactLike.type === 'paper') {
      return artifactLike.abstract || artifactLike.content || artifactLike.valueText || ''
    }
    return artifactLike.content || artifactLike.valueText || artifactLike.abstract || ''
  }

  const getEntityContent = (): string => {
    if (!entity) return ''
    return getArtifactMarkdownContent(entity)
  }

  useEffect(() => {
    if (!entity) return
    const initial = getEntityContent()
    setDraftMarkdown(initial)
    setBaselineMarkdown(initial)
    setEditorSeedMarkdown(initial)
    setSaveError(null)
    setSaveSuccess(null)
    setPreviewEditorFocused(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.id])

  useEffect(() => {
    setFileContent(null)
    setFileType(null)
    resolvedAbsPathRef.current = null
    setExternalMarkdown(undefined)

    if (!entity?.filePath) return

    const ext = getExtension(entity.filePath)
    const api = (window as any).api

    if (EXTERNAL_EXTS.has(ext)) {
      setFileType('external')
      return
    }

    const targetType: 'text' | 'csv' = CSV_EXTS.has(ext) ? 'csv' : 'text'
    const isMarkdown = ext === 'md' || ext === 'markdown'
    setFileType(targetType)
    setLoading(true)
    api.readFile(entity.filePath)
      .then((res: any) => {
        if (res.success && typeof res.content === 'string') {
          setFileContent(res.content)
          // Store resolved absolute path for file-change matching
          if (res.path) resolvedAbsPathRef.current = res.path
          if (targetType === 'text' && isMarkdown) {
            setDraftMarkdown(res.content)
            setBaselineMarkdown(res.content)
            setEditorSeedMarkdown(res.content)
            baselineRef.current = res.content
            setSaveError(null)
            setSaveSuccess(null)
          }
        } else if (!res.success && targetType === 'text' && isMarkdown) {
          setSaveError(res.error || 'Failed to load markdown file.')
        }
      })
      .finally(() => setLoading(false))
  }, [entity?.id, entity?.filePath])

  useEffect(() => {
    return () => setPreviewEditorFocused(false)
  }, [setPreviewEditorFocused])

  // Keep baselineRef in sync for stale-closure comparisons
  useEffect(() => {
    baselineRef.current = baselineMarkdown
  }, [baselineMarkdown])

  // Auto-reload when agent modifies the currently previewed markdown file
  useEffect(() => {
    if (!entity?.filePath) return
    const ext = getExtension(entity.filePath)
    if (ext !== 'md' && ext !== 'markdown') return

    const api = (window as any).api
    const unsub = api.onFileCreated((changedPath: string) => {
      if (!resolvedAbsPathRef.current) return
      if (changedPath !== resolvedAbsPathRef.current) return

      // Re-read the file and update editor content in-place
      api.readFile(entity.filePath).then((res: any) => {
        if (!res.success || typeof res.content !== 'string') return
        // Only update if content actually changed from the current baseline
        if (normalizeMarkdown(res.content) === normalizeMarkdown(baselineRef.current)) return
        setFileContent(res.content)
        setBaselineMarkdown(res.content)
        setDraftMarkdown(res.content)
        setExternalMarkdown(res.content)
        baselineRef.current = res.content
      })
    })
    return unsub
  }, [entity?.id, entity?.filePath])

  // Auto-reload inline artifacts (notes, papers) after an agent turn completes
  useEffect(() => {
    if (!entity?.id || entity.filePath || entity.type === 'fact') return

    const api = (window as any).api
    const unsub = api.onAgentDone(async () => {
      try {
        const latest = await api.artifactGet(entity.id)
        if (!latest) return
        const content = getArtifactMarkdownContent(latest)
        if (normalizeMarkdown(content) === normalizeMarkdown(baselineRef.current)) return
        setDraftMarkdown(content)
        setBaselineMarkdown(content)
        setExternalMarkdown(content)
        baselineRef.current = content
      } catch { /* ignore fetch errors */ }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.id, entity?.filePath, entity?.type])

  if (!entity) return null

  const fileExt = entity.filePath ? getExtension(entity.filePath) : ''
  const isFileMarkdown = Boolean(entity.filePath && (fileExt === 'md' || fileExt === 'markdown'))
  const isInlineEditable = entity.type !== 'fact' && !entity.filePath
  const isEditable = isInlineEditable || isFileMarkdown
  const isDirty = isEditable && normalizeMarkdown(draftMarkdown) !== normalizeMarkdown(baselineMarkdown)
  // Rebuild Milkdown when a different document seed loads, but keep it
  // stable while typing/saving in the same preview session.
  const seedFp = buildFingerprint(editorSeedMarkdown)
  const editorKey = `${entity.id}:${entity.filePath ?? 'inline'}:${seedFp.length}:${seedFp.codeFenceCount}:${seedFp.mermaidFenceCount}:${seedFp.mathBlockCount}:${seedFp.imageCount}`

  const handleNavNext = useCallback(() => {
    if (!nav.canNavigate) return
    if (isEditable && isDirty) {
      const proceed = window.confirm('You have unsaved markdown changes. Navigate without saving?')
      if (!proceed) return
    }
    nav.goNext()
  }, [nav, isEditable, isDirty])

  const handleNavPrev = useCallback(() => {
    if (!nav.canNavigate) return
    if (isEditable && isDirty) {
      const proceed = window.confirm('You have unsaved markdown changes. Navigate without saving?')
      if (!proceed) return
    }
    nav.goPrev()
  }, [nav, isEditable, isDirty])

  // Keyboard shortcut: Alt+ArrowUp / Alt+ArrowDown for prev/next navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!nav.canNavigate || previewEditorFocused) return
      if (!e.altKey) return
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        handleNavPrev()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        handleNavNext()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [nav.canNavigate, previewEditorFocused, handleNavPrev, handleNavNext])

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 2000)
      return
    }
    await deleteEntity(entity.id)
    closePreview()
  }

  const handleSave = async () => {
    if (!isEditable || !isDirty) return

    const nextMarkdown = draftMarkdown
    const issues = detectPotentialLoss(baselineMarkdown, nextMarkdown)
    if (issues.length > 0) {
      const details = issues.map((issue) => `- ${issue}`).join('\n')
      const proceed = window.confirm(
        `Potential markdown compatibility risk detected:\n${details}\n\nSave anyway?`
      )
      if (!proceed) return
    }

    try {
      setSaveError(null)
      setSaveSuccess(null)
      if (isInlineEditable) {
        const api = (window as any).api
        const latest = await api.artifactGet(entity.id)
        if (!latest) {
          throw new Error('Unable to load latest artifact before save.')
        }

        const latestOnDisk = getArtifactMarkdownContent(latest)
        if (normalizeMarkdown(latestOnDisk) !== normalizeMarkdown(baselineMarkdown)) {
          setSaveError('Detected newer content on disk. Reload this note and retry to avoid overwriting newer changes.')
          return
        }

        const patch = entity.type === 'paper'
          ? { abstract: nextMarkdown }
          : { content: nextMarkdown }
        const updated = await api.artifactUpdate(entity.id, patch)
        if (!updated?.success) {
          throw new Error(updated?.error || 'Failed to save artifact.')
        }

        const persisted = updated?.artifact ?? await api.artifactGet(entity.id)
        const persistedMarkdown = getArtifactMarkdownContent(persisted)
        setDraftMarkdown(persistedMarkdown)
        setBaselineMarkdown(persistedMarkdown)
        await refreshAll()
      } else if (isFileMarkdown && entity.filePath) {
        const api = (window as any).api
        const result = await api.writeFile(entity.filePath, nextMarkdown)
        if (!result?.success) {
          throw new Error(result?.error || 'Failed to write markdown file.')
        }
        const verify = await api.readFile(entity.filePath)
        const persistedMarkdown = (verify?.success && typeof verify.content === 'string')
          ? verify.content
          : nextMarkdown
        setFileContent(persistedMarkdown)
        setDraftMarkdown(persistedMarkdown)
        setBaselineMarkdown(persistedMarkdown)
      }
      setSaveSuccess('Saved')
      setTimeout(() => setSaveSuccess(null), 1200)
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save markdown.')
    }
  }

  const handleClosePreview = () => {
    if (isEditable && isDirty) {
      const proceed = window.confirm('You have unsaved markdown changes. Close preview without saving?')
      if (!proceed) return
    }
    setPreviewEditorFocused(false)
    closePreview()
  }

  const renderMarkdownEditor = () => (
    <div className="space-y-2">
      {(saveError || saveSuccess) && (
        <div className={`text-xs px-2 py-1 rounded border ${
          saveError
            ? 'text-red-400 border-red-400/40 bg-red-500/10'
            : 'text-teal-500 border-teal-500/40 bg-teal-500/10'
        }`}
        >
          {saveError || saveSuccess}
        </div>
      )}

      <div className="border t-border rounded-lg overflow-hidden">
        <Suspense fallback={<div className="px-3 py-2 text-xs t-text-muted">Loading markdown editor...</div>}>
          <LazyMilkdownMarkdownEditor
            editorId={editorKey}
            initialMarkdown={baselineMarkdown}
            externalMarkdown={externalMarkdown}
            onChange={(markdown) => {
              setDraftMarkdown(markdown)
              if (saveError) setSaveError(null)
            }}
            onFocusChange={setPreviewEditorFocused}
            onSaveShortcut={() => {
              void handleSave()
            }}
          />
        </Suspense>
      </div>
    </div>
  )

  const renderContent = () => {
    if (entity.filePath && fileType) {
      if (fileType === 'external') {
        return (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="text-sm t-text-secondary">{getExtension(entity.filePath).toUpperCase()} file</p>
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

      if (fileType === 'csv' && fileContent !== null) {
        const ext = getExtension(entity.filePath)
        return <CsvPreview content={fileContent} separator={ext === 'tsv' ? '\t' : ','} />
      }

      if (fileType === 'text' && fileContent !== null) {
        const ext = getExtension(entity.filePath)
        const isMarkdown = ext === 'md' || ext === 'markdown'
        if (isMarkdown) {
          return renderMarkdownEditor()
        }
        return (
          <pre className="text-xs whitespace-pre-wrap break-words t-text font-mono leading-relaxed">{fileContent}</pre>
        )
      }

      return <p className="text-xs t-text-muted">{entity.filePath}</p>
    }

    if (isInlineEditable) {
      return renderMarkdownEditor()
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
      <div className="flex items-center gap-3 px-4 py-3 border-b t-border">
        {typeIcons[entity.type] || null}
        <h2 className="flex-1 text-sm font-semibold t-text truncate">{entity.title}</h2>
        {isEditable && isDirty && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">Unsaved</span>
        )}

        {nav.canNavigate && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleNavPrev}
              className="p-1 rounded t-text-muted t-bg-hover transition-colors"
              title="Previous item (Alt+Up)"
            >
              <ChevronUp size={14} />
            </button>
            <span className="text-[10px] t-text-muted tabular-nums min-w-[2.5rem] text-center">
              {nav.currentIndex + 1} / {nav.total}
            </span>
            <button
              onClick={handleNavNext}
              className="p-1 rounded t-text-muted t-bg-hover transition-colors"
              title="Next item (Alt+Down)"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1">
          {entity.type !== 'fact' && (
            <>
              {isEditable && (
                <button
                  onClick={() => void handleSave()}
                  disabled={!isDirty}
                  className={`p-1 rounded transition-colors ${
                    isDirty ? 'text-teal-400 hover:text-teal-300' : 't-text-muted opacity-50'
                  }`}
                  title={isDirty ? 'Save markdown (Cmd/Ctrl+S)' : 'No changes to save'}
                >
                  <Save size={14} />
                </button>
              )}
              <button
                onClick={() => toggleFocus(entity.id)}
                className={`p-1 rounded transition-colors ${isInFocus ? 'text-teal-400' : 't-text-muted t-bg-hover'}`}
                title={isInFocus ? 'Remove from Focus' : 'Add to Focus'}
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
            </>
          )}
          <button
            onClick={handleClosePreview}
            className="p-1 rounded t-text-muted t-bg-hover transition-colors"
            title="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

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

      {entity.type === 'fact' && (
        <div className="px-4 py-2 border-b t-border text-xs t-text-secondary space-y-1">
          <p>Namespace: <code className="t-bg-surface px-1 rounded">{entity.namespace}</code></p>
          <p>Key: <code className="t-bg-surface px-1 rounded">{entity.key}</code></p>
          <p>Status: <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
            entity.status === 'active' ? 'text-green-500 bg-green-500/10' :
            entity.status === 'proposed' ? 'text-yellow-500 bg-yellow-500/10' :
            entity.status === 'deprecated' ? 'text-red-400 bg-red-400/10' :
            't-text-muted t-bg-surface'
          }`}>{entity.status}</span></p>
          {entity.confidence != null && (
            <p>Confidence: {Math.round(entity.confidence * 100)}%</p>
          )}
          {entity.provenance && (
            <div>
              <p>Source: {entity.provenance.sourceType} ({entity.provenance.sourceRef})</p>
              {entity.provenance.traceId && <p>Trace: <code className="t-bg-surface px-1 rounded text-[10px]">{entity.provenance.traceId}</code></p>}
              {entity.provenance.sessionId && <p>Session: <code className="t-bg-surface px-1 rounded text-[10px]">{entity.provenance.sessionId.slice(0, 8)}</code></p>}
            </div>
          )}
          {entity.derivedFromArtifactIds?.length > 0 && (
            <p>Linked artifacts: {entity.derivedFromArtifactIds.length}</p>
          )}
          {entity.createdAt && <p>Created: {new Date(entity.createdAt).toLocaleString()}</p>}
          {entity.updatedAt && <p>Updated: {new Date(entity.updatedAt).toLocaleString()}</p>}
          <div className="flex items-center gap-2 pt-1">
            {entity.status === 'proposed' && (
              <button
                onClick={() => promoteFact(entity.id)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-green-500 bg-green-500/10 hover:bg-green-500/20 transition-colors"
              >
                <ArrowUp size={10} /> Promote to Active
              </button>
            )}
            {(entity.status === 'active' || entity.status === 'proposed') && (
              <button
                onClick={() => demoteFact(entity.id)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-red-400 bg-red-400/10 hover:bg-red-400/20 transition-colors"
              >
                <ArrowDown size={10} /> Deprecate
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {renderContent()}
      </div>
    </div>
  )
}
