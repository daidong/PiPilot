import { create } from 'zustand'
import type { EntityItem } from './entity-store'
import { REASONING_MODELS, SUPPORTED_MODELS, DEFAULT_MODEL } from '../../../../shared-ui/constants'
import { parseModelKey } from '../../../../shared-ui/utils'
import type { ModelOption, ReasoningEffort } from '../../../../shared-ui/types'

type Theme = 'light' | 'dark'
type LeftTab = 'library' | 'files' | 'skills'
type CenterView = 'chat' | 'literature' | 'compute'
export type { LeftTab, CenterView }
export type { ReasoningEffort }

// Re-export from shared-ui for backward compatibility
export { REASONING_MODELS, SUPPORTED_MODELS }
/** @deprecated Use REASONING_MODELS instead */
export const GPT5_REASONING_MODELS = REASONING_MODELS

export interface WorkingFile {
  path: string
  name: string
  accessedAt: number
}

export type ModelId = string

export type { ModelOption }

interface UIState {
  theme: Theme
  leftTab: LeftTab
  centerView: CenterView
  selectedModel: ModelId
  isIdle: boolean
  rightSidebarCollapsed: boolean
  leftSidebarCollapsed: boolean
  workingFiles: WorkingFile[]
  reasoningEffort: ReasoningEffort
  previewEntity: EntityItem | null
  previewSourceTab: LeftTab | null
  previewEditorFocused: boolean

  // Literature view state
  literatureFilter: LiteratureFilter

  // Wiki reader state
  wikiReaderSlug: string | null
  wikiReaderHistory: string[]
  setWikiReaderSlug: (slug: string | null) => void
  wikiReaderBack: () => void

  setReasoningEffort: (level: ReasoningEffort) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setLeftTab: (tab: LeftTab) => void
  setCenterView: (view: CenterView) => void
  setModel: (model: ModelId) => void
  setIdle: (idle: boolean) => void
  toggleRightSidebar: () => void
  terminalVisible: boolean
  terminalAlive: boolean
  toggleTerminal: () => void
  closeTerminal: () => void
  addWorkingFile: (path: string) => void
  setWorkingFiles: (paths: string[]) => void
  clearWorkingFiles: () => void
  reset: () => void
  openPreview: (entity: EntityItem) => void
  closePreview: () => void
  setPreviewEditorFocused: (focused: boolean) => void
  setLiteratureFilter: (filter: Partial<LiteratureFilter>) => void
}

export interface LiteratureFilter {
  search: string
  subTopic: string | null
  sortBy: 'year' | 'relevance' | 'citations' | 'title'
  sortDir: 'asc' | 'desc'
  minScore: number
  source: string | null
  round: string | null
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'light',
  leftTab: 'files',
  centerView: 'chat',
  selectedModel: DEFAULT_MODEL,
  isIdle: true,
  rightSidebarCollapsed: false,
  leftSidebarCollapsed: false,
  terminalVisible: false,
  terminalAlive: false,
  workingFiles: [],
  reasoningEffort: 'medium',
  previewEntity: null,
  previewSourceTab: null,
  previewEditorFocused: false,
  literatureFilter: {
    search: '',
    subTopic: null,
    sortBy: 'year',
    sortDir: 'desc',
    minScore: 0,
    source: null,
    round: null
  },
  wikiReaderSlug: null,
  wikiReaderHistory: [],
  setWikiReaderSlug: (slug) => set((s) => ({
    wikiReaderHistory: s.wikiReaderSlug ? [...s.wikiReaderHistory, s.wikiReaderSlug] : s.wikiReaderHistory,
    wikiReaderSlug: slug,
  })),
  wikiReaderBack: () => set((s) => {
    const history = [...s.wikiReaderHistory]
    const prev = history.pop() ?? null
    return { wikiReaderSlug: prev, wikiReaderHistory: history }
  }),

