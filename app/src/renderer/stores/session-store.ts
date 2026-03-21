import { create } from 'zustand'
import { useChatStore } from './chat-store'
import { useProgressStore } from './progress-store'
import { useActivityStore } from './activity-store'
import { useUIStore, hydratePreferences } from './ui-store'
import { useEntityStore } from './entity-store'
import { useUsageStore } from './usage-store'

interface SessionState {
  sessionId: string
  projectPath: string
  hasProject: boolean
  init: () => Promise<void>
  pickFolder: () => Promise<boolean>
  closeProject: () => Promise<void>
}

const api = (window as any).api

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: '',
  projectPath: '',
  hasProject: false,

  init: async () => {
    const session = await api.getCurrentSession()
    set({
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      hasProject: !!session.projectPath
    })
    if (session.projectPath) {
      await hydratePreferences()
    }
  },

  pickFolder: async () => {
    const result = await api.pickFolder()
    if (result) {
      // Clear all stores before loading new project (same cleanup as closeProject)
      useChatStore.getState().clear()
      useProgressStore.getState().clear()
      useActivityStore.getState().clear()
      useUIStore.getState().reset()
      useEntityStore.getState().reset()
      useUsageStore.getState().resetSession()

      // Briefly toggle hasProject so the App.tsx useEffect([hasProject]) re-fires
      // and re-initializes IPC listeners, entities, chat history, etc.
      set({ hasProject: false, sessionId: '', projectPath: '' })

      // Allow React to process the false state before setting true
      await new Promise((r) => setTimeout(r, 0))

      set({
        sessionId: result.sessionId,
        projectPath: result.projectPath,
        hasProject: true
      })
      await hydratePreferences()
      return true
    }
    return false
  },

  closeProject: async () => {
    // Tell main process to destroy coordinator + reset state
    await api.closeProject()

    // Reset all renderer stores (session store last — triggers FolderGate)
    useChatStore.getState().clear()
    useProgressStore.getState().clear()
    useActivityStore.getState().clear()
    useUIStore.getState().reset()
    useEntityStore.getState().reset()
    useUsageStore.getState().resetSession()

    set({ sessionId: '', projectPath: '', hasProject: false })
  }
}))
