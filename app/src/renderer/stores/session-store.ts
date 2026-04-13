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
  openPath: (projectPath: string) => Promise<boolean>
  closeProject: () => Promise<void>
}

const api = (window as any).api

type OpenResult = { projectPath: string; sessionId: string } | null

/**
 * Shared post-open logic for both pickFolder and openPath: clears every
 * renderer store, toggles hasProject to force the App effect to re-bind
 * listeners, then hydrates preferences for the new project.
 */
async function applyOpenResult(
  set: (partial: Partial<SessionState>) => void,
  result: OpenResult,
): Promise<boolean> {
  if (!result) return false

  useChatStore.getState().clear()
  useProgressStore.getState().clear()
  useActivityStore.getState().clear()
  useUIStore.getState().reset()
  useEntityStore.getState().reset()
  useUsageStore.getState().resetSession()

  // Briefly toggle hasProject so App's useEffect([hasProject]) re-fires
  // and re-initializes IPC listeners, entity fetches, chat history, etc.
  set({ hasProject: false, sessionId: '', projectPath: '' })
  await new Promise((r) => setTimeout(r, 0))

  set({
    sessionId: result.sessionId,
    projectPath: result.projectPath,
    hasProject: true,
  })
  await hydratePreferences()
  return true
}

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
    return applyOpenResult(set, result)
  },

  openPath: async (projectPath: string) => {
    const result = await api.openProjectPath(projectPath)
    return applyOpenResult(set, result)
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
