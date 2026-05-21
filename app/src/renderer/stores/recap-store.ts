import { create } from 'zustand'

export interface Recap {
  sessionId: string
  did: string
  next: string
  createdAt: string
}

const RECAP_ENABLED_KEY = 'rp-recap-enabled'

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(RECAP_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

interface RecapState {
  /** Feature toggle (Appearance settings). Persisted in localStorage, default ON. */
  enabled: boolean
  /** The most recent recap (generated in the background while the user is away). */
  latest: Recap | null
  /** Whether the recap card is currently surfaced. */
  visible: boolean
  /**
   * Set when a show was requested before `latest` arrived (the user returned
   * while the background recap was still generating). The next setLatest honors it.
   */
  wantShow: boolean
  /**
   * Whether the CURRENT `latest` has already been surfaced once. Drives the
   * "never show the same recap twice in a row" rule — a recap is shown at most
   * once until a new one replaces it.
   */
  shown: boolean
  /**
   * The assistant message id we last KICKED OFF generation for. Generation is
   * skipped while this matches the conversation's current last assistant
   * message (no fresh turn → no new recap). This is the "waits for fresh
   * activity" half of the dedup.
   */
  lastGenKey: string | null

  setEnabled: (enabled: boolean) => void
  /** Record that generation has been triggered for a given conversation state. */
  markGenerating: (key: string) => void
  /** Store a freshly generated recap. Surfaces only if a show was pending. */
  setLatest: (recap: Recap | null) => void
  /** On project open: load the persisted recap, surface it once, and seed dedup. */
  hydrate: (recap: Recap | null, key: string | null) => void
  /** Return-from-idle: surface the recap if there's an unshown one (else defer). */
  requestShow: () => void
  /** Hide without forgetting (user sent a new message — recap superseded). */
  hide: () => void
  /** User explicitly dismissed the card. */
  dismiss: () => void
  /** Forget per-session state (project close / switch). Keeps the `enabled` pref. */
  clear: () => void
}

export const useRecapStore = create<RecapState>((set) => ({
  enabled: readEnabled(),
  latest: null,
  visible: false,
  wantShow: false,
  shown: false,
  lastGenKey: null,

  setEnabled: (enabled) => {
    try { window.localStorage.setItem(RECAP_ENABLED_KEY, enabled ? '1' : '0') } catch { /* ignore */ }
    set(enabled ? { enabled } : { enabled, visible: false, wantShow: false })
  },

  markGenerating: (key) => set({ lastGenKey: key }),

  setLatest: (recap) =>
    set((s) => {
      if (!recap) return { latest: null, shown: false }
      // A return happened while we were still generating → surface it now.
      if (s.wantShow && s.enabled) return { latest: recap, shown: true, visible: true, wantShow: false }
      return { latest: recap, shown: false }
    }),

  hydrate: (recap, key) =>
    set((s) => ({
      latest: recap,
      lastGenKey: key,
      shown: !!recap,
      visible: s.enabled ? !!recap : false,
      wantShow: false,
    })),

  requestShow: () =>
    set((s) => {
      if (!s.enabled) return s
      if (s.latest && !s.shown) return { visible: true, shown: true, wantShow: false }
      if (!s.latest) return { wantShow: true }
      return s // latest already shown → no consecutive repeat
    }),

  hide: () => set({ visible: false, wantShow: false }),
  dismiss: () => set({ visible: false, wantShow: false }),
  clear: () => set({ latest: null, visible: false, wantShow: false, shown: false, lastGenKey: null }),
}))
