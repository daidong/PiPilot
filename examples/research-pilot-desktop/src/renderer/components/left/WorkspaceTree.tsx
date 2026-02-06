import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
  Search,
  Eye,
  Link,
  Plus,
  Loader2
} from 'lucide-react'
import { useEntityStore } from '../../stores/entity-store'
import { useSessionStore } from '../../stores/session-store'
import { useUIStore } from '../../stores/ui-store'

const api = (window as any).api
const ROW_HEIGHT = 28
const OVERSCAN_ROWS = 10

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
  const viewportRef = useRef<HTMLDivElement>(null)

  const storageKey = useMemo(() => `rp:file-tree:expanded:${projectPath || 'none'}`, [projectPath])

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

  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(Array.from(expanded)))
  }, [expanded, storageKey])

  useEffect(() => {
    refreshRoot()
  }, [showIgnored, refreshRoot])

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

  const addFocus = useCallback(async (node: FileTreeNode) => {
    await api.addFocusFromFile(node.path, 'added from workspace tree', '2h')
    await refreshEntities()
  }, [refreshEntities])

  const createArtifact = useCallback(async (node: FileTreeNode) => {
    await api.createArtifactFromFile(node.path)
    await refreshEntities()
  }, [refreshEntities])

  const linkEvidence = useCallback(async (node: FileTreeNode) => {
    await api.linkEvidenceToTask(node.path, 'linked from workspace tree')
    await refreshEntities()
  }, [refreshEntities])

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

    return (
      <div
        key={row.key}
        className={`group flex items-center gap-1 rounded px-1.5 h-7 text-xs cursor-pointer ${
          isActive ? 'bg-teal-500/20 text-teal-300' : 't-bg-hover t-text-secondary'
        }`}
        style={{ paddingLeft: `${row.depth * 14 + 6}px` }}
        onClick={() => (node.type === 'directory' ? void toggleExpand(node) : openFile(node))}
        title={node.relativePath}
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
        <span className="truncate flex-1">{node.name}</span>
        {node.type === 'file' && (
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              className="p-0.5 rounded t-bg-hover hover:text-teal-400"
              title="Preview file"
              onClick={(e) => { e.stopPropagation(); openFile(node) }}
            >
              <Eye size={11} />
            </button>
            <button
              className="p-0.5 rounded t-bg-hover hover:text-teal-400"
              title="Add file to Focus"
              onClick={(e) => { e.stopPropagation(); void addFocus(node) }}
            >
              <Plus size={11} />
            </button>
            <button
              className="p-0.5 rounded t-bg-hover hover:text-teal-400"
              title="Create Artifact from file"
              onClick={(e) => { e.stopPropagation(); void createArtifact(node) }}
            >
              <File size={11} />
            </button>
            <button
              className="p-0.5 rounded t-bg-hover hover:text-teal-400"
              title="Link as task evidence"
              onClick={(e) => { e.stopPropagation(); void linkEvidence(node) }}
            >
              <Link size={11} />
            </button>
          </div>
        )}
      </div>
    )
  }, [expanded, activePath, toggleExpand, openFile, addFocus, createArtifact, linkEvidence])

  return (
    <section className="h-full min-h-0 flex flex-col border-t t-border">
      <div className="px-3 py-2 border-b t-border">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider t-text-muted">Workspace Files</h3>
          <button
            className="p-1 rounded t-bg-hover t-text-muted hover:text-teal-400"
            onClick={() => void refreshRoot()}
            title="Refresh tree"
          >
            <RefreshCw size={12} />
          </button>
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
        className="flex-1 min-h-0 overflow-y-auto px-1 py-1"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
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
    </section>
  )
}
