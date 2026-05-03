import { create } from 'zustand'
import type { UpdateState } from '../../preload/index'

interface UpdateStoreState extends UpdateState {
  /** User has explicitly chosen "Later" — keep the pill hidden until next ready event. */
  dismissedVersion: string | null
  setState: (state: UpdateState) => void
  dismiss: () => void
  restart: () => Promise<void>
  refresh: () => Promise<void>
}

const api = (window as any).api

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  status: 'idle',
  version: '',
  current: '',
  dismissedVersion: null,

  setState: (state) => {
    const prev = get()
    // Re-arming: a new ready version supersedes any prior dismissal
    const dismissedVersion =
      state.status === 'ready' && prev.dismissedVersion && prev.dismissedVersion !== state.version
        ? null
        : prev.dismissedVersion
    set({ ...state, dismissedVersion })
  },

  dismiss: () => set({ dismissedVersion: get().version }),

  restart: async () => {
    await api.updateQuitAndInstall?.()
  },

  refresh: async () => {
    const state = await api.updateGetState?.()
    if (state) get().setState(state)
  }
}))
