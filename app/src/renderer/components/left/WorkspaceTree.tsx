import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Eye,
  ExternalLink,
  Copy,
  ClipboardPaste,
  Hash,
  Link2,
  Plus,
  FolderPlus,
  Loader2,
  Trash2,
  Pencil,
  FilePlus
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEntityStore } from '../../stores/entity-store'
import { useSessionStore } from '../../stores/session-store'
import { useUIStore } from '../../stores/ui-store'

const api = (window as any).api
const ROW_HEIGHT = 28
const OVERSCAN_ROWS = 10
const MAX_DROP_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

// HTML is deliberately NOT in this set — clicking an .html file opens it
// in the system default app (usually a browser) so the user can see the
// rendered page, not the source. Same reasoning as PDFs and images.
const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'ts', 'js', 'css', 'yml', 'yaml',
  'toml', 'env', 'sh', 'py', 'cfg', 'ini', 'log', 'csv', 'xml',
  'rst', 'jsx', 'tsx', 'mjs', 'cjs', 'markdown', 'gitignore',
])

// Per-extension icon + tint. Kept as a plain map (not a switch) so it's easy
// to extend; falls back to a generic <File> for anything unmapped. The tint
// classes use the existing theme tokens so light/dark themes work for free.
const FILE_ICON_BY_EXT: Record<string, { Icon: LucideIcon; tint: string }> = {
  // Code
  ts:    { Icon: FileCode, tint: 't-text-info' },
  tsx:   { Icon: FileCode, tint: 't-text-info' },
  js:    { Icon: FileCode, tint: 't-text-warning' },
  jsx:   { Icon: FileCode, tint: 't-text-warning' },
  mjs:   { Icon: FileCode, tint: 't-text-warning' },
  cjs:   { Icon: FileCode, tint: 't-text-warning' },
  py:    { Icon: FileCode, tint: 't-text-info' },
  rs:    { Icon: FileCode, tint: 't-text-warning' },
  go:    { Icon: FileCode, tint: 't-text-info' },
  java:  { Icon: FileCode, tint: 't-text-warning' },
  c:     { Icon: FileCode, tint: 't-text-muted' },
  h:     { Icon: FileCode, tint: 't-text-muted' },
  cpp:   { Icon: FileCode, tint: 't-text-muted' },
  hpp:   { Icon: FileCode, tint: 't-text-muted' },
  sh:    { Icon: FileCode, tint: 't-text-success' },
  bash:  { Icon: FileCode, tint: 't-text-success' },
  zsh:   { Icon: FileCode, tint: 't-text-success' },
  // Web / markup
  html:  { Icon: FileCode, tint: 't-text-warning' },
  htm:   { Icon: FileCode, tint: 't-text-warning' },
  css:   { Icon: FileCode, tint: 't-text-info' },
  scss:  { Icon: FileCode, tint: 't-text-info' },
  // Data
  json:  { Icon: FileJson, tint: 't-text-warning' },
  yaml:  { Icon: FileJson, tint: 't-text-warning' },
  yml:   { Icon: FileJson, tint: 't-text-warning' },
  toml:  { Icon: FileJson, tint: 't-text-warning' },
  xml:   { Icon: FileCode, tint: 't-text-muted' },
  csv:   { Icon: FileSpreadsheet, tint: 't-text-success' },
  tsv:   { Icon: FileSpreadsheet, tint: 't-text-success' },
  xlsx:  { Icon: FileSpreadsheet, tint: 't-text-success' },
  xls:   { Icon: FileSpreadsheet, tint: 't-text-success' },
  // Docs / prose
  md:    { Icon: FileText, tint: 't-text-accent-soft' },
  markdown: { Icon: FileText, tint: 't-text-accent-soft' },
  txt:   { Icon: FileText, tint: 't-text-secondary' },
  rst:   { Icon: FileText, tint: 't-text-secondary' },
  pdf:   { Icon: FileText, tint: 't-text-error-soft' },
  doc:   { Icon: FileText, tint: 't-text-info' },
  docx:  { Icon: FileText, tint: 't-text-info' },
  tex:   { Icon: FileText, tint: 't-text-info' },
  bib:   { Icon: FileText, tint: 't-text-muted' },
  // Images
  png:   { Icon: FileImage, tint: 't-text-accent-soft' },
  jpg:   { Icon: FileImage, tint: 't-text-accent-soft' },
  jpeg:  { Icon: FileImage, tint: 't-text-accent-soft' },
  gif:   { Icon: FileImage, tint: 't-text-accent-soft' },
  svg:   { Icon: FileImage, tint: 't-text-accent-soft' },
  webp:  { Icon: FileImage, tint: 't-text-accent-soft' },
  bmp:   { Icon: FileImage, tint: 't-text-accent-soft' },
  ico:   { Icon: FileImage, tint: 't-text-accent-soft' },
  // Media
  mp4:   { Icon: FileVideo, tint: 't-text-info' },
  mov:   { Icon: FileVideo, tint: 't-text-info' },
  webm:  { Icon: FileVideo, tint: 't-text-info' },
  mp3:   { Icon: FileAudio, tint: 't-text-info' },
  wav:   { Icon: FileAudio, tint: 't-text-info' },
  flac:  { Icon: FileAudio, tint: 't-text-info' },
  // Archives
  zip:   { Icon: FileArchive, tint: 't-text-warning' },
  tar:   { Icon: FileArchive, tint: 't-text-warning' },
  gz:    { Icon: FileArchive, tint: 't-text-warning' },
  tgz:   { Icon: FileArchive, tint: 't-text-warning' },
  '7z':  { Icon: FileArchive, tint: 't-text-warning' },
  rar:   { Icon: FileArchive, tint: 't-text-warning' },
}

