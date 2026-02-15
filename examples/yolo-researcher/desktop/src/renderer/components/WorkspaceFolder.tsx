import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Plus,
  FolderPlus,
  Loader2,
  Trash2,
  ExternalLink,
  X as XIcon,
  Pencil,
} from 'lucide-react'

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

function toKey(relativePath: string): string {
  return relativePath || '__root__'
}

interface WorkspaceFolderProps {
  projectPath: string
}

export function WorkspaceFolder({ projectPath }: WorkspaceFolderProps) {
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
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingIn, setCreatingIn] = useState<{ parent: string; type: 'file' | 'directory' } | null>(null)
  const [createName, setCreateName] = useState('')
  const [previewContent, setPreviewContent] = useState<{ name: string; content: string } | null>(null)
  const [openWithOpen, setOpenWithOpen] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const openWithRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  const storageKey = useMemo(() => `yolo:file-tree:expanded:${projectPath || 'none'}`, [projectPath])

  // Close "open with" dropdown on outside click
  useEffect(() => {
    if (!openWithOpen) return
    function handleClick(e: MouseEvent) {
      if (openWithRef.current && !openWithRef.current.contains(e.target as Node)) {
        setOpenWithOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openWithOpen])

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

  // Restore expanded state and load root on mount
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
    refreshRoot()
  }, [storageKey, refreshRoot])

  // Persist expanded state
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(Array.from(expanded)))
  }, [expanded, storageKey])

  // Reload root when showIgnored changes
  useEffect(() => {
    refreshRoot()
  }, [showIgnored, refreshRoot])

  // Debounced search
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

  // Measure viewport
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

  // Reset scroll on query/filter change
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = 0
    setScrollTop(0)
  }, [query, showIgnored, projectPath])

  // Focus rename input
  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingPath])

  // Focus create input
  useEffect(() => {
    if (creatingIn && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creatingIn])

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

    const ext = (node.name.split('.').pop() || '').toLowerCase()
    if (TEXT_EXTENSIONS.has(ext)) {
      // Show inline preview for text files
      api.readTextFile(node.path).then((result: any) => {
        if (result.success) {
          setPreviewContent({ name: node.name, content: result.content })
        } else {
          // Fallback to opening externally
          api.openFile(node.path)
        }
      })
      return
    }

    // Non-text files open with system default app
    api.openFile(node.path)
  }, [])

  const handleTrashClick = useCallback(async (node: FileTreeNode) => {
    if (confirmTrashPath === node.relativePath) {
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
      setConfirmTrashPath(node.relativePath)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmTrashPath(null), 3000)
    }
  }, [confirmTrashPath, loadChildren])

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null)
      return
    }
    const result = await api.renameFile(renamingPath, renameValue.trim())
    setRenamingPath(null)
    if (result.success) {
      const parentRelPath = renamingPath.includes('/')
        ? renamingPath.slice(0, renamingPath.lastIndexOf('/'))
        : ''
      await loadChildren(parentRelPath)
    }
  }, [renamingPath, renameValue, loadChildren])

  const handleCreateSubmit = useCallback(async () => {
    if (!creatingIn || !createName.trim()) {
      setCreatingIn(null)
      return
    }
    const relativePath = creatingIn.parent
      ? `${creatingIn.parent}/${createName.trim()}`
      : createName.trim()
    if (creatingIn.type === 'file') {
      await api.createFile(relativePath)
    } else {
      await api.createDir(relativePath)
    }
    setCreatingIn(null)
    setCreateName('')
    await loadChildren(creatingIn.parent)
  }, [creatingIn, createName, loadChildren])

  // Drag-and-drop helpers
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
      if (file.size > MAX_DROP_FILE_SIZE) continue
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
      if (file.size > MAX_DROP_FILE_SIZE) continue
      const buffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )
      await api.dropToDir(file.name, base64, '')
    }
    await loadChildren('')
  }, [loadChildren])

  const rootNodes = useMemo(() => tree.byParent[toKey('')] || [], [tree.byParent])

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
    const isDropTarget = node.type === 'directory' && dropTargetPath === node.relativePath
    const isRenaming = renamingPath === node.relativePath

    return (
      <div
        key={row.key}
        className={`group flex items-center h-7 px-2 rounded cursor-pointer ${
          isDropTarget
            ? 'ring-2 ring-teal-400/60 bg-teal-50/20 dark:bg-teal-900/20'
            : 'hover:t-bg-hover'
        }`}
        style={{ paddingLeft: `${row.depth * 14 + 8}px` }}
        title={node.relativePath}
        onDragOver={(e) => handleRowDragOver(e, node)}
        onDragLeave={handleRowDragLeave}
        onDrop={(e) => handleRowDrop(e, node)}
      >
        {node.type === 'directory' ? (
          <button
            onClick={() => { toggleExpand(node) }}
            className="mr-1 p-0.5 rounded hover:t-bg-hover"
          >
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="mr-1 w-[13px]" />
        )}

        {node.type === 'directory'
          ? (isExpanded
            ? <FolderOpen size={13} className="mr-1.5 text-amber-500/80 shrink-0" />
            : <Folder size={13} className="mr-1.5 text-amber-500/80 shrink-0" />)
          : <File size={13} className="mr-1.5 t-text-muted shrink-0" />}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="min-w-0 flex-1 text-xs rounded border t-border t-bg-surface px-1 py-0.5 outline-none focus:ring-1"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') setRenamingPath(null)
            }}
            onBlur={() => handleRenameSubmit()}
          />
        ) : (
          <button
            className="min-w-0 flex-1 text-left text-xs truncate"
            onClick={() => {
              if (node.type === 'directory') {
                toggleExpand(node)
              } else {
                openFile(node)
              }
            }}
          >
            {node.name}
          </button>
        )}

        <div className="ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {node.type === 'file' && (
            <button
              className="p-0.5 rounded hover:t-bg-hover"
              title="Open externally"
              onClick={(e) => { e.stopPropagation(); api.openFile(node.path) }}
            >
              <ExternalLink size={11} />
            </button>
          )}
          <button
            className="p-0.5 rounded hover:t-bg-hover"
            title="Rename"
            onClick={(e) => { e.stopPropagation(); setRenamingPath(node.relativePath); setRenameValue(node.name) }}
          >
            <Pencil size={11} />
          </button>
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
  }, [expanded, dropTargetPath, confirmTrashPath, renamingPath, renameValue, openFile, toggleExpand, handleTrashClick, handleRenameSubmit, handleRowDragOver, handleRowDragLeave, handleRowDrop])

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl border t-border t-bg-surface">
      {/* Header */}
      <div className="shrink-0 border-b t-border px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider t-text-muted">Workspace</h3>

          <div className="ml-auto flex items-center gap-1">
            <button
              className="p-1 rounded hover:t-bg-hover"
              title="New file in root"
              onClick={() => { setCreatingIn({ parent: '', type: 'file' }); setCreateName('') }}
            >
              <Plus size={12} />
            </button>
            <button
              className="p-1 rounded hover:t-bg-hover"
              title="New folder in root"
              onClick={() => { setCreatingIn({ parent: '', type: 'directory' }); setCreateName('') }}
            >
              <FolderPlus size={12} />
            </button>
            <button
              className="p-1 rounded hover:t-bg-hover"
              title="Refresh tree"
              onClick={() => refreshRoot()}
            >
              <RefreshCw size={12} />
            </button>

            {/* Open with dropdown */}
            <div ref={openWithRef} className="relative">
              <button
                onClick={() => setOpenWithOpen((v) => !v)}
                className="flex items-center gap-1 rounded-md border t-border-action px-1.5 py-0.5 text-[10px] t-hoverable"
              >
                Open <ChevronDown size={9} />
              </button>
              {openWithOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[120px] rounded-lg border t-border t-bg-surface shadow-lg py-1">
                  {(['finder', 'vscode', 'cursor', 'zed'] as const).map((app) => (
                    <button
                      key={app}
                      onClick={() => { api.openFolderWith(app); setOpenWithOpen(false) }}
                      className="block w-full text-left px-3 py-1.5 text-[11px] t-hoverable capitalize"
                    >
                      {app === 'vscode' ? 'VS Code' : app.charAt(0).toUpperCase() + app.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Search bar + gitignore toggle */}
        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 t-text-muted" />
            <input
              className="w-full h-7 pl-7 pr-2 rounded-md border t-border t-bg-surface text-xs outline-none focus:ring-1"
              placeholder="Search files..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className={`h-7 px-2 rounded-md border text-[10px] ${showIgnored ? 'border-teal-400 text-teal-500' : 't-border t-text-muted'}`}
            onClick={() => setShowIgnored(v => !v)}
            title="Show gitignored files"
          >
            .git
          </button>
        </div>
      </div>

      {/* Create new file/folder input (shown at top when creating in root) */}
      {creatingIn && (
        <div className="px-3 py-1.5 border-b t-border flex items-center gap-1.5">
          {creatingIn.type === 'directory'
            ? <FolderPlus size={12} className="text-amber-500/80 shrink-0" />
            : <Plus size={12} className="t-text-muted shrink-0" />}
          <input
            ref={createInputRef}
            className="flex-1 text-xs rounded border t-border t-bg-surface px-1.5 py-0.5 outline-none focus:ring-1"
            placeholder={creatingIn.type === 'directory' ? 'Folder name...' : 'File name...'}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateSubmit()
              if (e.key === 'Escape') { setCreatingIn(null); setCreateName('') }
            }}
            onBlur={() => handleCreateSubmit()}
          />
        </div>
      )}

      {/* Virtual-scrolled tree */}
      <div
        ref={viewportRef}
        className={`flex-1 min-h-0 overflow-auto ${dropTargetPath === '__root__' ? 'ring-2 ring-inset ring-teal-400/60 bg-teal-50/10 dark:bg-teal-900/10' : ''}`}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onDragOver={handleViewportDragOver}
        onDragLeave={handleViewportDragLeave}
        onDrop={handleViewportDrop}
      >
        {searching ? (
          <div className="p-3 text-xs t-text-muted flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Searching...
          </div>
        ) : rows.length === 0 ? (
          <div className="p-3 text-xs t-text-muted">
            {query.trim() ? 'No files matched.' : 'No files in workspace. Drop files here to upload.'}
          </div>
        ) : (
          <div>
            {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
            {visibleRows.map(renderVisibleRow)}
            {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t t-border px-3 py-1.5 text-[10px] t-text-muted">
        {rows.length} entries
      </div>

      {/* Inline text preview modal */}
      {previewContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPreviewContent(null)}>
          <div
            className="relative w-full max-w-2xl max-h-[80vh] rounded-2xl border t-border t-bg-surface shadow-2xl flex flex-col mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b t-border">
              <span className="text-sm font-medium truncate">{previewContent.name}</span>
              <button
                onClick={() => setPreviewContent(null)}
                className="p-1 rounded hover:t-bg-hover"
              >
                <XIcon size={14} />
              </button>
            </div>
            <pre className="flex-1 min-h-0 overflow-auto p-4 text-xs t-text-secondary whitespace-pre-wrap break-all font-mono">
              {previewContent.content}
            </pre>
          </div>
        </div>
      )}
    </section>
  )
}
