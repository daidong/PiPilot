import { create } from 'zustand'

/**
 * Lightweight transient-notification store.
 *
 * Built first for compute plan-ready events (the user was missing plans
 * submitted from chat because nothing nudged them to the Compute tab),
 * but kept general so other one-shot signals can reuse it. The contract
 * is intentionally narrow: a one-line message, an optional click action,
 * an auto-dismiss timer, and a variant for tone.
 *
 * Persistent / sticky status indicators belong in StatusBar pills (see
 * SyncPill, UpdateReadyPill). Use toasts for "something just happened"
 * moments, not for ongoing state.
 */
export type ToastVariant = 'info' | 'success' | 'warning'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  action?: ToastAction
  /**
   * If set, any existing toast with the same key is replaced when this
   * one shows. Useful for events that can fire in bursts (e.g. multiple
   * plan-ready events in rapid succession) — we want the latest one
   * visible, not a stack.
   */
  key?: string
  /** Auto-dismiss after this many ms; defaults to 5000. 0 = sticky. */
  durationMs?: number
  variant?: ToastVariant
}

interface ToastStore {
  toasts: Toast[]
  show: (toast: Omit<Toast, 'id'>) => string
  dismiss: (id: string) => void
  clear: () => void
}

let counter = 0
const nextId = () => `toast-${Date.now()}-${++counter}`

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  show: (toast) => {
    const id = nextId()
    set((s) => {
      // Dedupe by key: a fresh toast with the same key replaces the prior one.
      const filtered = toast.key ? s.toasts.filter((t) => t.key !== toast.key) : s.toasts
      return { toasts: [...filtered, { ...toast, id }] }
    })
    const duration = toast.durationMs ?? 5000
    if (duration > 0) {
      setTimeout(() => {
        // get() is read at fire time so a manual dismiss in the meantime
        // is honored (we won't re-dismiss something already gone).
        get().dismiss(id)
      }, duration)
    }
    return id
  },

  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  clear: () => set({ toasts: [] }),
}))
