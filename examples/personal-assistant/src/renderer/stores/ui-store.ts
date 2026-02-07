import { create } from 'zustand'
import type { EntityItem } from './entity-store'

type Theme = 'light' | 'dark'
type LeftTab = 'todos' | 'notes' | 'docs' | 'mail' | 'calendar' | 'focus' | 'notifications'
export type ReasoningEffort = 'high' | 'medium' | 'low' | 'max'

export const REASONING_MODELS = [
  'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano',
  'claude-opus-4-6'
]
/** @deprecated Use REASONING_MODELS instead */
export const GPT5_REASONING_MODELS = REASONING_MODELS

export interface WorkingFile {
  path: string
  name: string
  accessedAt: number
}

export type ModelId = string

export interface ModelOption {
  id: ModelId
  label: string
  provider: string
}

export const SUPPORTED_MODELS: ModelOption[] = [
  // GPT
  { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI' },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'OpenAI' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', provider: 'OpenAI' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  // Anthropic Claude 4.6
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  // Anthropic Claude 4.5
  { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
]

interface UIState {
  theme: Theme
  leftTab: LeftTab
  selectedModel: ModelId
  isIdle: boolean
  rightSidebarCollapsed: boolean
  leftSidebarCollapsed: boolean
  workingFiles: WorkingFile[]
  reasoningEffort: ReasoningEffort
  previewEntity: EntityItem | null
  setReasoningEffort: (level: ReasoningEffort) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setLeftTab: (tab: LeftTab) => void
  setModel: (model: ModelId) => void
  setIdle: (idle: boolean) => void
  toggleRightSidebar: () => void
  addWorkingFile: (path: string) => void
  setWorkingFiles: (paths: string[]) => void
  clearWorkingFiles: () => void
  reset: () => void
  openPreview: (entity: EntityItem) => void
  closePreview: () => void
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'light',
  leftTab: 'todos',
  selectedModel: 'gpt-5.2',
  isIdle: true,
  rightSidebarCollapsed: false,
  leftSidebarCollapsed: false,
  workingFiles: [],
  reasoningEffort: 'medium',
  previewEntity: null,

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
  setModel: (selectedModel) => {
    set({ selectedModel })
    const api = (window as any).api
    const effort = useUIStore.getState().reasoningEffort
    api?.savePreferences?.({ selectedModel, reasoningEffort: effort })
  },
  setIdle: (isIdle) => set({ isIdle }),
  toggleRightSidebar: () => set((s) => ({ rightSidebarCollapsed: !s.rightSidebarCollapsed })),
  addWorkingFile: (path) =>
    set((s) => {
      if (s.workingFiles.some((f) => f.path === path)) {
        return s
      }
      const name = path.split('/').pop() || path
      return {
        workingFiles: [{ path, name, accessedAt: Date.now() }, ...s.workingFiles]
      }
    }),
  setWorkingFiles: (paths) =>
    set(() => {
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
      return { workingFiles: files }
    }),
  clearWorkingFiles: () => set({ workingFiles: [] }),
  reset: () =>
    set({
      leftTab: 'todos',
      isIdle: true,
      rightSidebarCollapsed: false,
      leftSidebarCollapsed: false,
      workingFiles: [],
      previewEntity: null
    }),
  openPreview: (entity) => set({ previewEntity: entity, leftSidebarCollapsed: true }),
  closePreview: () => set({ previewEntity: null, leftSidebarCollapsed: false })
}))

type Theme = 'light' | 'dark'

/** Load persisted model, reasoning, and theme preferences from disk. Call after project path is set. */
export async function hydratePreferences(): Promise<void> {
  const api = (window as any).api
  const prefs = await api?.loadPreferences?.()
  if (!prefs) return
  const updates: Partial<{ selectedModel: string; reasoningEffort: ReasoningEffort; theme: Theme }> = {}
  if (prefs.selectedModel) updates.selectedModel = prefs.selectedModel
  if (prefs.reasoningEffort) updates.reasoningEffort = prefs.reasoningEffort
  if (prefs.theme) updates.theme = prefs.theme
  if (Object.keys(updates).length > 0) useUIStore.setState(updates)
}
