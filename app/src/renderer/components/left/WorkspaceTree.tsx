import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
  Search,
  Eye,
  Plus,
  FolderPlus,
  Loader2,
  Trash2,
  Pencil,
  FilePlus
} from 'lucide-react'
import { useEntityStore } from '../../stores/entity-store'
import { useSessionStore } from '../../stores/session-store'
import { useUIStore } from '../../stores/ui-store'

const api = (window as any).api
const ROW_HEIGHT = 28
const OVERSCAN_ROWS = 10
const MAX_DROP_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'ts', 'js', 'css', 'html', 'yml', 'yaml',
  'toml', 'env', 'sh', 'py', 'cfg', 'ini', 'log', 'csv', 'xml',
  'rst', 'jsx', 'tsx', 'mjs', 'cjs', 'markdown', 'gitignore',
])

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

function toKey(relativePath: string): string {
  return relativePath || '__root__'
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function WorkspaceTree() {
  const { projectPath } = useSessionStore()
  const openPreview = useUIStore((s) => s.openPreview)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const data = useEntityStore((s) => s.data)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  const [query, setQuery] = useState('')
  const [showIgnored, setShowIgnored] = useState(true)
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
  const [renaming, setRenaming] = useState<string | null>(null) // relativePath being renamed
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState<{ parentDir: string; type: 'file' | 'directory' } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
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

  const setParentLoading = useCallback((parentKey: string, loading: boolean) => {
    setTree((state) => {
      const nextLoading = new Set(state.loadingParents)
      if (loading) nextLoading.add(parentKey)
      else nextLoading.delete(parentKey)
      return { ...state, loadingParents: nextLoading }
    })
  }, [])

  const loadChildren = useCallback(async (relativePath: string) => {
    const parentKey = toKey(relativePath)
    setParentLoading(parentKey, true)
    try {
      const children = await api.listTree({
        relativePath,
        showIgnored,
        limit: 2000
      })
      setTree((state) => ({
        ...state,
        byParent: {
          ...state.byParent,
          [parentKey]: children
        }
      }))
    } finally {
      setParentLoading(parentKey, false)
    }
  }, [setParentLoading, showIgnored])

  // Auto-refresh when agent creates/modifies files
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const dirs = ['', ...Array.from(expanded)]
        void Promise.all(dirs.map((dir) => loadChildren(dir)))
      }, 500)
    }

    const unsubFileCreated = api.onFileCreated(scheduleRefresh)
    const unsubAgentDone = api.onAgentDone(scheduleRefresh)
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubFileCreated()
      unsubAgentDone()
    }
  }, [expanded, loadChildren])

  const refreshRoot = useCallback(async () => {
    await loadChildren('')
  }, [loadChildren])

  // Reload root + all currently expanded directories
  const refreshAll = useCallback(async () => {
    const dirs = ['', ...Array.from(expanded)]
    await Promise.all(dirs.map((dir) => loadChildren(dir)))
  }, [expanded, loadChildren])

  // When projectPath changes, reload expanded state and tree data
  useEffect(() => {
    let restored = new Set<string>()
    try {
      const raw = localStorage.getItem(expandedStorageKey)
      if (raw) restored = new Set(JSON.parse(raw) as string[])
    } catch { /* ignore */ }
    setExpanded(restored)
    const dirs = ['', ...Array.from(restored)]
    void Promise.all(dirs.map((dir) => loadChildren(dir)))
  }, [expandedStorageKey, loadChildren])

  // Persist expanded state to localStorage whenever it changes
  useEffect(() => {
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

  const toggleExpand = useCallback(async (node: FileTreeNode) => {
    if (node.type !== 'directory') return
    const next = new Set(expanded)
    if (next.has(node.relativePath)) {
      next.delete(node.relativePath)
      setExpanded(next)
      return
    }
    next.add(node.relativePath)
    setExpanded(next)
    if (!tree.byParent[toKey(node.relativePath)]) {
      await loadChildren(node.relativePath)
    }
  }, [expanded, tree.byParent, loadChildren])

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
    await api.createArtifactFromFile(node.path)
    await refreshEntities()
  }, [refreshEntities])

  const handleTrashClick = useCallback(async (node: FileTreeNode) => {
    if (confirmTrashPath === node.relativePath) {
      // Second click — actually delete
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      setConfirmTrashPath(null)
      const result = await api.trashFile(node.path)
      if (result.success) {
        const parentRelPath = node.relativePath.includes('/')
          ? node.relativePath.slice(0, node.relativePath.lastIndexOf('/'))
          : ''
        await loadChildren(parentRelPath)
      }
    } else {
      // First click — arm confirmation
      setConfirmTrashPath(node.relativePath)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmTrashPath(null), 3000)
    }
  }, [confirmTrashPath, loadChildren])

  // Get parent directory relativePath for a given node
  const getParentDir = useCallback((node: FileTreeNode): string => {
    if (node.type === 'directory') return node.relativePath
    return node.relativePath.includes('/')
      ? node.relativePath.slice(0, node.relativePath.lastIndexOf('/'))
      : ''
  }, [])

  const handleNewFile = useCallback((parentRelPath: string) => {
    setCreating({ parentDir: parentRelPath, type: 'file' })
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

  const handleNewFolder = useCallback((parentRelPath: string) => {
    setCreating({ parentDir: parentRelPath, type: 'directory' })
    setCreateValue('')
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
    }
    setCreating(null)
  }, [creating, createValue, loadChildren])

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
    const parentDir = renaming.includes('/')
      ? renaming.slice(0, renaming.lastIndexOf('/'))
      : ''
    const newRelPath = parentDir ? `${parentDir}/${renameValue.trim()}` : renameValue.trim()
    if (newRelPath !== renaming) {
      await api.renameFile(renaming, newRelPath)
      await loadChildren(parentDir)
    }
    setRenaming(null)
  }, [renaming, renameValue, loadChildren])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitRename()
    } else if (e.key === 'Escape') {
      setRenaming(null)
    }
  }, [commitRename])

  // Resolve drop target directory for a given node row
  const getDropDir = useCallback((node: FileTreeNode): string => {
    if (node.type === 'directory') return node.relativePath
    return node.relativePath.includes('/')
      ? node.relativePath.slice(0, node.relativePath.lastIndexOf('/'))
      : ''
  }, [])

  const handleRowDragOver = useCallback((e: React.DragEvent, node: FileTreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropTargetPath(getDropDir(node))
  }, [getDropDir])

  const handleRowDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDropTargetPath(null)
  }, [])

  const handleRowDrop = useCallback(async (e: React.DragEvent, node: FileTreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    const targetRelPath = getDropDir(node)
    setDropTargetPath(null)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      if (file.size > MAX_DROP_FILE_SIZE) {
        console.warn(`Skipping "${file.name}": exceeds 100 MB limit`)
        continue
      }
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )
      await api.dropToDir(file.name, base64, targetRelPath)
    }
    await loadChildren(targetRelPath)
  }, [getDropDir, loadChildren])

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
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      if (file.size > MAX_DROP_FILE_SIZE) {
        console.warn(`Skipping "${file.name}": exceeds 100 MB limit`)
        continue
      }
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )
      await api.dropToDir(file.name, base64, '')
    }
    await loadChildren('')
  }, [loadChildren])

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
        style={{ paddingLeft: `${depth * 1.1 + 0.4}em` }}
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

  const renderVisibleRow = useCallback((row: VisibleRow) => {
    if (row.kind === 'loading') {
      return (
        <div
          key={row.key}
          className="flex items-center gap-1 text-xs t-text-muted h-7"
          style={{ paddingLeft: `${row.depth * 1.1 + 2}em` }}
        >
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
    const showCreateHere = creating && creating.parentDir === node.relativePath && isExpanded

    return (
      <React.Fragment key={row.key}>
        <div
          className={`group flex items-center gap-1 rounded px-1.5 h-7 text-xs cursor-pointer ${
            isDropTarget
              ? 'ring-2 ring-[var(--color-accent)]/60 bg-[var(--color-accent)]/10'
              : isActive
                ? 'bg-[var(--color-accent)]/20 t-text-accent-soft'
                : 't-bg-hover t-text-secondary'
          }`}
          style={{ paddingLeft: `${row.depth * 14 + 6}px` }}
          onClick={() => (node.type === 'directory' ? void toggleExpand(node) : openFile(node))}
          onContextMenu={(e) => handleContextMenu(e, node)}
          title={node.relativePath}
          onDragOver={(e) => handleRowDragOver(e, node)}
          onDragLeave={handleRowDragLeave}
          onDrop={(e) => handleRowDrop(e, node)}
        >
          {node.type === 'directory' ? (
            <button className="shrink-0 t-text-muted" onClick={(e) => { e.stopPropagation(); void toggleExpand(node) }}>
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {node.type === 'directory' ? (
            <Folder size={12} className="shrink-0 t-text-warning" />
          ) : (
            <File size={12} className="shrink-0 t-text-muted" />
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={() => void commitRename()}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-transparent outline-none t-focus-ring border-b border-[var(--color-accent-soft)] text-xs t-text"
            />
          ) : (
            <span className="truncate flex-1">{node.name}</span>
          )}
          <div className="hidden group-hover:flex items-center gap-0.5">
            {node.type === 'file' && (
              <>
                <button
                  className="p-0.5 rounded t-bg-hover hover:t-text-accent-soft"
                  title="Preview file"
                  onClick={(e) => { e.stopPropagation(); openFile(node) }}
                >
                  <Eye size={11} />
                </button>
                <button
                  className="p-0.5 rounded t-bg-hover hover:t-text-accent-soft"
                  title="Create Artifact from file"
                  onClick={(e) => { e.stopPropagation(); void createArtifact(node) }}
                >
                  <File size={11} />
                </button>
              </>
            )}
            <button
              className={`p-0.5 rounded ${
                confirmTrashPath === node.relativePath
                  ? 't-text-error bg-[var(--color-status-error)]/20 animate-pulse'
                  : 't-text-error-soft/70 hover:t-text-error'
              }`}
              title={confirmTrashPath === node.relativePath ? 'Click again to confirm' : 'Move to trash'}
              onClick={(e) => { e.stopPropagation(); void handleTrashClick(node) }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
        {showCreateHere && renderCreateInput(row.depth + 1)}
      </React.Fragment>
    )
  }, [expanded, activePath, dropTargetPath, confirmTrashPath, renaming, renameValue, creating, toggleExpand, openFile, createArtifact, handleTrashClick, handleContextMenu, handleRowDragOver, handleRowDragLeave, handleRowDrop, handleRenameKeyDown, commitRename, renderCreateInput])

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
        <label className="mt-1 flex items-center gap-1 text-[11px] t-text-muted">
          <input
            type="checkbox"
            checked={showIgnored}
            onChange={(e) => setShowIgnored(e.target.checked)}
          />
          Show ignored files
        </label>
      </div>

      <div
        ref={viewportRef}
        className={`flex-1 min-h-0 overflow-y-auto px-1 py-1 ${dropTargetPath === '__root__' ? 'ring-2 ring-inset ring-[var(--color-accent)]/60 bg-[var(--color-accent)]/5' : ''}`}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
          <p className="px-2 py-2 text-xs t-text-muted">No visible files in workspace root.</p>
        ) : (
          <div>
            {/* Inline create input at root level */}
            {creating && creating.parentDir === '' && renderCreateInput(0)}
            {topSpacerHeight > 0 && <div style={{ height: `${topSpacerHeight}px` }} />}
            {visibleRows.map((row) => renderVisibleRow(row))}
            {bottomSpacerHeight > 0 && <div style={{ height: `${bottomSpacerHeight}px` }} />}
          </div>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-lg border t-border t-bg-surface shadow-xl py-1"
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
