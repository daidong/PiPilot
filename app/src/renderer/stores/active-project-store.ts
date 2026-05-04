/**
 * Active project store — caches the canonical-paper file set.
 *
 * Surfaces "is this path part of the LaTeX paper compiled by main.tex?"
 * to UI consumers (AuditSidebar marker, Library badge, etc.). The data
 * is the same `CanonicalPaper` shape as lib/active-project (LaTeX dep
 * walk result), serialized as arrays across IPC.
 *
 * Per axiom A2/A3 this is *labeling* state, not filtering state — UI
 * uses it to add markers and ranking, never to hide rows. Returns null
 * when no LaTeX root is found in the project; consumers must degrade
 * gracefully (skip the marker, no badge, etc.).
 */

import { create } from 'zustand'

const api = (window as any).api

export interface CanonicalPaperView {
  rootPath: string
  texFiles: string[]
  bibFiles: string[]
  images: string[]
  otherAssets: string[]
  allFiles: string[]
}

interface ActiveProjectState {
  canonical: CanonicalPaperView | null
  /** Memoized Set form of allFiles for O(1) membership checks. */
  allFilesSet: Set<string>
  loading: boolean
  error: string | null
  load: (hintPath?: string) => Promise<void>
  /** True if the workspace-relative path is part of the canonical paper. */
  isCanonical: (path: string) => boolean
}

export const useActiveProjectStore = create<ActiveProjectState>((set, get) => ({
  canonical: null,
  allFilesSet: new Set(),
  loading: false,
  error: null,

  load: async (hintPath?: string) => {
    set({ loading: true, error: null })
    try {
      const r = await api?.activeProjectGet?.(hintPath)
      if (!r?.success) {
        set({ canonical: null, allFilesSet: new Set(), loading: false, error: r?.error ?? null })
        return
      }
      const cp = r.canonicalPaper as CanonicalPaperView | null
      set({
        canonical: cp,
        allFilesSet: cp ? new Set(cp.allFiles) : new Set(),
        loading: false
      })
    } catch (err: any) {
      set({ canonical: null, allFilesSet: new Set(), loading: false, error: err?.message ?? null })
    }
  },

  isCanonical: (path: string): boolean => {
    if (!path) return false
    const set = get().allFilesSet
    if (set.size === 0) return false   // no canonical → nothing is "canonical"
    return set.has(path)
  }
}))