  setReasoningEffort: (reasoningEffort) => {
    set({ reasoningEffort })
    const api = (window as any).api
    const model = useUIStore.getState().selectedModel
    api?.savePreferences?.({ selectedModel: model, reasoningEffort })
  },
  setTheme: (theme) => {
    set({ theme })
    const api = (window as any).api
    api?.savePreferences?.({ theme })
  },
  toggleTheme: () => {
    const newTheme = useUIStore.getState().theme === 'dark' ? 'light' : 'dark'
    useUIStore.getState().setTheme(newTheme)
  },
  setLeftTab: (leftTab) => set({ leftTab }),
  setCenterView: (centerView) => set({ centerView }),
  setLiteratureFilter: (filter) => set((s) => ({
    literatureFilter: { ...s.literatureFilter, ...filter }
  })),
  setModel: (selectedModel) => {
    set({ selectedModel })
    const api = (window as any).api
    const effort = useUIStore.getState().reasoningEffort
    api?.savePreferences?.({ selectedModel, reasoningEffort: effort })
  },
  setIdle: (isIdle) => set({ isIdle }),
  toggleRightSidebar: () => set((s) => ({ rightSidebarCollapsed: !s.rightSidebarCollapsed })),
  // Ctrl+`: toggle visibility. If not alive yet, also spawn.
  toggleTerminal: () => set((s) => {
    if (!s.terminalAlive) return { terminalVisible: true, terminalAlive: true }
    return { terminalVisible: !s.terminalVisible }
  }),
  // X button: kill terminal entirely
  closeTerminal: () => set({ terminalVisible: false, terminalAlive: false }),
  addWorkingFile: (path) =>
    set((s) => {
      const now = Date.now()
      const existing = s.workingFiles.find((f) => f.path === path)
      if (existing) {
        // Bump accessedAt and re-sort so most-recently-accessed comes first
        const updated = s.workingFiles.map((f) =>
          f.path === path ? { ...f, accessedAt: now } : f
        )
        updated.sort((a, b) => b.accessedAt - a.accessedAt)
        return { workingFiles: updated }
      }
      const name = path.split('/').pop() || path
      // Prepend new file (already most recent) — list stays sorted
      return {
        workingFiles: [{ path, name, accessedAt: now }, ...s.workingFiles]
      }
    }),
  setWorkingFiles: (paths) =>
    set(() => {
      // Deduplicate by path, keeping first occurrence
      const seen = new Set<string>()
      const files: WorkingFile[] = []
      const now = Date.now()
      for (const path of paths) {
        if (!seen.has(path)) {
          seen.add(path)
          const name = path.split('/').pop() || path
          files.push({ path, name, accessedAt: now })
        }
      }
      // Sort by accessedAt descending (most recent first)
      files.sort((a, b) => b.accessedAt - a.accessedAt)
      return { workingFiles: files }
    }),
  clearWorkingFiles: () => set({ workingFiles: [] }),
  reset: () =>
    set({
      leftTab: 'files',
      centerView: 'chat',
      isIdle: true,
      rightSidebarCollapsed: false,
      leftSidebarCollapsed: false,
      workingFiles: [],
      previewEntity: null,
      previewSourceTab: null,
      previewEditorFocused: false,
      literatureFilter: { search: '', subTopic: null, sortBy: 'year', sortDir: 'desc', minScore: 0, source: null, round: null },
      wikiReaderSlug: null,
      wikiReaderHistory: []
    }),
  openPreview: (entity) => set((s) => ({ previewEntity: entity, previewSourceTab: s.leftTab, leftSidebarCollapsed: true, previewEditorFocused: false })),
  closePreview: () => set({ previewEntity: null, previewSourceTab: null, leftSidebarCollapsed: false, previewEditorFocused: false }),
  setPreviewEditorFocused: (previewEditorFocused) => set({ previewEditorFocused })
}))

/** Load persisted model, reasoning, and theme preferences from disk. Call after project path is set. */
export async function hydratePreferences(): Promise<void> {
  const api = (window as any).api
  const prefs = await api?.loadPreferences?.()
  if (!prefs) return
  const updates: Partial<{ selectedModel: string; reasoningEffort: ReasoningEffort; theme: Theme }> = {}
  if (prefs.selectedModel) {
    // Migrate legacy model IDs (e.g. 'gpt-5.4' → 'openai:gpt-5.4')
    const m = prefs.selectedModel as string
    if (!m.includes(':')) {
      const { provider, modelId } = parseModelKey(m)
      updates.selectedModel = `${provider}:${modelId}`
    } else {
      updates.selectedModel = m
    }
  }
  if (prefs.reasoningEffort) updates.reasoningEffort = prefs.reasoningEffort
  if (prefs.theme) updates.theme = prefs.theme
  if (Object.keys(updates).length > 0) useUIStore.setState(updates)
}
