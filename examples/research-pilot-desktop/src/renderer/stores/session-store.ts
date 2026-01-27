import { create } from 'zustand'

interface SessionState {
  sessionId: string
  projectPath: string
  hasProject: boolean
  init: () => Promise<void>
  pickFolder: () => Promise<boolean>
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
  },

  pickFolder: async () => {
    const result = await api.pickFolder()
    if (result) {
      set({
        sessionId: result.sessionId,
        projectPath: result.projectPath,
        hasProject: true
      })
      return true
    }
    return false
  }
}))
