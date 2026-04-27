import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const remarkPlugins = [remarkGfm]
import { X, StickyNote, BookOpen, Database, Save, ChevronUp, ChevronDown, Presentation, FileText, Code, Eye } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import type { LeftTab } from '../../stores/ui-store'
import { useEntityStore, type EntityItem } from '../../stores/entity-store'
import { useSessionStore } from '../../stores/session-store'
import { dirnameOf, resolveMarkdownImageUrl } from '../../utils/markdown-image'
import { isMarpFrontmatter, splitFrontmatter, splitSlides } from '../../utils/marp'
import { MarpSlideView } from './MarpSlideView'

// Mirrors WorkspaceTree.TEXT_EXTENSIONS — the set of file types that open
// in the preview drawer on click (rather than launching in the system's
// default app). Used here to filter sibling files that should be
// reachable via the drawer's prev/next navigation.
// HTML is deliberately excluded — it launches externally (browser) so
// the user sees the rendered page, not the source.
const NAVIGABLE_FILE_EXTS = new Set([
  'md', 'txt', 'json', 'ts', 'js', 'css', 'yml', 'yaml',
  'toml', 'env', 'sh', 'py', 'cfg', 'ini', 'log', 'csv', 'xml',
  'rst', 'jsx', 'tsx', 'mjs', 'cjs', 'markdown', 'gitignore',
])

interface FileSibling {
  name: string
  path: string
  modifiedAt: number
}

const LazyMilkdownMarkdownEditor = lazy(async () => {
  const mod = await import('./MilkdownMarkdownEditor')
  return { default: mod.MilkdownMarkdownEditor }
})

const LazySourceMarkdownEditor = lazy(async () => {
  const mod = await import('./SourceMarkdownEditor')
  return { default: mod.SourceMarkdownEditor }
})

