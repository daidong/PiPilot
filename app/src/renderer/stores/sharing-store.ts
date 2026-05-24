import { create } from 'zustand'
import type {
  SharingStatus,
  SharingPreflight,
  ShareOptions,
  ShareResult,
  SyncResult,
  MemberOpResult,
  ConflictFile,
  ConflictResolution,
} from '../../preload/index'

/**
 * RFC-013 sharing — renderer store. Mirrors the main-process sharing state and
 * exposes the handful of actions the Settings tab + StatusBar pill drive.
 *
 * Detect-but-never-auto-apply (§14): `poll()` only flips `updatesAvailable`; files
 * change solely when the user clicks Sync (`sync()`).
 */

interface SharingStoreState {
  status: SharingStatus | null
  preflight: SharingPreflight | null
  loading: boolean
  syncing: boolean
  /** Remote is ahead (from the background poll). */
  updatesAvailable: boolean
  /** Last sync error, surfaced inline. Cleared on the next sync. */
  lastError: string | null
  /** Set when a sync hit a genuine co-edited-file clash (§9). */
  conflict: { files: string[] } | null
  /** Extracted base/mine/theirs per conflicted file (loaded for the resolve card). */
  conflictFiles: ConflictFile[]
  conflictLoading: boolean
  resolving: boolean
  /**
   * The remote refused us — this member was removed (or the repo is gone). Sticky:
   * a transient network failure neither sets nor clears it; only a real access
   * signal sets it, and a reachable remote / successful sync clears it.
   */
  accessRevoked: boolean

  refresh: () => Promise<void>
  checkPreflight: () => Promise<SharingPreflight | null>
  share: (opts: ShareOptions) => Promise<ShareResult | null>
  sync: () => Promise<SyncResult | null>
  poll: () => Promise<void>
  invite: (login: string) => Promise<MemberOpResult | null>
  removeMember: (login: string) => Promise<MemberOpResult | null>
  promoteMember: (login: string) => Promise<MemberOpResult | null>
  loadConflictDetails: () => Promise<void>
  aiMerge: (file: ConflictFile) => Promise<{ ok: boolean; content?: string; error?: string }>
  resolveConflict: (resolutions: ConflictResolution[]) => Promise<SyncResult | null>
  dismissConflict: () => void
  reset: () => void
}

const api = (window as any).api

export const useSharingStore = create<SharingStoreState>((set, get) => ({
  status: null,
  preflight: null,
  loading: false,
  syncing: false,
  updatesAvailable: false,
  lastError: null,
  conflict: null,
  conflictFiles: [],
  conflictLoading: false,
  resolving: false,
  accessRevoked: false,

  refresh: async () => {
    if (!api?.sharingStatus) return
    set({ loading: true })
    try {
      const status = await api.sharingStatus()
      set({ status, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  checkPreflight: async () => {
    if (!api?.sharingPreflight) return null
    const preflight = await api.sharingPreflight()
    set({ preflight })
    return preflight
  },

  share: async (opts) => {
    if (!api?.sharingShare) return null
    const result = await api.sharingShare(opts)
    if (result?.ok) await get().refresh()
    return result
  },

  sync: async () => {
    if (!api?.sharingSync || get().syncing) return null
    set({ syncing: true, lastError: null })
    try {
      const result = await api.sharingSync()
      if (result?.conflict) {
        set({ conflict: { files: result.conflictedFiles ?? [] } })
      }
      if (result?.accessDenied) {
        set({ accessRevoked: true, lastError: result.error ?? null })
      } else if (result && !result.ok && !result.conflict) {
        set({ lastError: result.error ?? 'Sync failed.' })
      }
      // A successful sync clears the "updates available" hint and any stale access flag.
      if (result?.ok) set({ updatesAvailable: false, accessRevoked: false })
      await get().refresh()
      return result
    } catch (e: any) {
      set({ lastError: String(e?.message ?? e) })
      return null
    } finally {
      set({ syncing: false })
    }
  },

  poll: async () => {
    if (!api?.sharingPoll) return
    const status = get().status
    if (!status?.shared) return
    try {
      const res = await api.sharingPoll()
      set({ updatesAvailable: !!res?.updatesAvailable })
      // Sticky access flag: a real refusal sets it; a reachable remote clears it;
      // a transient network failure (reachable:false, !accessRevoked) leaves it.
      if (res?.accessRevoked) set({ accessRevoked: true })
      else if (res?.reachable) set({ accessRevoked: false })
    } catch {
      /* poll is best-effort */
    }
  },

  invite: async (login) => {
    if (!api?.sharingInvite) return null
    const result = await api.sharingInvite(login)
    if (result?.ok) await get().refresh()
    return result
  },

  removeMember: async (login) => {
    if (!api?.sharingRemoveMember) return null
    const result = await api.sharingRemoveMember(login)
    if (result?.ok) await get().refresh()
    return result
  },

  promoteMember: async (login) => {
    if (!api?.sharingPromoteMember) return null
    const result = await api.sharingPromoteMember(login)
    if (result?.ok) await get().refresh()
    return result
  },

  loadConflictDetails: async () => {
    if (!api?.sharingConflictDetails) return
    set({ conflictLoading: true })
    try {
      const files = await api.sharingConflictDetails()
      set({ conflictFiles: Array.isArray(files) ? files : [], conflictLoading: false })
    } catch {
      set({ conflictLoading: false })
    }
  },

  aiMerge: async (file) => {
    if (!api?.sharingAiMerge) return { ok: false, error: 'unavailable' }
    return api.sharingAiMerge(file)
  },

  resolveConflict: async (resolutions) => {
    if (!api?.sharingResolveConflict || get().resolving) return null
    set({ resolving: true, lastError: null })
    try {
      const result = await api.sharingResolveConflict(resolutions)
      if (result?.ok) {
        set({ conflict: null, conflictFiles: [], updatesAvailable: false })
      } else if (result?.accessDenied) {
        set({ accessRevoked: true, lastError: result.error ?? null })
      } else if (result && !result.ok) {
        set({ lastError: result.error ?? 'Could not apply the merge.' })
      }
      await get().refresh()
      return result
    } catch (e: any) {
      set({ lastError: String(e?.message ?? e) })
      return null
    } finally {
      set({ resolving: false })
    }
  },

  dismissConflict: () => set({ conflict: null, conflictFiles: [] }),

  reset: () =>
    set({ status: null, preflight: null, updatesAvailable: false, lastError: null, conflict: null, conflictFiles: [], conflictLoading: false, resolving: false, syncing: false, accessRevoked: false }),
}))
