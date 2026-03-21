import React, { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
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
import { useUsageStore, type UsageEvent } from './stores/usage-store'

const api = (window as any).api

function FolderGate() {
  const pickFolder = useSessionStore((s) => s.pickFolder)
  const refreshEntities = useEntityStore((s) => s.refreshAll)

  const handlePick = async () => {
    const picked = await pickFolder()
    if (picked) {
      await refreshEntities()
    }
  }

  return (
    <div className="flex h-screen w-screen t-bg-base t-text items-center justify-center">
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />
      <div className="text-center max-w-sm px-8">
        {/* Branded mark */}
        <div className="relative mx-auto mb-8 w-fit">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-2) 100%)',
              boxShadow: '0 8px 32px var(--color-accent-2-muted)',
            }}
          >
            <span className="text-white text-xl font-bold tracking-tight">
              P
            </span>
          </div>
          <div
            className="absolute -inset-2 rounded-3xl opacity-15 blur-xl -z-10"
            style={{ background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))' }}
          />
        </div>

        <h1
          className="text-2xl font-semibold mb-2 tracking-tight"
        >
          Research Pilot
        </h1>
        <p className="t-text-secondary text-[13px] mb-8 leading-relaxed">
          Open a project folder to begin. Your notes, papers, and data will live
          in a <code className="px-1 py-0.5 rounded t-bg-surface text-xs font-mono">.research-pilot</code> directory.
        </p>
        <button
          onClick={handlePick}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white text-sm font-medium
                     hover:opacity-90 transition-all duration-200"
          style={{
            background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-2) 100%)',
            boxShadow: '0 4px 16px var(--color-accent-2-muted)',
          }}
        >
          <FolderOpen size={16} />
          Open Project Folder
        </button>
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
      useUsageStore.getState().resetRun()
    })
    const unsubActivity = api.onActivity((event: any) => {
      useActivityStore.getState().push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ...event
      })
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

    return () => {
      unsub1()
      unsub2()
      unsub3()
      unsub4()
      unsub5()
      unsub6()
      unsubActivity()
      unsubActivityClear()
      unsubSkillLoaded()
      unsubUsage()
    }
  }, [hasProject])

  // Listen for menu-triggered Close Project
  useEffect(() => {
    const unsub = api.onProjectClosed(() => {
      useSessionStore.getState().closeProject()
    })
    return unsub
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (previewEditorFocused) return

      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        useChatStore.getState().clear()
        useUIStore.getState().setIdle(true)
        useUIStore.getState().closePreview()
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
      // Ctrl+` or Cmd+` → Toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault()
        useUIStore.getState().toggleTerminal()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewEntity, previewEditorFocused])

  // Show folder gate if no project selected
  if (!hasProject) {
    return <FolderGate />
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen w-screen t-bg-base t-text">
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
      </div>
    </ErrorBoundary>
  )
}
