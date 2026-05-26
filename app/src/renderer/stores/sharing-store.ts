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
import { getDebugConflictFiles, getDebugMergedContent } from './debug-conflict-fixtures'

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
  /**
   * DEBUG ONLY — set by `injectDebugConflict()` (Cmd+Shift+D). Causes
   * `loadConflictDetails` / `aiMerge` / `resolveConflict` to skip IPC and use
   * the canned fixture data + a synthetic merge. Off in normal operation.
   */
  debugMode: boolean
  /**
   * DEBUG ONLY — when true (and debugMode is also true), `aiMerge` waits 4s
   * before returning the canned merged content. Used to exercise the progress
   * UI without burning real LLM tokens.
   */
  slowMergeSim: boolean

  refresh: () => Promise<void>
  checkPreflight: () => Promise<SharingPreflight | null>
  share: (opts: ShareOptions) => Promise<ShareResult | null>
  sync: () => Promise<SyncResult | null>
  poll: () => Promise<void>
  invite: (login: string) => Promise<MemberOpResult | null>
  removeMember: (login: string) => Promise<MemberOpResult | null>
  loadConflictDetails: () => Promise<void>
  aiMerge: (file: ConflictFile) => Promise<{ ok: boolean; content?: string; error?: string }>
  resolveConflict: (resolutions: ConflictResolution[]) => Promise<SyncResult | null>
  dismissConflict: () => void
  /** Cmd+Shift+D — populate with canned fixtures. No-op if a real conflict is already up. */
  injectDebugConflict: () => void
  /** Toggle the 4-second AI-merge stall used to exercise the progress UI. */
  setSlowMergeSim: (value: boolean) => void
  reset: () => void
}

// Resolve at call time (not at module load) so the store works even if it loads
// before the preload bridge attaches, and so tests can stub `window.api`.
const getApi = () => (typeof window === 'undefined' ? undefined : (window as any).api)

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
  debugMode: false,
  slowMergeSim: false,

  refresh: async () => {
    const api = getApi()
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
    const api = getApi()
    if (!api?.sharingPreflight) return null
    const preflight = await api.sharingPreflight()
    set({ preflight })
    return preflight
  },

  share: async (opts) => {
    const api = getApi()
    if (!api?.sharingShare) return null
    const result = await api.sharingShare(opts)
    if (result?.ok) await get().refresh()
    return result
  },

  sync: async () => {
    const api = getApi()
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
      // A successful sync clears the "updates available" hint, any stale access
      // flag, AND any prior conflict — otherwise a resolved-then-successful sync
      // would leave the pill stuck on "Conflict".
      if (result?.ok) set({ conflict: null, conflictFiles: [], updatesAvailable: false, accessRevoked: false })
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
    const api = getApi()
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
      // Fold in the fresh LOCAL ahead/uncommitted snapshot so the pill flips to
      // "N to push" after files are created — without a full (network) refresh().
      if (res?.sync) {
        const cur = get().status
        if (cur) set({ status: { ...cur, sync: res.sync } })
      }
    } catch {
      /* poll is best-effort */
    }
  },

  invite: async (login) => {
    const api = getApi()
    if (!api?.sharingInvite) return null
    const result = await api.sharingInvite(login)
    if (result?.ok) await get().refresh()
    return result
  },

  removeMember: async (login) => {
    const api = getApi()
    if (!api?.sharingRemoveMember) return null
    const result = await api.sharingRemoveMember(login)
    if (result?.ok) await get().refresh()
    return result
  },

  loadConflictDetails: async () => {
    // Debug-injected fixtures are already in place — don't let real IPC clobber them.
    if (get().debugMode) return
    const api = getApi()
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
    if (get().debugMode) {
      if (get().slowMergeSim) await new Promise<void>((r) => setTimeout(r, 4000))
      return { ok: true, content: getDebugMergedContent(file) }
    }
    const api = getApi()
    if (!api?.sharingAiMerge) return { ok: false, error: 'unavailable' }
    return api.sharingAiMerge(file)
  },

  resolveConflict: async (resolutions) => {
    if (get().debugMode) {
      set({ resolving: true, lastError: null })
      await new Promise<void>((r) => setTimeout(r, 500))
      set({
        resolving: false,
        conflict: null,
        conflictFiles: [],
        debugMode: false,
        slowMergeSim: false,
      })
      return { ok: true, conflict: false } as unknown as SyncResult
    }
    const api = getApi()
    if (!api?.sharingResolveConflict || get().resolving) return null
    set({ resolving: true, lastError: null })
    try {
      const result = await api.sharingResolveConflict(resolutions)
      if (result?.ok) {
        set({ conflict: null, conflictFiles: [], updatesAvailable: false, accessRevoked: false })
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

  dismissConflict: () =>
    set({ conflict: null, conflictFiles: [], debugMode: false, slowMergeSim: false }),

  injectDebugConflict: () => {
    if (get().conflict) return // a real conflict (or another debug session) is already up
    const files = getDebugConflictFiles()
    set({
      conflict: { files: files.map((f) => f.path) },
      conflictFiles: files,
      conflictLoading: false,
      debugMode: true,
      slowMergeSim: false,
      lastError: null,
    })
  },

  setSlowMergeSim: (value) => set({ slowMergeSim: !!value }),

  reset: () =>
    set({
      status: null,
      preflight: null,
      updatesAvailable: false,
      lastError: null,
      conflict: null,
      conflictFiles: [],
      conflictLoading: false,
      resolving: false,
      syncing: false,
      accessRevoked: false,
      debugMode: false,
      slowMergeSim: false,
    }),
}))
