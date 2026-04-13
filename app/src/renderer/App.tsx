import React, { useEffect, useState, useCallback } from 'react'
import { SettingsModal, type SettingsTab } from './components/settings/SettingsModal'
import { LeftSidebar } from './components/layout/LeftSidebar'
import { CenterPanel } from './components/layout/CenterPanel'
import { EntityPreviewPanel } from './components/layout/EntityPreviewPanel'
import { StatusBar } from './components/layout/StatusBar'
import { TerminalPanel } from './components/layout/TerminalPanel'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import { useChatStore } from './stores/chat-store'
import { useSessionStore } from './stores/session-store'
import { useEntityStore } from './stores/entity-store'
import { useUIStore } from './stores/ui-store'
import { useProgressStore } from './stores/progress-store'
import { useActivityStore } from './stores/activity-store'
import { useToolProgressStore } from './stores/tool-progress-store'
import { useToolEventsStore } from './stores/tool-events-store'
import { useUsageStore, type UsageEvent } from './stores/usage-store'
import { useComputeStore } from './stores/compute-store'

const api = (window as any).api

// ─── Folder gate ──────────────────────────────────────────────────────────
//
// Welcome surface shown when no project is open. Deliberately stripped of
// hero imagery, gradient chrome, and centered marketing composition — the
// dialect here matches the Literature tab: left-aligned, dense, keyboard-
// first. Recent projects are the primary affordance; a new-folder picker
// is the secondary one.

interface RecentProjectEntry {
  path: string
  openedAt: string
  pinned?: boolean
}

/** Format an ISO timestamp as a short relative label. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffMs = Date.now() - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Split a POSIX path into basename + parent. Returns parent without the
 *  trailing slash; both strings may be empty. */
function splitPath(p: string): { name: string; parent: string } {
  const clean = p.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx < 0) return { name: clean, parent: '' }
  return { name: clean.slice(idx + 1), parent: clean.slice(0, idx) }
}

/** Small monospaced keyboard-cap chip. Consistent across the gate surface. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center px-1 py-0 rounded border t-border-subtle t-bg-elevated text-[9.5px] font-mono t-text-secondary leading-[1.4]">
      {children}
    </kbd>
  )
}

function RecentRow({
  entry,
  active,
  confirmRemove,
  onActivate,
  onHover,
}: {
  entry: RecentProjectEntry
  active: boolean
  confirmRemove: boolean
  onActivate: () => void
  onHover: () => void
}) {
  const { name, parent } = splitPath(entry.path)
  return (
    <button
      type="button"
      onClick={onActivate}
      onMouseEnter={onHover}
      className={`group relative w-full text-left flex items-baseline gap-4 py-2 pl-4 pr-3 rounded-sm transition-colors ${
        active ? 't-bg-hover' : ''
      }`}
    >
      {/* Left accent bar — matches Literature tab's wiki-row treatment */}
      <span
        aria-hidden
        className={`absolute left-0 top-1 bottom-1 w-[2px] rounded-full transition-colors ${
          active ? 't-bg-accent' : 'bg-transparent group-hover:t-bg-accent-soft'
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[13px] font-medium truncate ${active ? 't-text' : 't-text-secondary group-hover:t-text'}`}>
            {name}
          </span>
          {entry.pinned && (
            <span className="text-[9px] uppercase tracking-wider t-text-muted">pinned</span>
          )}
        </div>
        {parent && (
          <div className="text-[11px] t-text-muted truncate font-mono mt-0.5">
            {parent}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2 tabular-nums text-[10px] t-text-muted">
        {confirmRemove ? (
          <span className="t-text-error-soft">press ⌫ again</span>
        ) : (
          relativeTime(entry.openedAt)
        )}
      </div>
    </button>
  )
}