function getFileIcon(name: string): { Icon: LucideIcon; tint: string } {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return FILE_ICON_BY_EXT[ext] ?? { Icon: File, tint: 't-text-muted' }
}

interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  hasChildren?: boolean
  modifiedAt: number
}

interface TreeNodeState {
  byParent: Record<string, FileTreeNode[]>
  loadingParents: Set<string>
}

interface VisibleNodeRow {
  kind: 'node'
  key: string
  node: FileTreeNode
  depth: number
}

interface VisibleLoadingRow {
  kind: 'loading'
  key: string
  depth: number
}

type VisibleRow = VisibleNodeRow | VisibleLoadingRow

interface ContextMenuState {
  x: number
  y: number
  node: FileTreeNode
}

/**
 * Per-row callbacks held in a ref so the memoized <TreeRow> never has to
 * re-render when a handler closure is recreated. The ref object itself is
 * stable across renders; only `.current` mutates.
 */
interface RowHandlers {
  toggleExpand: (node: FileTreeNode) => void
  openFile: (node: FileTreeNode) => void
  createArtifact: (node: FileTreeNode) => void
  handleTrashClick: (node: FileTreeNode) => void
  handleContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void
  handleRowDragOver: (e: React.DragEvent, node: FileTreeNode) => void
  handleRowDragLeave: (e: React.DragEvent) => void
  handleRowDrop: (e: React.DragEvent, node: FileTreeNode) => void
  handleRenameKeyDown: (e: React.KeyboardEvent) => void
  commitRename: () => void
  setRenameValue: (v: string) => void
}

function toKey(relativePath: string): string {
  return relativePath || '__root__'
}

function hasLoadedParent(byParent: Record<string, FileTreeNode[]>, parentKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(byParent, parentKey)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Containing directory of a relativePath ('' for a root-level entry). */
function parentOf(relativePath: string): string {
  const i = relativePath.lastIndexOf('/')
  return i >= 0 ? relativePath.slice(0, i) : ''
}

/**
 * Encode an ArrayBuffer to base64 in 32 KB chunks. The previous per-byte
 * `reduce((s, b) => s + String.fromCharCode(b), '')` was O(n²) — dropping a
 * large file (the limit is 100 MB) built a multi-million-char string one byte
 * at a time and froze the renderer. Chunking keeps it O(n) and bounds the
 * temporary string + the `fromCharCode.apply` arg list.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000 // 32 KB
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

interface TreeRowProps {
  node: FileTreeNode
  depth: number
  isExpanded: boolean
  isActive: boolean
  isDropTarget: boolean
  isRenaming: boolean
  confirmTrash: boolean
  renameValue: string
  /**
   * When non-empty, the row highlights matching substrings in the file name.
   * Empty string when no search is active — keeping it a primitive (vs.
   * undefined) means React.memo's shallow compare stays simple.
   */
  highlightQuery: string
  handlersRef: React.MutableRefObject<RowHandlers>
  renameInputRef: React.RefObject<HTMLInputElement | null>
}

/**
 * Wrap every case-insensitive occurrence of `query` in `name` with a
 * <mark> for visual highlighting. Returns the raw string when no query.
 * Cheap enough to call inline; no memo needed because TreeRow itself is
 * memoized and only re-renders when name or highlightQuery change.
 */
function renderHighlighted(name: string, query: string): React.ReactNode {
  const q = query.trim().toLowerCase()
  if (!q) return name
  const lower = name.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  while (cursor < name.length) {
    const idx = lower.indexOf(q, cursor)
    if (idx < 0) {
      parts.push(name.slice(cursor))
      break
    }
    if (idx > cursor) parts.push(name.slice(cursor, idx))
    parts.push(
      <mark
        key={key++}
        className="bg-[var(--color-accent)]/30 t-text-accent-soft rounded-sm px-0.5 -mx-0.5"
      >
        {name.slice(idx, idx + q.length)}
      </mark>
    )
    cursor = idx + q.length
  }
  return parts
}

/**
 * Pure row renderer. Wrapped in React.memo with the default shallow
 * compare — props are either primitives, the stable `handlersRef` object,
 * or the `node` reference (preserved by `childrenEqual`). So a row only
 * re-renders when something visible to it actually changes.
 */