const typeIcons: Record<string, React.ReactNode> = {
  note: <StickyNote size={16} className="t-text-warning" />,
  paper: <BookOpen size={16} className="t-text-info" />,
  data: <Database size={16} className="t-text-success" />
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

function normalizePathSep(p: string): string {
  return p.replace(/\\/g, '/')
}

function usePreviewNavigation() {
  const previewSourceTab = useUIStore((s) => s.previewSourceTab)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const openPreview = useUIStore((s) => s.openPreview)
  const notes = useEntityStore((s) => s.notes)
  const papers = useEntityStore((s) => s.papers)
  const data = useEntityStore((s) => s.data)
  const projectPath = useSessionStore((s) => s.projectPath)

  // Files-tab navigation: fetch the current file's folder via api.listTree
  // and keep only text-renderable siblings (same set WorkspaceTree uses for
  // in-drawer opening). Order mirrors what the tree shows, so ↑/↓ walks
  // through files the way the user just saw them listed.
  const [fileSiblings, setFileSiblings] = useState<FileSibling[]>([])
  const currentFilePath = previewSourceTab === 'files' ? previewEntity?.filePath : undefined
  useEffect(() => {
    if (!currentFilePath || !projectPath) {
      setFileSiblings([])
      return
    }
    const absFile = normalizePathSep(currentFilePath)
    const absProj = normalizePathSep(projectPath)
    let relParent: string
    if (absFile === absProj) {
      relParent = ''
    } else if (absFile.startsWith(absProj + '/')) {
      const rel = absFile.slice(absProj.length + 1)
      relParent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    } else {
      // File lives outside the project root — can't list its folder safely.
      setFileSiblings([])
      return
    }
    let cancelled = false
    const api = (window as any).api
    Promise.resolve(api.listTree({ relativePath: relParent, showIgnored: true, limit: 2000 }))
      .then((nodes: any[]) => {
        if (cancelled || !Array.isArray(nodes)) return
        const siblings: FileSibling[] = []
        for (const n of nodes) {
          if (n.type !== 'file') continue
          const ext = (n.name.split('.').pop() || '').toLowerCase()
          if (!NAVIGABLE_FILE_EXTS.has(ext)) continue
          siblings.push({ name: n.name, path: n.path, modifiedAt: n.modifiedAt || Date.now() })
        }
        setFileSiblings(siblings)
      })
      .catch(() => {
        if (!cancelled) setFileSiblings([])
      })
    return () => { cancelled = true }
  }, [currentFilePath, projectPath])

  // Resolve a file path to an EntityItem — reuses the matching data
  // artifact if one exists (so nav'ing into a tracked file keeps its
  // artifact metadata), otherwise builds a raw-file entity, same shape
  // WorkspaceTree.openFile produces.
  const entityForFilePath = useCallback((filePath: string, displayName: string, modifiedAt?: number): EntityItem => {
    const norm = normalizePathSep(filePath)
    const existing = data.find((item) => normalizePathSep(item.filePath || '') === norm)
    if (existing) {
      return {
        ...existing,
        type: 'data',
        title: existing.title || (existing as any).name || displayName,
        filePath,
      } as EntityItem
    }
    const iso = new Date(modifiedAt || Date.now()).toISOString()
    return {
      id: filePath,
      type: 'data',
      title: displayName,
      filePath,
      tags: [],
      createdAt: iso,
      updatedAt: iso,
    } as EntityItem
  }, [data])

  const fileSiblingEntities: EntityItem[] = useMemo(
    () => fileSiblings.map((s) => entityForFilePath(s.path, s.name, s.modifiedAt)),
    [fileSiblings, entityForFilePath]
  )

  const list: EntityItem[] = (() => {
    switch (previewSourceTab) {
      case 'library':
        return [...notes, ...data]
      case 'papers':
        return papers
      case 'files':
        return fileSiblingEntities
      default:
        return []
    }
  })()

  // Match by filePath when navigating files (ids may drift between raw
  // file entities and tracked data artifacts); otherwise match by id.
  const currentIndex = (() => {
    if (!previewEntity) return -1
    if (previewSourceTab === 'files' && previewEntity.filePath) {
      const target = normalizePathSep(previewEntity.filePath)
      return list.findIndex((item) => normalizePathSep(item.filePath || '') === target)
    }
    return list.findIndex((item) => item.id === previewEntity.id)
  })()
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
  const drawerWidth = useUIStore((s) => s.drawerWidth)
  const setDrawerWidth = useUIStore((s) => s.setDrawerWidth)
  const refreshAll = useEntityStore((s) => s.refreshAll)

  const previewEditorFocused = useUIStore((s) => s.previewEditorFocused)
  const markdownEditMode = useUIStore((s) => s.markdownEditMode)
  const toggleMarkdownEditMode = useUIStore((s) => s.toggleMarkdownEditMode)
  const nav = usePreviewNavigation()

  // Drag-to-resize the drawer's left edge. Captures start width + cursor X
  // on mousedown, then adjusts drawerWidth as the cursor moves. Clamping
  // lives in the store (setDrawerWidth), so we don't re-derive bounds here.
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const handleEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    dragStateRef.current = { startX: e.clientX, startWidth: drawerWidth }
    document.body.style.cursor = 'ew-resize'
    e.preventDefault()
  }, [drawerWidth])
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragStateRef.current) return
      const dx = dragStateRef.current.startX - e.clientX
      setDrawerWidth(dragStateRef.current.startWidth + dx)
    }
    const onUp = () => {
      if (dragStateRef.current) document.body.style.cursor = ''
      dragStateRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setDrawerWidth])

  const entity = rawEntity ? { ...rawEntity } : null

  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [baselineMarkdown, setBaselineMarkdown] = useState('')
  const [editorSeedMarkdown, setEditorSeedMarkdown] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileType, setFileType] = useState<'text' | 'external' | 'csv' | null>(null)
  const [loading, setLoading] = useState(false)
  const [externalMarkdown, setExternalMarkdown] = useState<string | undefined>(undefined)
  // Marp rendering: null = follow detection (slides if marp, source if not).
  // A user click on the header toggle explicitly sets 'slides' or 'source'
  // for the current entity. Reset when the entity changes.
  const [viewModeOverride, setViewModeOverride] = useState<'source' | 'slides' | null>(null)
  const resolvedAbsPathRef = useRef<string | null>(null)
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
    setViewModeOverride(null)
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

  useEffect(() => {
    baselineRef.current = baselineMarkdown
  }, [baselineMarkdown])

  // Per-mode scroll memory for view/edit toggles. The three layouts —
  // slide cards, rendered Milkdown, raw CodeMirror — have unrelated DOM
  // heights, so sharing scrollTop would land each toggle in the wrong
  // place. We remember each mode's last position independently and
  // restore on toggle. Resets on entity change so each file starts at
  // the top.
  type ScrollMode = 'rendered' | 'raw' | 'slides'
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const modeScrollRef = useRef<Record<ScrollMode, number>>({ rendered: 0, raw: 0, slides: 0 })
  useEffect(() => {
    modeScrollRef.current = { rendered: 0, raw: 0, slides: 0 }
  }, [entity?.id])

  // Auto-reload when agent modifies the currently previewed markdown file
  useEffect(() => {
    if (!entity?.filePath) return
    const ext = getExtension(entity.filePath)
    if (ext !== 'md' && ext !== 'markdown') return

    const api = (window as any).api
    const unsub = api.onFileCreated((changedPath: string) => {
      if (!resolvedAbsPathRef.current) return
      if (changedPath !== resolvedAbsPathRef.current) return

      api.readFile(entity.filePath).then((res: any) => {
        if (!res.success || typeof res.content !== 'string') return
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
    if (!entity?.id || entity.filePath) return

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
  const isInlineEditable = !entity.filePath
  const isEditable = isInlineEditable || isFileMarkdown
  const isDirty = isEditable && normalizeMarkdown(draftMarkdown) !== normalizeMarkdown(baselineMarkdown)

  // Bare-remark (Milkdown's underlying parser) has no frontmatter plugin
  // and will mangle YAML frontmatter on the first round-trip: the opening
  // `---` becomes a thematic break, the closing `---` becomes a setext
  // heading underline, and the directives get absorbed into a heading's
  // text. Saving from the editor would then write that corrupted shape
  // back to disk. Instead, we peel the frontmatter off whatever the user
  // loaded, hand only the body to Milkdown, and re-prepend the block on
  // every state transition so the file on disk stays intact. The block
  // itself is never edited from this panel — advanced frontmatter edits
  // happen through the file's source in an external tool.
  const { frontmatterBlock, body: baselineBody } = useMemo(
    () => splitFrontmatter(baselineMarkdown),
    [baselineMarkdown]
  )
  const isMarpFile = useMemo(() => isMarpFrontmatter(frontmatterBlock), [frontmatterBlock])

  // `draftMarkdown` always carries the full file (frontmatter + body)
  // so dirty detection, save, and external flows stay uniform. The body
  // subset is what Milkdown actually sees and emits.
  const draftBody = useMemo(() => {
    if (!frontmatterBlock) return draftMarkdown
    return draftMarkdown.startsWith(frontmatterBlock)
      ? draftMarkdown.slice(frontmatterBlock.length)
      : splitFrontmatter(draftMarkdown).body
  }, [draftMarkdown, frontmatterBlock])

  const editorSeedBody = useMemo(() => splitFrontmatter(editorSeedMarkdown).body, [editorSeedMarkdown])
  const externalBody = useMemo(() => {
    if (externalMarkdown === undefined) return undefined
    return splitFrontmatter(externalMarkdown).body
  }, [externalMarkdown])

  const slides = useMemo(
    () => (isMarpFile ? splitSlides(draftBody) : []),
    [isMarpFile, draftBody]
  )

  const effectiveViewMode: 'source' | 'slides' =
    viewModeOverride ?? (isMarpFile ? 'slides' : 'source')
  const showSlideView = isMarpFile && effectiveViewMode === 'slides'

  // Resolve which scroll-memory slot the current view/edit combo writes
  // to. `slides` collapses both edit modes (the Marp slide view doesn't
  // expose an editor); the source view splits along WYSIWYG vs raw so
  // toggling between them snaps back to where each one was last left.
  const scrollMode: ScrollMode = effectiveViewMode === 'slides'
    ? 'slides'
    : (markdownEditMode === 'raw' ? 'raw' : 'rendered')

  // Continuously record scroll position for the current mode so that
  // toggling at any moment returns the user to where they were. The
  // listener is re-attached when the mode flips so each mode's key in
  // modeScrollRef only receives scroll events while that mode is live.
  useEffect(() => {
    const el = scrollContentRef.current
    if (!el) return
    const onScroll = () => {
      modeScrollRef.current[scrollMode] = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollMode])

  // Restore remembered scroll on mode change. rAF delays the write until
  // after the new content has laid out; a second pass covers Milkdown's
  // async hydration (the editor Suspense-loads and its content height
  // lands a tick later, which can clamp an early scrollTop to 0).
  useEffect(() => {
    const target = modeScrollRef.current[scrollMode] ?? 0
    const apply = () => {
      if (scrollContentRef.current) scrollContentRef.current.scrollTop = target
    }
    const raf = requestAnimationFrame(apply)
    const retry = window.setTimeout(apply, 200)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(retry)
    }
  }, [scrollMode, entity?.id])
  const seedFp = buildFingerprint(editorSeedBody)
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

  const handleSave = async () => {
    if (!isEditable || !isDirty) return

    const nextMarkdown = draftMarkdown

    // Enforce character limit for agent.md
    if (entity.id === 'agent-md' && nextMarkdown.length > 5000) {
      setSaveError('agent.md cannot exceed 5,000 characters.')
      return
    }

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
            ? 't-text-error-soft border-[var(--color-status-error-soft)] bg-[var(--color-status-error)]/10'
            : 't-text-accent border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
        }`}
        >
          {saveError || saveSuccess}
        </div>
      )}

      <div className="border t-border rounded-lg overflow-hidden">
        <Suspense fallback={<div className="px-3 py-2 text-xs t-text-muted">Loading markdown editor...</div>}>
          {markdownEditMode === 'raw' ? (
            // Raw mode shows the *full* file (frontmatter + body) in
            // CodeMirror so the user can verify every character on disk.
            // The save flow expects draftMarkdown to be the full file, so
            // onChange writes it through directly without re-prepending.
            // Seeded from the live draft (not baseline) so unsaved edits
            // made in rendered mode survive the toggle.
            <LazySourceMarkdownEditor
              editorId={`${editorKey}:raw`}
              initialMarkdown={draftMarkdown || baselineMarkdown}
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
          ) : (
            <LazyMilkdownMarkdownEditor
              editorId={`${editorKey}:rendered`}
              initialMarkdown={draftBody || baselineBody}
              externalMarkdown={externalBody}
              baseDir={dirnameOf(entity.filePath)}
              onChange={(markdown) => {
                setDraftMarkdown((frontmatterBlock ?? '') + markdown)
                if (saveError) setSaveError(null)
              }}
              onFocusChange={setPreviewEditorFocused}
              onSaveShortcut={() => {
                void handleSave()
              }}
            />
          )}
        </Suspense>
      </div>
      {entity.id === 'agent-md' && (
        <span className={`text-[10px] ${draftMarkdown.length > 5000 ? 't-text-error-soft' : 't-text-muted'}`}>
          {draftMarkdown.length} / 5,000
        </span>
      )}
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
              className="px-4 py-2 rounded t-bg-accent hover:opacity-90 text-white text-sm"
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
          if (showSlideView) {
            return <MarpSlideView slides={slides} baseDir={dirnameOf(entity.filePath)} />
          }
          return renderMarkdownEditor()
        }
        return (
          <pre className="text-xs whitespace-pre-wrap break-words t-text font-mono leading-relaxed">{fileContent}</pre>
        )
      }

      return <p className="text-xs t-text-muted">{entity.filePath}</p>
    }

    if (isInlineEditable) {
      if (showSlideView) {
        return <MarpSlideView slides={slides} baseDir={dirnameOf(entity.filePath)} />
      }
      return renderMarkdownEditor()
    }

    const content = entity.content || entity.abstract || entity.valueText || 'No content available.'
    const mdBaseDir = dirnameOf(entity.filePath)
    return (
      <div
        className="md-prose"
        style={{
          color: 'var(--color-text)',
          fontFamily: READING_FONT,
          fontSize: '14px',
          lineHeight: 1.55,
        }}
      >
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          components={{
            // Rewrite relative / absolute disk paths to workspace-asset://
            // URLs so images actually load. Remote URLs pass through.
            img: ({ src, alt, ...rest }) => (
              <img
                src={resolveMarkdownImageUrl(src as string | undefined, mdBaseDir)}
                alt={alt}
                {...rest}
              />
            )
          }}
        >
          {typeof content === 'string' ? content : JSON.stringify(content, null, 2)}
        </ReactMarkdown>
      </div>
    )
  }

  // Visual signature: a 3px accent rail inset on the drawer's left edge
  // layered with a soft outer drop-shadow — a single colored line that
  // tells the user "this surface is bound to the conversation."
  // pt-10 mirrors the ViewSwitcher's top offset so the drawer's header
  // row lines up with the view tabs (peer-like rather than stacked).
  const drawerBoxShadow =
    'inset 3px 0 0 0 var(--color-accent), -12px 0 32px -14px rgba(0,0,0,0.18)'

  // Editorial crumb displayed above the file name — gives the drawer
  // a clear sense of place ("where did this come from?") without competing
  // with the title itself.
  const crumb = entity.filePath
    ? `files · ${(getExtension(entity.filePath) || 'file').toLowerCase()}`
    : `library · ${entity.type}`

  // System serif stack for the reading surface. No external font deps —
  // Iowan Old Style ships with macOS, Charter is wide-fallback, Georgia
  // is universal. The drawer body inherits this; chrome stays sans.
  const READING_FONT = '"Iowan Old Style", "Charter", "Sitka Text", Georgia, serif'

  return (
    <div
      className="absolute top-0 right-0 bottom-0 flex flex-col t-bg-base min-w-0 z-[5] pt-10 transition-[width,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0.24,1)]"
      style={{ width: drawerWidth, boxShadow: drawerBoxShadow }}
      aria-label={`Preview: ${entity.title}`}
    >
      {/* Left-edge drag handle — 6px hit area; a 2px pill shows on hover. */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[6px] cursor-ew-resize group z-[6]"
        style={{ marginLeft: -3 }}
        onMouseDown={handleEdgeMouseDown}
        title="Drag to resize"
        aria-hidden="true"
      >
        <div className="absolute left-[3px] top-1/2 -translate-y-1/2 w-[2px] h-9 rounded bg-transparent group-hover:t-bg-accent transition-colors" />
      </div>

      <header className="px-5 pt-3.5 pb-3 border-b t-border">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Uppercase mono crumb — editorial metadata line. Tells the
                user where this surface came from ("files · md", "library ·
                note") without fighting the filename for attention. */}
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] t-text-muted mb-1.5 flex items-center gap-2 flex-wrap">
              <span>{crumb}</span>
              {isEditable && isDirty && (
                <span className="normal-case tracking-normal px-1.5 py-0.5 rounded-full bg-[var(--color-status-warning)]/15 t-text-warning">
                  Unsaved
                </span>
              )}
            </div>
            {/* Title row — serif, display-size. Gives the drawer a
                distinct typographic voice from the chat's sans ui. */}
            <div className="flex items-center gap-2 min-w-0">
              {typeIcons[entity.type] || null}
              <h2
                className="min-w-0 truncate t-text"
                style={{
                  fontFamily: READING_FONT,
                  fontSize: '17px',
                  lineHeight: 1.2,
                  fontWeight: 500,
                  letterSpacing: '-0.012em',
                }}
              >
                {entity.title}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0 pt-1">
            {nav.canNavigate && (
              <div className="flex items-center gap-0.5 mr-1">
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
            {isEditable && (
              <button
                onClick={() => void handleSave()}
                disabled={!isDirty}
                className={`p-1 rounded transition-colors ${
                  isDirty ? 't-text-accent-soft hover:t-text-accent' : 't-text-muted opacity-50'
                }`}
                title={isDirty ? 'Save markdown (Cmd/Ctrl+S)' : 'No changes to save'}
              >
                <Save size={14} />
              </button>
            )}
            {isEditable && !showSlideView && (
              <button
                onClick={toggleMarkdownEditMode}
                className="p-1 rounded t-text-muted t-bg-hover transition-colors"
                title={markdownEditMode === 'raw' ? 'Switch to rendered editor' : 'Edit raw markdown'}
                aria-pressed={markdownEditMode === 'raw'}
              >
                {markdownEditMode === 'raw' ? <Eye size={14} /> : <Code size={14} />}
              </button>
            )}
            {isMarpFile && (
              <button
                onClick={() => setViewModeOverride(showSlideView ? 'source' : 'slides')}
                className="p-1 rounded t-text-muted t-bg-hover transition-colors"
                title={showSlideView ? 'Edit source' : 'View as slides'}
                aria-pressed={showSlideView}
              >
                {showSlideView ? <FileText size={14} /> : <Presentation size={14} />}
              </button>
            )}
            <button
              onClick={handleClosePreview}
              className="p-1 rounded t-text-muted t-bg-hover transition-colors"
              title="Close preview (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </header>

      {entity.type === 'paper' && (
        <div className="px-4 py-2 border-b t-border text-xs t-text-secondary space-y-1">
          {entity.authors?.length > 0 && <p>Authors: {entity.authors.join(', ')}</p>}
          {entity.year && <p>Year: {entity.year}</p>}
          {entity.venue && <p>Venue: {entity.venue}</p>}
          {entity.doi && <p>DOI: <a href={`https://doi.org/${entity.doi}`} target="_blank" rel="noreferrer" className="t-text-accent-soft hover:underline">{entity.doi}</a></p>}
          {entity.citationCount != null && <p>Citations: {entity.citationCount}</p>}
          {entity.url && <p>URL: <a href={entity.url} target="_blank" rel="noreferrer" className="t-text-accent-soft hover:underline break-all">{entity.url}</a></p>}
          {entity.pdfUrl && <p>PDF: <a href={entity.pdfUrl} target="_blank" rel="noreferrer" className="t-text-accent-soft hover:underline break-all">{entity.pdfUrl}</a></p>}
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
              <summary className="cursor-pointer hover:t-text-accent-soft">BibTeX</summary>
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

      <div ref={scrollContentRef} className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
        {renderContent()}
      </div>

      {/* Footer strip — a quiet signature. The pulsing accent dot plus
          "Bound to chat" tells the user the drawer isn't a modal popup
          but a live surface tied to the conversation: when the agent
          edits the file in the background, this view reloads in place. */}
      <footer className="shrink-0 px-5 py-2.5 border-t t-border flex items-center justify-between gap-3 text-[10px] font-mono uppercase tracking-[0.12em] t-text-muted">
        <span className="inline-flex items-center gap-2 min-w-0 truncate">
          <span
            className="inline-block w-[7px] h-[7px] rounded-full t-bg-accent animate-pulse shrink-0"
            aria-hidden="true"
          />
          <span className="truncate">Bound to chat</span>
        </span>
        <span className="truncate shrink-0">
          Drag edge · Esc to close
        </span>
      </footer>
    </div>
  )
}
