import React, { useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { LeftSidebar } from './components/layout/LeftSidebar'
import { CenterPanel } from './components/layout/CenterPanel'
import { RightSidebar } from './components/layout/RightSidebar'
import { EntityPreviewPanel } from './components/layout/EntityPreviewPanel'
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
      <div className="text-center max-w-md px-8">
        <div className="mx-auto mb-6 w-20 h-20 rounded-2xl t-bg-surface flex items-center justify-center">
          <FolderOpen size={36} className="text-orange-400" />
        </div>
        <h1 className="text-2xl font-semibold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>
          Research Pilot
        </h1>
        <p className="t-text-secondary text-sm mb-8 leading-relaxed">
          Select a project folder to get started. A <code className="px-1.5 py-0.5 rounded t-bg-surface text-xs">.research-pilot</code> directory
          will be created to store your notes, papers, and data.
        </p>
        <button
          onClick={handlePick}
          className="px-6 py-3 rounded-xl bg-orange-500 text-white font-medium hover:bg-orange-400 transition-colors text-sm"
        >
          Open Project Folder
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { appendChunk, finalize } = useChatStore()
  const initSession = useSessionStore((s) => s.init)
  const hasProject = useSessionStore((s) => s.hasProject)
  const refreshEntities = useEntityStore((s) => s.refreshAll)
  const rightCollapsed = useUIStore((s) => s.rightSidebarCollapsed)
  const leftCollapsed = useUIStore((s) => s.leftSidebarCollapsed)
  const previewEntity = useUIStore((s) => s.previewEntity)
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
    const unsub4 = api.onTodoClear(() => {
      useProgressStore.getState().clear()
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

    const unsub1 = api.onStreamChunk((chunk: string) => appendChunk(chunk))
    const unsub2 = api.onAgentDone((result: any) => {
      finalize(result)
      refreshEntities()

      // Extract file paths from agent response and add to working files
      const text = result.response || ''
      const filePathRegex = /(?:^|\s)((?:\/[\w.-]+)+\.\w+)/gm
      let match: RegExpExecArray | null
      while ((match = filePathRegex.exec(text)) !== null) {
        useUIStore.getState().addWorkingFile(match[1])
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
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        useChatStore.getState().clear()
        useUIStore.getState().setIdle(true)
        useUIStore.getState().closePreview()
      }
      // Cmd+Shift+K → Close Project
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'K') {
        e.preventDefault()
        useSessionStore.getState().closeProject()
      }
      if (e.key === 'Escape' && previewEntity) {
        useUIStore.getState().closePreview()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [previewEntity])

  // Show folder gate if no project selected
  if (!hasProject) {
    return <FolderGate />
  }

  return (
    <div className="flex h-screen w-screen t-bg-base t-text">
      {/* Draggable title bar */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-50" />

      {!previewEntity && !leftCollapsed && <LeftSidebar />}
      <CenterPanel />
      {previewEntity
        ? <EntityPreviewPanel />
        : !rightCollapsed && <RightSidebar />
      }
    </div>
  )
}
