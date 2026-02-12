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
  const [showIgnored, setShowIgnored] = useState(false)
  const [searchResults, setSearchResults] = useState<FileTreeNode[]>([])
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<TreeNodeState>({ byParent: {}, loadingParents: new Set() })
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(280)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [confirmTrashPath, setConfirmTrashPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null) // relativePath being renamed
  const [renameValue, setRenameValue] = useState('')
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const storageKey = useMemo(() => `rp:file-tree:expanded:${projectPath || 'none'}`, [projectPath])

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

  const refreshRoot = useCallback(async () => {
    await loadChildren('')
  }, [loadChildren])

  // Reload root + all currently expanded directories
  const refreshAll = useCallback(async () => {
    const dirs = ['', ...Array.from(expanded)]
    await Promise.all(dirs.map((dir) => loadChildren(dir)))
  }, [expanded, loadChildren])

  useEffect(() => {
    let initialExpanded = new Set<string>()
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as string[]
        initialExpanded = new Set(parsed)
      }
    } catch {
      initialExpanded = new Set()
    }
    setExpanded(initialExpanded)
    // Load root + all previously expanded directories so the tree fully restores
    const dirs = ['', ...Array.from(initialExpanded)]
    void Promise.all(dirs.map((dir) => loadChildren(dir)))
  }, [storageKey, loadChildren])

  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(Array.from(expanded)))
  }, [expanded, storageKey])

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

  const handleNewFile = useCallback(async (parentRelPath: string) => {
    const name = prompt('File name:')
    if (!name?.trim()) return
    const relPath = parentRelPath ? `${parentRelPath}/${name.trim()}` : name.trim()
    const result = await api.createFile(relPath)
    if (result.success) {
      if (parentRelPath) {
        const next = new Set(expanded)
        next.add(parentRelPath)
        setExpanded(next)
      }
      await loadChildren(parentRelPath)
    }
  }, [expanded, loadChildren])

  const handleNewFolder = useCallback(async (parentRelPath: string) => {
    const name = prompt('Folder name:')
    if (!name?.trim()) return
    const relPath = parentRelPath ? `${parentRelPath}/${name.trim()}` : name.trim()
    const result = await api.createDir(relPath)
    if (result.success) {
      if (parentRelPath) {
        const next = new Set(expanded)
        next.add(parentRelPath)
        setExpanded(next)
      }
      await loadChildren(parentRelPath)
    }
  }, [expanded, loadChildren])

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

  const renderVisibleRow = useCallback((row: VisibleRow) => {
    if (row.kind === 'loading') {
      return (
        <div
          key={row.key}
          className="flex items-center gap-1 text-xs t-text-muted h-7"
          style={{ paddingLeft: `${row.depth * 14 + 26}px` }}
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

    return (
      <div
        key={row.key}
        className={`group flex items-center gap-1 rounded px-1.5 h-7 text-xs cursor-pointer ${
          isDropTarget
            ? 'ring-2 ring-blue-400/60 bg-blue-50/20 dark:bg-blue-900/20'
            : isActive
              ? 'bg-teal-500/20 text-teal-300'
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
          <Folder size={12} className="shrink-0 text-amber-500" />
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
            className="flex-1 bg-transparent outline-none border-b border-teal-400 text-xs t-text"
          />
        ) : (
          <span className="truncate flex-1">{node.name}</span>
        )}
        <div className="hidden group-hover:flex items-center gap-0.5">
          {node.type === 'file' && (
            <>
              <button
                className="p-0.5 rounded t-bg-hover hover:text-teal-400"
                title="Preview file"
                onClick={(e) => { e.stopPropagation(); openFile(node) }}
              >
                <Eye size={11} />
              </button>
              <button
                className="p-0.5 rounded t-bg-hover hover:text-teal-400"
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
                ? 'text-red-500 bg-red-500/20 animate-pulse'
                : 'text-red-400/70 hover:text-red-500'
            }`}
            title={confirmTrashPath === node.relativePath ? 'Click again to confirm' : 'Move to trash'}
            onClick={(e) => { e.stopPropagation(); void handleTrashClick(node) }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    )
  }, [expanded, activePath, dropTargetPath, confirmTrashPath, renaming, renameValue, toggleExpand, openFile, createArtifact, handleTrashClick, handleContextMenu, handleRowDragOver, handleRowDragLeave, handleRowDrop, handleRenameKeyDown, commitRename])

  return (
    <section className="h-full min-h-0 flex flex-col border-t t-border">
      <div className="px-3 py-2 border-b t-border">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider t-text-muted">Workspace Files</h3>
          <div className="flex items-center gap-0.5">
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:text-teal-400"
              onClick={() => void handleNewFile('')}
              title="New File"
            >
              <FilePlus size={12} />
            </button>
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:text-teal-400"
              onClick={() => void handleNewFolder('')}
              title="New Folder"
            >
              <FolderPlus size={12} />
            </button>
            <button
              className="p-1 rounded t-bg-hover t-text-muted hover:text-teal-400"
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
            className="w-full bg-transparent text-xs outline-none t-text"
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
        className={`flex-1 min-h-0 overflow-y-auto px-1 py-1 ${dropTargetPath === '__root__' ? 'ring-2 ring-inset ring-blue-400/60 bg-blue-50/10 dark:bg-blue-900/10' : ''}`}
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
            className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:t-bg-hover flex items-center gap-2"
            onClick={() => { void handleTrashClick(contextMenu.node); setContextMenu(null) }}
          >
            <Trash2 size={11} /> Trash
          </button>
        </div>
      )}
    </section>
  )
}