function FolderGate({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const pickFolder = useSessionStore((s) => s.pickFolder)
  const openPath = useSessionStore((s) => s.openPath)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  const [recents, setRecents] = useState<RecentProjectEntry[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  // Load recents once on mount. The main process prunes stale paths server
  // side, so whatever comes back is safe to render.
  useEffect(() => {
    let cancelled = false
    api.listRecentProjects?.().then((list: RecentProjectEntry[] | null) => {
      if (!cancelled && Array.isArray(list)) setRecents(list)
    }).catch(() => { /* leave recents empty */ })
    return () => { cancelled = true }
  }, [])

  const handleOpen = useCallback(async (path: string) => {
    if (opening) return
    setOpening(true)
    try {
      const ok = await openPath(path)
      if (ok) await refreshEntities()
    } finally {
      setOpening(false)
    }
  }, [openPath, refreshEntities, opening])

  const handlePickNew = useCallback(async () => {
    if (opening) return
    setOpening(true)
    try {
      const ok = await pickFolder()
      if (ok) await refreshEntities()
    } finally {
      setOpening(false)
    }
  }, [pickFolder, refreshEntities, opening])

  const handleRemove = useCallback(async (path: string) => {
    await api.removeRecentProject?.(path)
    setRecents((prev) => {
      const next = prev.filter((e) => e.path !== path)
      setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, next.length - 1)))
      return next
    })
    setConfirmRemove(null)
  }, [])

  // Keyboard navigation — arrow keys move focus through the list, ↵ opens
  // the focused entry, ⌫ twice removes it, ⌘O launches the native picker.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        handlePickNew()
        return
      }
      // Cmd+, is handled globally in App for the settings modal.

      if (e.key === 'ArrowDown') {
        if (recents.length === 0) return
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % recents.length)
        setConfirmRemove(null)
      } else if (e.key === 'ArrowUp') {
        if (recents.length === 0) return
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + recents.length) % recents.length)
        setConfirmRemove(null)
      } else if (e.key === 'Enter') {
        if (recents.length === 0) {
          e.preventDefault()
          handlePickNew()
          return
        }
        const target = recents[activeIndex]
        if (target) {
          e.preventDefault()
          handleOpen(target.path)
        }
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (recents.length === 0) return
        const target = recents[activeIndex]
        if (!target) return
        e.preventDefault()
        if (confirmRemove === target.path) {
          handleRemove(target.path)
        } else {
          setConfirmRemove(target.path)
        }
      } else if (e.key === 'Escape') {
        setConfirmRemove(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [recents, activeIndex, confirmRemove, handleOpen, handlePickNew, handleRemove])

  const hasRecents = recents.length > 0

  return (
    <div className="flex h-screen w-screen t-bg-base t-text overflow-hidden">
      {/* Draggable macOS title bar strip */}
      <div className="drag-region fixed top-0 left-0 right-0 h-10 z-50" />

      {/* Left-aligned content column, generously offset from the top-left */}
      <div className="w-full pt-[14vh] pl-[11vw] pr-8 min-h-0 overflow-y-auto">
        <div className="w-full max-w-[32rem]">
          {/* Wordmark — typography only, no glyph */}
          <div className="mb-14">
            <div className="text-[15px] font-semibold t-text tracking-tight leading-none">
              Research Pilot
            </div>
            <div className="text-[11px] t-text-muted mt-1.5 leading-none">
              A research workflow, not a chat window.
            </div>
          </div>

          {/* Section label + recent list */}
          {hasRecents ? (
            <div className="mb-6">
              <div className="flex items-baseline justify-between mb-2 pl-4">
                <span className="text-[10px] uppercase tracking-wider t-text-muted font-medium">
                  Recent projects
                </span>
                <span className="text-[10px] t-text-muted tabular-nums">
                  {recents.length}
                </span>
              </div>
              <div className="flex flex-col">
                {recents.map((entry, i) => (
                  <RecentRow
                    key={entry.path}
                    entry={entry}
                    active={i === activeIndex}
                    confirmRemove={confirmRemove === entry.path}
                    onActivate={() => handleOpen(entry.path)}
                    onHover={() => { setActiveIndex(i); if (confirmRemove !== entry.path) setConfirmRemove(null) }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="mb-8 pl-4">
              <div className="text-[13px] t-text-secondary mb-1">
                No recent projects yet.
              </div>
              <div className="text-[11px] t-text-muted">
                Point at a folder — anything you capture will live in a
                {' '}
                <code className="px-1 py-0.5 rounded t-bg-surface text-[10px] font-mono">.research-pilot</code>
                {' '}
                sibling directory beside it.
              </div>
            </div>
          )}

          {/* New-folder affordance — ghost button, not primary */}
          <div className="pl-4">
            <button
              onClick={handlePickNew}
              disabled={opening}
              className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-md border t-border t-text-secondary hover:t-text hover:t-border-accent-soft text-[12px] transition-colors disabled:opacity-50"
            >
              {hasRecents ? 'Open another folder…' : 'Choose a folder to begin'}
              <Kbd>⌘O</Kbd>
            </button>
          </div>

          {/* Keyboard hint line + settings link */}
          <div className="mt-16 pl-4 flex items-center gap-5 text-[10px] t-text-muted flex-wrap">
            {hasRecents && (
              <>
                <span className="inline-flex items-center gap-1.5"><Kbd>↑↓</Kbd> navigate</span>
                <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd> open</span>
                <span className="inline-flex items-center gap-1.5"><Kbd>⌫</Kbd> remove</span>
              </>
            )}
            <span className="inline-flex items-center gap-1.5"><Kbd>⌘O</Kbd> new folder</span>
            {onOpenSettings && (
              <span className="inline-flex items-center gap-1.5"><Kbd>⌘,</Kbd> settings</span>
            )}
          </div>

          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="mt-10 pl-4 text-[11px] t-text-muted hover:t-text-secondary transition-colors"
            >
              API keys & settings →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const appendChunk = useChatStore((s) => s.appendChunk)
  const finalize = useChatStore((s) => s.finalize)
  const initSession = useSessionStore((s) => s.init)
  const hasProject = useSessionStore((s) => s.hasProject)
  const refreshEntities = useEntityStore((s) => s.refreshAll)
  const leftCollapsed = useUIStore((s) => s.leftSidebarCollapsed)
  const previewEntity = useUIStore((s) => s.previewEntity)
  const previewEditorFocused = useUIStore((s) => s.previewEditorFocused)
  const terminalVisible = useUIStore((s) => s.terminalVisible)
  const terminalAlive = useUIStore((s) => s.terminalAlive)
  const theme = useUIStore((s) => s.theme)

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('api-keys')
  const [authChecked, setAuthChecked] = useState(false)

  // On mount: check if any LLM auth is configured, auto-open settings if not
  useEffect(() => {
    api.hasLlmAuth?.().then((hasAuth: boolean) => {
      if (!hasAuth) {
        setSettingsOpen(true)
        setSettingsTab('api-keys')
      }
      setAuthChecked(true)
    }).catch(() => setAuthChecked(true))
  }, [])

  // Apply theme class to html element
  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.classList.add(theme)
  }, [theme])

  useEffect(() => {
    initSession()
  }, [])

  // Set up IPC listeners only when project is loaded
  useEffect(() => {
    if (!hasProject) return

    refreshEntities()
    useUsageStore.getState().loadPersisted().catch(() => {})

    // Recover real-time state that may have been lost during a renderer remount
    api.getRealtimeSnapshot().then((snapshot: any) => {
      if (snapshot && (snapshot.isStreaming || snapshot.streamingText)) {
        useChatStore.setState({
          streamingText: snapshot.streamingText,
          isStreaming: snapshot.isStreaming,
        })
      }
      if (snapshot && snapshot.progressItems?.length > 0) {
        useProgressStore.setState({ items: snapshot.progressItems })
      }
      if (snapshot && snapshot.activityEvents?.length > 0) {
        // Replay activity events through the store's push method to preserve merge logic
        const store = useActivityStore.getState()
        for (const evt of snapshot.activityEvents) {
          store.push({
            id: evt.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: evt.timestamp || new Date().toISOString(),
            ...evt,
          })
        }
      }
      // Replay tool events for chat-inline card recovery
      if (snapshot && snapshot.toolEvents?.length > 0) {
        const toolStore = useToolEventsStore.getState()
        for (const evt of snapshot.toolEvents) {
          if (evt.type === 'tool-call') {
            toolStore.onToolCall(evt)
          } else if (evt.type === 'tool-result') {
            toolStore.onToolResult(evt)
          }
        }
      }
    })

    // Load chat history from previous session
    api.getCurrentSession().then((session: { sessionId: string }) => {
      useChatStore.getState().loadInitial(session.sessionId)
    })

    // Load project root files into working folder
    api.listRootFiles().then((files: { path: string; name: string }[]) => {
      useUIStore.getState().setWorkingFiles(files.map((f) => f.path))
    })

    const unsub3 = api.onTodoUpdate((item: any) => {
      useProgressStore.getState().upsertItem(item)
    })
    // Progress/todos persist across turns - only clear on explicit reset
    const unsub4 = api.onTodoClear(() => {
      useProgressStore.getState().clear()
    })
    // Activity is per-run - clear on new input
    const unsubActivityClear = api.onActivityClear(() => {
      useActivityStore.getState().clear()
      useToolProgressStore.getState().clearAll()
      useToolEventsStore.getState().clearRun()
      useUsageStore.getState().resetRun()
    })
    const unsubActivity = api.onActivity((event: any) => {
      const enrichedEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ...event
      }
      useActivityStore.getState().push(enrichedEvent)

      // Also feed tool events to the chat-inline store
      if (event.type === 'tool-call') {
        useToolEventsStore.getState().onToolCall(enrichedEvent)
      } else if (event.type === 'tool-result') {
        useToolEventsStore.getState().onToolResult(enrichedEvent)
      }
    })
    const unsubToolProgress = api.onToolProgress((event: any) => {
      useToolProgressStore.getState().reportProgress(event)
      useToolEventsStore.getState().onToolProgress(event)
    })
    const unsubSkillLoaded = api.onSkillLoaded((skillName: string) => {
      useActivityStore.getState().addSkill(skillName)
    })

    const unsub1 = api.onStreamChunk((chunk: string) => appendChunk(chunk))
    const unsub2 = api.onAgentDone((result: any) => {
      finalize(result)
      refreshEntities()

      // Extract file paths from agent response and add to working files
      // Matches both absolute (/foo/bar.txt) and relative (docs/bar.txt) paths
      const text = result.response || ''
      const projectRoot = useSessionStore.getState().projectPath
      const filePathRegex = /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.\w+|(?:\/[\w.-]+)+\.\w+)/gm
      let match: RegExpExecArray | null
      while ((match = filePathRegex.exec(text)) !== null) {
        let filePath = match[1]
        // Normalize relative paths to absolute for consistent deduplication
        if (!filePath.startsWith('/') && projectRoot) {
          filePath = projectRoot + '/' + filePath
        }
        useUIStore.getState().addWorkingFile(filePath)
      }

      // Complete usage tracking for this run
      if (result.usage) {
        useUsageStore.getState().completeRun({
          totalTokens: result.usage.tokens?.totalTokens ?? 0,
          totalCost: result.usage.cost?.totalCost ?? 0,
          cacheHitRate: result.usage.cacheHitRate ?? 0,
          callCount: result.usage.callCount ?? 0
        })
      }
    })
    const unsubUsage = api.onUsage((event: UsageEvent) => {
      useUsageStore.getState().recordCall(event)
    })
    const unsub5 = api.onFileCreated((path: string) => {
      useUIStore.getState().addWorkingFile(path)
    })
    const unsub6 = api.onEntityCreated(() => {
      // Refresh entity lists when agent creates notes/papers
      refreshEntities()
    })

    // Eagerly probe compute environment (only when compute feature is enabled)
    if (api?.isComputeEnabled?.()) {
      api.probeComputeEnvironment?.().catch(() => {})
    }

    // Compute run events
    const unsubComputeUpdate = api.onComputeRunUpdate((event: any) => {
      useComputeStore.getState().updateRun(event.runId, event)
    })
    const unsubComputeComplete = api.onComputeRunComplete((event: any) => {
      useComputeStore.getState().updateRun(event.runId, event)
    })
    const unsubComputeEnv = api.onComputeEnvironment((event: any) => {
      useComputeStore.getState().setEnvironment(event)
    })

    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
      unsubActivity()
      unsubActivityClear()
      unsubToolProgress()
      unsubSkillLoaded()
      unsubUsage()
      unsubComputeUpdate()
      unsubComputeComplete()
      unsubComputeEnv()
    }
  }, [hasProject])

  // Listen for menu-triggered Close Project
  useEffect(() => {
    const unsub = api.onProjectClosed(() => {
      useSessionStore.getState().closeProject()
    })
    return unsub
  }, [])

  // Listen for menu-triggered Export Chat
  useEffect(() => {
    const unsub = api.onExportChat(() => {
      api.exportChat()
    })
    return unsub
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (previewEditorFocused) return

      // Cmd+1 → Chat, Cmd+2 → Literature, Cmd+3 → Compute
      if ((e.metaKey || e.ctrlKey) && e.key === '1') {
        e.preventDefault()
        useUIStore.getState().setCenterView('chat')
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        useUIStore.getState().setCenterView('literature')
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '3' && api?.isComputeEnabled?.()) {
        e.preventDefault()
        useUIStore.getState().setCenterView('compute')
      }
      // Cmd+Shift+K → Close Project
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
        e.preventDefault()
        if (useChatStore.getState().isStreaming) {
          const ok = window.confirm(
            'An agent task is still running. Close project anyway?'
          )
          if (!ok) return
        }
        useSessionStore.getState().closeProject()
      }
      if (e.key === 'Escape' && previewEntity) {
        useUIStore.getState().closePreview()
      }
      // Cmd+Shift+E → Export chat
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        api.exportChat()
      }
      // Ctrl+` or Cmd+` → Toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        useUIStore.getState().toggleTerminal()
      }
      // Cmd+, → Toggle settings (standard macOS Preferences shortcut)
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewEntity, previewEditorFocused])

  // Wait for auth check to complete
  if (!authChecked) {
    return <div className="flex h-screen w-screen t-bg-base t-text items-center justify-center">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
    </div>
  }

  // Settings modal renders at top level — accessible from any state via Cmd+,
  const settingsModal = (
    <SettingsModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      initialTab={settingsTab}
    />
  )

  // Show folder gate if no project selected
  if (!hasProject) {
    return (
      <>
        <FolderGate onOpenSettings={() => { setSettingsTab('api-keys'); setSettingsOpen(true) }} />
        {settingsModal}
      </>
    )
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen w-screen t-bg-base t-text">
        {/* Skip to main content link (C2: WCAG 2.4.1) */}
        <a href="#main-content" className="skip-link">Skip to content</a>
        {/* Draggable title bar */}
        <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />

        {/* Main content area */}
        <div className="flex flex-1 min-h-0">
          {/* Keep LeftSidebar mounted (hidden) when preview is open to preserve
              WorkspaceTree expanded state, scroll position, and loaded children */}
          {!leftCollapsed && (
            <div className={previewEntity ? 'hidden' : 'contents'}>
              <LeftSidebar />
            </div>
          )}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className={`flex min-h-0 ${terminalVisible ? 'flex-[2]' : 'flex-1'}`}>
              <CenterPanel />
              {previewEntity && <EntityPreviewPanel />}
            </div>
            {/* Integrated terminal — stays mounted while alive, hidden when not visible */}
            {terminalAlive && (
              <div
                className="flex-1"
                style={{
                  minHeight: terminalVisible ? 150 : 0,
                  maxHeight: terminalVisible ? '40%' : 0,
                  overflow: 'hidden'
                }}
              >
                <TerminalPanel />
              </div>
            )}
          </div>
        </div>

        {/* Bottom status bar */}
        <StatusBar />

        {/* Settings modal overlay */}
        {settingsModal}
      </div>
    </ErrorBoundary>
  )
}