const TreeRow = React.memo(function TreeRow(props: TreeRowProps) {
  const {
    node, depth, isExpanded, isActive, isDropTarget, isRenaming,
    confirmTrash, renameValue, highlightQuery, handlersRef, renameInputRef
  } = props
  // Per-extension icon for files; directory icon/tint encodes expand state.
  const fileIconInfo = node.type === 'file' ? getFileIcon(node.name) : null
  // Indent guides: a vertical 1px line every 14px in the row's left padding.
  // Single repeating-gradient = no extra DOM per depth level.
  const guideStyle: React.CSSProperties = depth > 0
    ? {
        paddingLeft: `${depth * 14 + 6}px`,
        backgroundImage:
          'repeating-linear-gradient(to right, transparent 0 13px, var(--color-border) 13px 14px)',
        backgroundSize: `${depth * 14}px 100%`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0 0'
      }
    : { paddingLeft: '6px' }
  // "You are here" marker: a 2px teal bar on the active row. Drawn as an inset
  // shadow so it adds no width (no layout shift) and follows the row's rounded
  // corners — the Linear-style selection cue called out in .impeccable.md §6.
  if (isActive) guideStyle.boxShadow = 'inset 2px 0 0 var(--color-accent)'
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.type === 'directory' ? isExpanded : undefined}
      aria-selected={isActive}
      className={`group flex items-center gap-1 rounded px-1.5 h-7 text-xs cursor-pointer ${
        isDropTarget
          ? 'ring-2 ring-[var(--color-accent)]/60 bg-[var(--color-accent)]/10'
          : isActive
            ? 'bg-[var(--color-accent)]/15 t-text-accent-soft'
            : 't-bg-hover t-text-secondary'
      }`}
      style={guideStyle}
      onClick={() => {
        const h = handlersRef.current
        node.type === 'directory' ? h.toggleExpand(node) : h.openFile(node)
      }}
      onContextMenu={(e) => handlersRef.current.handleContextMenu(e, node)}
      title={node.relativePath}
      onDragOver={(e) => handlersRef.current.handleRowDragOver(e, node)}
      onDragLeave={(e) => handlersRef.current.handleRowDragLeave(e)}
      onDrop={(e) => handlersRef.current.handleRowDrop(e, node)}
    >
      {node.type === 'directory' ? (
        <button
          className="shrink-0 t-text-muted"
          onClick={(e) => { e.stopPropagation(); handlersRef.current.toggleExpand(node) }}
        >
          <ChevronRight
            size={12}
            className={`transition-transform duration-150 ease-out ${isExpanded ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {node.type === 'directory' ? (
        // Color encodes open/closed state: muted when collapsed, teal accent
        // when expanded. Avoids borrowing the status-warning color decoratively
        // (.impeccable.md §3) and reinforces the chevron's expand affordance.
        isExpanded ? (
          <FolderOpen size={12} className="shrink-0 t-text-accent-soft" />
        ) : (
          <Folder size={12} className="shrink-0 t-text-muted" />
        )
      ) : fileIconInfo ? (
        <fileIconInfo.Icon size={12} className={`shrink-0 ${fileIconInfo.tint}`} />
      ) : null}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => handlersRef.current.setRenameValue(e.target.value)}
          onKeyDown={(e) => handlersRef.current.handleRenameKeyDown(e)}
          onBlur={() => handlersRef.current.commitRename()}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent outline-none t-focus-ring border-b border-[var(--color-accent-soft)] text-xs t-text"
        />
      ) : (
        <span className="truncate flex-1" title={node.name}>
          {renderHighlighted(node.name, highlightQuery)}
        </span>
      )}
      <div className="hidden group-hover:flex items-center gap-0.5">
        {node.type === 'file' && (
          <>
            <button
              className="p-0.5 rounded t-bg-hover hover:t-text-accent-soft"
              title="Preview file"
              onClick={(e) => { e.stopPropagation(); handlersRef.current.openFile(node) }}
            >
              <Eye size={11} />
            </button>
            <button
              className="p-0.5 rounded t-bg-hover hover:t-text-accent-soft"
              title="Create Artifact from file"
              onClick={(e) => { e.stopPropagation(); handlersRef.current.createArtifact(node) }}
            >
              <File size={11} />
            </button>
          </>
        )}
        <button
          className={`p-0.5 rounded ${
            confirmTrash
              ? 't-text-error bg-[var(--color-status-error)]/20 animate-pulse'
              : 't-text-error-soft/70 hover:t-text-error'
          }`}
          title={confirmTrash ? 'Click again to confirm' : 'Move to trash'}
          onClick={(e) => { e.stopPropagation(); handlersRef.current.handleTrashClick(node) }}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
})

/**
 * Returns true if `a` and `b` describe the same children — same length,
 * same name+type+modifiedAt+hasChildren in the same order. We use this to
 * preserve the array reference when fs.watch fires for an unrelated reason
 * (editor saving an open file, log rotation, etc.) so downstream `useMemo`s
 * don't invalidate and the tree doesn't visibly re-render.
 */
function childrenEqual(a: FileTreeNode[], b: FileTreeNode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.name !== y.name ||
      x.type !== y.type ||
      x.modifiedAt !== y.modifiedAt ||
      x.hasChildren !== y.hasChildren ||
      x.relativePath !== y.relativePath
    ) {
      return false
    }
  }
  return true
}


export function WorkspaceTree() {
  const { projectPath } = useSessionStore()
  const openPreview = useUIStore((s) => s.openPreview)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const leftTab = useUIStore((s) => s.leftTab)
  const centerView = useUIStore((s) => s.centerView)
  const data = useEntityStore((s) => s.data)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  const [query, setQuery] = useState('')
  // Default OFF: hide dotfiles + .gitignore matches so the tree shows just the
  // user's real working files. Toggle on to reveal .git/.research-pilot/etc.
  const [showIgnored, setShowIgnored] = useState(false)
  const [searchResults, setSearchResults] = useState<FileTreeNode[]>([])
  const [searching, setSearching] = useState(false)
  const expandedStorageKey = useMemo(() => `rp:file-tree:expanded:${projectPath || 'none'}`, [projectPath])
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandedStorageKey)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch { /* ignore */ }
    return new Set()
  })
  const [tree, setTree] = useState<TreeNodeState>({ byParent: {}, loadingParents: new Set() })
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(280)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [confirmTrashPath, setConfirmTrashPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [clipboardNode, setClipboardNode] = useState<FileTreeNode | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null) // relativePath being renamed
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState<{ parentDir: string; type: 'file' | 'directory' } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const pendingScrollTopRef = useRef(0)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [contextMenu])

  // Close context menu when navigating away (tabs stay mounted, so clear stale UI)
  useEffect(() => {
    setContextMenu(null)
  }, [leftTab, centerView])

  // Keep the context menu inside the viewport. Measured after layout (before
  // paint, so no flicker) and nudged back imperatively — the raw click coords
  // would otherwise spill off the right/bottom edge near the window border.
  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!contextMenu || !el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const left = Math.max(pad, Math.min(contextMenu.x, window.innerWidth - rect.width - pad))
    const top = Math.max(pad, Math.min(contextMenu.y, window.innerHeight - rect.height - pad))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [contextMenu])

  // Auto-focus rename input
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renaming])

  // Auto-focus create input
  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creating])

  // Transient inline message (e.g. a dropped file was skipped or a write
  // failed). Auto-clears so it never lingers as stale state.
  const showNotice = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 5000)
  }, [])

  // Clear pending timers/frames on unmount so they don't fire on a gone tree.
  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  // Coalesce the high-frequency scroll stream into one state update per frame.
  // The raw `onScroll` fired setScrollTop on every event, re-rendering the
  // whole tree several times per frame; rAF caps that at the display rate
  // while always flushing the latest position.
  const handleViewportScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = e.currentTarget.scrollTop
    if (scrollRafRef.current != null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      setScrollTop(pendingScrollTopRef.current)
    })
  }, [])

  const setParentLoading = useCallback((parentKey: string, loading: boolean) => {
    setTree((state) => {
      const nextLoading = new Set(state.loadingParents)
      if (loading) nextLoading.add(parentKey)
      else nextLoading.delete(parentKey)
      return { ...state, loadingParents: nextLoading }
    })
  }, [])

  // `silent: true` skips the loading row that normally replaces a parent's
  // children while the IPC is in flight. Use it for refresh paths that
  // already have data on screen — flipping that data into a single
  // "Loading..." row temporarily collapses the tree height, and the
  // browser will clamp scrollTop to fit the smaller scrollHeight, which
  // looks like the panel scrolling itself back to the top. First-time
  // expansions stay loud (default silent=false) so the user gets clear
  // feedback that something's happening.
  const loadChildren = useCallback(async (
    relativePath: string,
    opts: { silent?: boolean } = {}
  ) => {
    const parentKey = toKey(relativePath)
    const hadChildren = hasLoadedParent(byParentRef.current, parentKey)
    const showLoading = !opts.silent || !hadChildren
    if (showLoading) setParentLoading(parentKey, true)
    try {
      const children: FileTreeNode[] = await api.listTree({
        relativePath,
        showIgnored,
        limit: 2000
      })
      setTree((state) => {
        const prev = state.byParent[parentKey]
        // Preserve reference when nothing changed — keeps `rows` useMemo
        // stable so the visible list doesn't re-render on noisy fs events.
        if (prev && childrenEqual(prev, children)) return state
        return {
          ...state,
          byParent: {
            ...state.byParent,
            [parentKey]: children
          }
        }
      })
    } catch (err) {
      // Surface the failure instead of leaving it as an unhandled rejection;
      // callers fire this with `void` or inside Promise.all.
      console.error('Failed to load workspace tree', err)
      showNotice('Could not load files. Try refreshing.')
    } finally {
      if (showLoading) setParentLoading(parentKey, false)
    }
  }, [setParentLoading, showIgnored, showNotice])

  // `expandedRef` lets the auto-refresh effect read the latest expanded set
  // without re-subscribing every time the user expands/collapses a folder.
  // Previously `[expanded, loadChildren]` deps caused the IPC listeners to
  // tear down + re-attach on every toggle, contributing to the "lots of
  // random refresh" feel.
  const expandedRef = useRef(expanded)
  useEffect(() => { expandedRef.current = expanded }, [expanded])
  const byParentRef = useRef(tree.byParent)
  useEffect(() => { byParentRef.current = tree.byParent }, [tree.byParent])
  const loadingParentsRef = useRef(tree.loadingParents)
  useEffect(() => { loadingParentsRef.current = tree.loadingParents }, [tree.loadingParents])
  const autoLoadAttemptedRef = useRef<Set<string>>(new Set())
  const skipNextExpandedPersistRef = useRef<string | null>(null)

  // Auto-refresh when agent or external editor modifies files. Targeted:
  // when the watcher tells us which parent dirs changed, we only reload
  // those (intersected with currently-expanded dirs + root). When the
  // payload is missing (unknown filename, agent events), fall back to
  // reloading root + all expanded dirs.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingParents: Set<string> | null = new Set()

    const flush = () => {
      debounceTimer = null
      const exp = expandedRef.current
      let dirs: string[]
      if (pendingParents === null) {
        // Sentinel: full refresh requested.
        dirs = ['', ...Array.from(exp)]
      } else {
        // Targeted: only reload root or expanded dirs that actually changed.
        // Skip parents that aren't loaded — they'll be fetched on first expand.
        const visible = new Set<string>(['', ...Array.from(exp)])
        dirs = Array.from(pendingParents).filter((p) => visible.has(p))
      }
      pendingParents = new Set()
      if (dirs.length === 0) return
      // External fs / agent-driven refresh: data is already on screen, so
      // skip the loading row to keep scroll position stable.
      void Promise.all(dirs.map((dir) => loadChildren(dir, { silent: true })))
    }

    const scheduleTargeted = (parents: string[] | null) => {
      if (parents === null) {
        pendingParents = null
      } else if (pendingParents !== null) {
        for (const p of parents) pendingParents.add(p)
      }
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(flush, 500)
    }

    const scheduleFull = () => scheduleTargeted(null)

    // onFileCreated gives us the absolute path. We don't try to resolve it
    // against projectPath here (would need the project root in deps);
    // a full refresh is fine because agent-created files are the user's
    // active intent and they want to see them immediately.
    const unsubFileCreated = api.onFileCreated(scheduleFull)
    const unsubAgentDone = api.onAgentDone(scheduleFull)
    const unsubExternalChange = api.onExternalChange((event: { parents: string[] | null }) => {
      scheduleTargeted(event.parents)
    })
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubFileCreated()
      unsubAgentDone()
      unsubExternalChange()
    }
  }, [loadChildren])

  const refreshRoot = useCallback(async () => {
    await loadChildren('')
  }, [loadChildren])

  // Reload root + all currently expanded directories. Reads `expanded`
  // via the ref so the callback's identity stays stable across user
  // expand/collapse — otherwise the showIgnored effect below sees a new
  // refreshAll on every toggle and triggers a spurious full reload that
  // clamps the viewport's scroll position to the top.
  const refreshAll = useCallback(async () => {
    const dirs = ['', ...Array.from(expandedRef.current)]
    await Promise.all(dirs.map((dir) => loadChildren(dir, { silent: true })))
  }, [loadChildren])

  // When projectPath changes, reload expanded state and tree data
  useEffect(() => {
    autoLoadAttemptedRef.current.clear()
    skipNextExpandedPersistRef.current = expandedStorageKey
    let restored = new Set<string>()
    try {
      const raw = localStorage.getItem(expandedStorageKey)
      if (raw) restored = new Set(JSON.parse(raw) as string[])
    } catch { /* ignore */ }
    setExpanded(restored)
    setTree({ byParent: {}, loadingParents: new Set() })
    const dirs = ['', ...Array.from(restored)]
    void Promise.all(dirs.map((dir) => loadChildren(dir)))
  }, [expandedStorageKey, loadChildren])

  // Re-establish the invariant that every expanded directory has either
  // loaded children or an in-flight load. Persisted expansion state can outlive
  // the in-memory child cache, especially after opening an existing project.
  useEffect(() => {
    const missingDirs = Array.from(expanded).filter((dir) => {
      const parentKey = toKey(dir)
      return (
        !hasLoadedParent(tree.byParent, parentKey) &&
        !tree.loadingParents.has(parentKey) &&
        !autoLoadAttemptedRef.current.has(parentKey)
      )
    })
    if (missingDirs.length === 0) return

    for (const dir of missingDirs) autoLoadAttemptedRef.current.add(toKey(dir))
    void Promise.all(missingDirs.map((dir) => loadChildren(dir)))
  }, [expanded, tree.byParent, tree.loadingParents, loadChildren])

  // Persist expanded state to localStorage whenever it changes
  useEffect(() => {
    if (skipNextExpandedPersistRef.current === expandedStorageKey) {
      skipNextExpandedPersistRef.current = null
      return
    }
    localStorage.setItem(expandedStorageKey, JSON.stringify(Array.from(expanded)))
  }, [expanded, expandedStorageKey])

  useEffect(() => {
    refreshAll()
  }, [showIgnored, refreshAll])

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      if (!query.trim()) {
        setSearchResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        const results = await api.searchTree(query.trim(), { showIgnored, maxResults: 4000 })
        setSearchResults(results)
      } catch (err) {
        console.error('File search failed', err)
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [query, showIgnored])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    setViewportHeight(viewport.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setViewportHeight(entry.contentRect.height)
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = 0
    setScrollTop(0)
  }, [query, showIgnored, projectPath])

  const toggleExpand = useCallback((node: FileTreeNode) => {
    if (node.type !== 'directory') return
    let shouldLoad = false
    setExpanded((prev) => {
      const parentKey = toKey(node.relativePath)
      const hasChildren = hasLoadedParent(byParentRef.current, parentKey)
      const isLoading = loadingParentsRef.current.has(parentKey)
      const next = new Set(prev)
      if (next.has(node.relativePath)) {
        // If restored state says "expanded" but the child cache is missing,
        // treat the click as a repair/load request instead of collapsing.
        if (!hasChildren && !isLoading) {
          shouldLoad = true
          return prev
        }
        next.delete(node.relativePath)
        return next
      }
      next.add(node.relativePath)
      shouldLoad = !hasChildren && !isLoading
      return next
    })
    if (shouldLoad) {
      void loadChildren(node.relativePath)
    }
  }, [loadChildren])

  const openFile = useCallback((node: FileTreeNode) => {
    if (node.type !== 'file') return

    // Smart open: non-text files open with system default app
    const ext = (node.name.split('.').pop() || '').toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) {
      api.openFile(node.path)
      return
    }

    const normalizedNodePath = normalizePath(node.path)
    const existing = data.find(item => normalizePath(item.filePath || '') === normalizedNodePath)
    if (existing) {
      openPreview({
        ...existing,
        type: 'data',
        title: existing.title || existing.name || node.name,
        filePath: node.path
      })
      return
    }

    openPreview({
      id: node.path,
      type: 'data',
      title: node.name,
      filePath: node.path,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }, [data, openPreview])

  const createArtifact = useCallback(async (node: FileTreeNode) => {
    try {
      await api.createArtifactFromFile(node.path)
      await refreshEntities()
    } catch (err) {
      console.error('Failed to create artifact from file', err)
      showNotice(`Could not create artifact from "${node.name}".`)
    }
  }, [refreshEntities, showNotice])

  const handleTrashClick = useCallback(async (node: FileTreeNode) => {
    if (confirmTrashPath === node.relativePath) {
      // Second click — actually delete
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmTrashPath(null)
      const result = await api.trashFile(node.path)
      if (result.success) {
        await loadChildren(parentOf(node.relativePath))
      } else {
        showNotice(`Could not trash "${node.name}": ${result.error ?? 'failed'}`)
      }
    } else {
      // First click — arm confirmation
      setConfirmTrashPath(node.relativePath)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmTrashPath(null), 3000)
    }
  }, [confirmTrashPath, loadChildren, showNotice])

  // Resolves the directory a node acts on: a directory targets itself (drops,
  // "new file here" land inside it); a file targets its containing directory.
  const getParentDir = useCallback((node: FileTreeNode): string => {
    return node.type === 'directory' ? node.relativePath : parentOf(node.relativePath)
  }, [])

  const handleRevealInFinder = useCallback((node: FileTreeNode) => {
    void api.revealInFinder(node.path)
    setContextMenu(null)
  }, [])

  const handleOpenInDefaultApp = useCallback((node: FileTreeNode) => {
    void api.openFile(node.path)
    setContextMenu(null)
  }, [])

  const handleCopyFile = useCallback((node: FileTreeNode) => {
    setClipboardNode(node)
    setContextMenu(null)
  }, [])

  const handlePasteFile = useCallback(async (targetNode: FileTreeNode) => {
    if (!clipboardNode) return
    const destDir = getParentDir(targetNode)
    setContextMenu(null)
    const result = await api.copyItem(clipboardNode.relativePath, destDir)
    if (result.success) {
      await loadChildren(destDir)
    } else {
      showNotice(`Could not paste "${clipboardNode.name}": ${result.error ?? 'failed'}`)
    }
  }, [clipboardNode, getParentDir, loadChildren, showNotice])

  const handleCopyPath = useCallback((node: FileTreeNode) => {
    void navigator.clipboard.writeText(node.path)
    setContextMenu(null)
  }, [])

  const handleCopyRelativePath = useCallback((node: FileTreeNode) => {
    void navigator.clipboard.writeText(node.relativePath)
    setContextMenu(null)
  }, [])

  const startCreate = useCallback((parentRelPath: string, type: 'file' | 'directory') => {
    setCreating({ parentDir: parentRelPath, type })
    setCreateValue('')
    // Expand the parent so the inline input is visible
    if (parentRelPath) {
      setExpanded((prev) => {
        const next = new Set(prev)
        next.add(parentRelPath)
        return next
      })
      if (!tree.byParent[toKey(parentRelPath)]) {
        void loadChildren(parentRelPath)
      }
    }
  }, [tree.byParent, loadChildren])

  const handleNewFile = useCallback((p: string) => startCreate(p, 'file'), [startCreate])
  const handleNewFolder = useCallback((p: string) => startCreate(p, 'directory'), [startCreate])

  const commitCreate = useCallback(async () => {
    if (!creating || !createValue.trim()) {
      setCreating(null)
      return
    }
    const relPath = creating.parentDir
      ? `${creating.parentDir}/${createValue.trim()}`
      : createValue.trim()
    const result = creating.type === 'file'
      ? await api.createFile(relPath)
      : await api.createDir(relPath)
    if (result.success) {
      await loadChildren(creating.parentDir)
    } else {
      showNotice(`Could not create "${createValue.trim()}": ${result.error ?? 'failed'}`)
    }
    setCreating(null)
  }, [creating, createValue, loadChildren, showNotice])

  const handleCreateKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitCreate()
    } else if (e.key === 'Escape') {
      setCreating(null)
    }
  }, [commitCreate])

  const startRename = useCallback((node: FileTreeNode) => {
    setRenaming(node.relativePath)
    setRenameValue(node.name)
    setContextMenu(null)
  }, [])

  const commitRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null)
      return
    }
    const parentDir = parentOf(renaming)
    const newRelPath = parentDir ? `${parentDir}/${renameValue.trim()}` : renameValue.trim()
    if (newRelPath !== renaming) {
      const result = await api.renameFile(renaming, newRelPath)
      if (result.success) {
        await loadChildren(parentDir)
      } else {
        showNotice(`Could not rename to "${renameValue.trim()}": ${result.error ?? 'failed'}`)
      }
    }
    setRenaming(null)
  }, [renaming, renameValue, loadChildren, showNotice])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitRename()
    } else if (e.key === 'Escape') {
      setRenaming(null)
    }
  }, [commitRename])

  const handleRowDragOver = useCallback((e: React.DragEvent, node: FileTreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropTargetPath(getParentDir(node))
  }, [getParentDir])

  const handleRowDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropTargetPath(null)
  }, [])

  // Shared drop ingestion for both per-row and viewport-root drops. Encodes
  // each file, writes it into `targetRelPath`, then reloads that dir once.
  // Files over the size cap or that fail to write are collected and surfaced
  // as a single inline notice instead of failing silently.
  const ingestFiles = useCallback(async (files: File[], targetRelPath: string) => {
    if (files.length === 0) return
    const skipped: string[] = []
    for (const file of files) {
      if (file.size > MAX_DROP_FILE_SIZE) {
        skipped.push(`${file.name} (over 100 MB)`)
        continue
      }
      const buffer = await file.arrayBuffer()
      const result = await api.dropToDir(file.name, arrayBufferToBase64(buffer), targetRelPath)
      if (!result?.success) skipped.push(`${file.name} (${result?.error ?? 'failed'})`)
    }
    await loadChildren(targetRelPath)
    if (skipped.length > 0) showNotice(`Skipped: ${skipped.join(', ')}`)
  }, [loadChildren, showNotice])

  const handleRowDrop = useCallback(async (e: React.DragEvent, node: FileTreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    const targetRelPath = getParentDir(node)
    setDropTargetPath(null)
    await ingestFiles(Array.from(e.dataTransfer.files), targetRelPath)
  }, [getParentDir, ingestFiles])

  const handleViewportDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTargetPath('__root__')
  }, [])

  const handleViewportDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropTargetPath(null)
  }, [])

  const handleViewportDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDropTargetPath(null)
    await ingestFiles(Array.from(e.dataTransfer.files), '')
  }, [ingestFiles])

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileTreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  const rootNodes = useMemo(() => tree.byParent[toKey('')] || [], [tree.byParent])
  const activePath = normalizePath(previewEntity?.filePath || '')

  const rows = useMemo(() => {
    if (query.trim()) {
      return searchResults.map((node) => ({
        kind: 'node',
        key: `search:${node.relativePath}:${node.type}`,
        node,
        depth: 0
      } satisfies VisibleRow))
    }

    const flattened: VisibleRow[] = []
    const walk = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        flattened.push({
          kind: 'node',
          key: `${node.relativePath}:${node.type}`,
          node,
          depth
        })

        if (node.type !== 'directory') continue
        if (!expanded.has(node.relativePath)) continue

        const parentKey = toKey(node.relativePath)
        if (tree.loadingParents.has(parentKey)) {
          flattened.push({
            kind: 'loading',
            key: `${node.relativePath}:loading`,
            depth: depth + 1
          })
          continue
        }

        const children = tree.byParent[parentKey] || []
        walk(children, depth + 1)
      }
    }

    walk(rootNodes, 0)
    return flattened
  }, [query, searchResults, rootNodes, expanded, tree.byParent, tree.loadingParents])

  const totalRows = rows.length
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS)
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS
  )
  const visibleRows = rows.slice(startIndex, endIndex)
  const topSpacerHeight = startIndex * ROW_HEIGHT
  const bottomSpacerHeight = Math.max(0, (totalRows - endIndex) * ROW_HEIGHT)

  const renderCreateInput = useCallback((depth: number) => {
    if (!creating) return null
    return (
      <div
        key="__creating__"
        className="flex items-center gap-1 rounded px-1.5 h-7 text-xs bg-[var(--color-accent)]/10"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <span className="w-3 shrink-0" />
        {creating.type === 'directory' ? (
          <Folder size={12} className="shrink-0 t-text-warning" />
        ) : (
          <File size={12} className="shrink-0 t-text-muted" />
        )}
        <input
          ref={createInputRef}
          value={createValue}
          onChange={(e) => setCreateValue(e.target.value)}
          onKeyDown={handleCreateKeyDown}
          onBlur={() => void commitCreate()}
          placeholder={creating.type === 'file' ? 'filename.ext' : 'folder name'}
          className="flex-1 bg-transparent outline-none t-focus-ring border-b border-[var(--color-accent-soft)] text-xs t-text"
        />
      </div>
    )
  }, [creating, createValue, handleCreateKeyDown, commitCreate])

  // Stable handler bag for <TreeRow>. The ref object is the same across
  // renders; only `.current` is reassigned. Using a ref (not useMemo) means
  // each row gets the latest handler closure without needing the row to
  // re-render when a closure is recreated.
  const handlersRef = useRef<RowHandlers>({} as RowHandlers)
  handlersRef.current = {
    toggleExpand: (node) => { void toggleExpand(node) },
    openFile,
    createArtifact: (node) => { void createArtifact(node) },
    handleTrashClick: (node) => { void handleTrashClick(node) },
    handleContextMenu,
    handleRowDragOver,
    handleRowDragLeave,
    handleRowDrop: (e, node) => { void handleRowDrop(e, node) },
    handleRenameKeyDown,
    commitRename: () => { void commitRename() },
    setRenameValue
  }

  return (
    <section className="h-full min-h-0 flex flex-col border-t t-border">
      <div className="px-3 py-2 border-b t-border">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider t-text-accent-soft">Workspace Files</h3>
          <div className="flex items-center gap-0.5">
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:t-text-accent-soft"
              onClick={() => void handleNewFile('')}
              title="New File"
            >
              <FilePlus size={12} />
            </button>
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:t-text-accent-soft"
              onClick={() => void handleNewFolder('')}
              title="New Folder"
            >
              <FolderPlus size={12} />
            </button>
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:t-text-accent-soft"
              onClick={() => void refreshAll()}
              title="Refresh tree"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1 rounded border t-border px-2 py-1">
          <Search size={12} className="t-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files..."
            aria-label="Filter files"
            className="w-full bg-transparent text-xs outline-none t-focus-ring t-text"
          />
        </div>
        <label className="mt-1 flex items-center gap-1 text-[11px] t-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showIgnored}
            onChange={(e) => setShowIgnored(e.target.checked)}
            // Native checkbox otherwise renders the OS accent (macOS blue),
            // the one element off the teal palette. accentColor pulls it back in.
            style={{ accentColor: 'var(--color-accent)' }}
            className="cursor-pointer"
          />
          Show ignored files
        </label>
        {notice && (
          <p className="mt-1 text-[11px] t-text-error-soft break-words" role="status">
            {notice}
          </p>
        )}
      </div>

      <div
        ref={viewportRef}
        role="tree"
        aria-label="Workspace files"
        className={`flex-1 min-h-0 overflow-y-auto px-1 py-1 ${dropTargetPath === '__root__' ? 'ring-2 ring-inset ring-[var(--color-accent)]/60 bg-[var(--color-accent)]/5' : ''}`}
        style={{ overflowAnchor: 'none' }}
        onScroll={handleViewportScroll}
        onDragOver={handleViewportDragOver}
        onDragLeave={handleViewportDragLeave}
        onDrop={handleViewportDrop}
      >
        {searching ? (
          <div className="flex items-center gap-1 px-2 py-2 text-xs t-text-muted">
            <Loader2 size={11} className="animate-spin" />
            Searching...
          </div>
        ) : query.trim() && rows.length === 0 ? (
          <p className="px-2 py-2 text-xs t-text-muted">No files match "{query}".</p>
        ) : !query.trim() && rootNodes.length === 0 ? (
          <div className="px-2 py-2 text-xs t-text-muted">
            {showIgnored ? (
              'This folder is empty.'
            ) : (
              <>
                No visible files — ignored files are hidden.{' '}
                <button
                  type="button"
                  onClick={() => setShowIgnored(true)}
                  className="t-text-accent hover:underline t-focus-ring rounded"
                >
                  Show ignored files
                </button>
              </>
            )}
          </div>
        ) : (
          <div>
            {/* Inline create input at root level */}
            {creating && creating.parentDir === '' && renderCreateInput(0)}
            <div style={{ height: `${topSpacerHeight}px` }} />
            {visibleRows.map((row) => {
              if (row.kind === 'loading') {
                return (
                  <div
                    key={row.key}
                    className="flex items-center gap-1 text-xs t-text-muted h-7"
                    style={{ paddingLeft: `${row.depth * 14 + 6}px` }}
                  >
                    <span className="w-3 shrink-0" />
                    <Loader2 size={11} className="animate-spin" />
                    Loading...
                  </div>
                )
              }
              const node = row.node
              const isExpanded = node.type === 'directory' && expanded.has(node.relativePath)
              const isActive = !!activePath && normalizePath(node.path) === activePath
              const isDropTarget = node.type === 'directory' && dropTargetPath === node.relativePath
              const isRenaming = renaming === node.relativePath
              const showCreateHere = !!creating && creating.parentDir === node.relativePath && isExpanded
              return (
                <React.Fragment key={row.key}>
                  <TreeRow
                    node={node}
                    depth={row.depth}
                    isExpanded={isExpanded}
                    isActive={isActive}
                    isDropTarget={isDropTarget}
                    isRenaming={isRenaming}
                    confirmTrash={confirmTrashPath === node.relativePath}
                    renameValue={isRenaming ? renameValue : ''}
                    highlightQuery={query.trim()}
                    handlersRef={handlersRef}
                    renameInputRef={renameInputRef}
                  />
                  {showCreateHere && renderCreateInput(row.depth + 1)}
                </React.Fragment>
              )
            })}
            <div style={{ height: `${bottomSpacerHeight}px` }} />
          </div>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] rounded-lg border t-border t-bg-surface shadow-xl py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node.type === 'file' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
              onClick={() => { openFile(contextMenu.node); setContextMenu(null) }}
            >
              <Eye size={11} /> Open
            </button>
          )}
          {contextMenu.node.type === 'file' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
              onClick={() => handleOpenInDefaultApp(contextMenu.node)}
            >
              <ExternalLink size={11} /> Open in Default App
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => handleRevealInFinder(contextMenu.node)}
          >
            <FolderOpen size={11} /> Reveal in Finder
          </button>
          <div className="border-t t-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => handleCopyFile(contextMenu.node)}
          >
            <Copy size={11} /> Copy
          </button>
          {clipboardNode && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
              onClick={() => void handlePasteFile(contextMenu.node)}
            >
              <ClipboardPaste size={11} /> Paste
            </button>
          )}
          <div className="border-t t-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => handleCopyPath(contextMenu.node)}
          >
            <Hash size={11} /> Copy Path
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => handleCopyRelativePath(contextMenu.node)}
          >
            <Link2 size={11} /> Copy Relative Path
          </button>
          <div className="border-t t-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => startRename(contextMenu.node)}
          >
            <Pencil size={11} /> Rename
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => { void handleNewFile(getParentDir(contextMenu.node)); setContextMenu(null) }}
          >
            <FilePlus size={11} /> New File Here
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
            onClick={() => { void handleNewFolder(getParentDir(contextMenu.node)); setContextMenu(null) }}
          >
            <FolderPlus size={11} /> New Folder Here
          </button>
          {contextMenu.node.type === 'file' && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs t-text-secondary hover:t-bg-hover flex items-center gap-2"
              onClick={() => { void createArtifact(contextMenu.node); setContextMenu(null) }}
            >
              <Plus size={11} /> Create Artifact
            </button>
          )}
          <div className="border-t t-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs t-text-error-soft hover:t-bg-hover flex items-center gap-2"
            onClick={() => { void handleTrashClick(contextMenu.node); setContextMenu(null) }}
          >
            <Trash2 size={11} /> Trash
          </button>
        </div>
      )}
    </section>
  )
}
