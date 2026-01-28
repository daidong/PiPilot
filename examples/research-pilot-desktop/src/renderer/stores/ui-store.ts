import { create } from 'zustand'
import type { EntityItem } from './entity-store'

type Theme = 'light' | 'dark'
type LeftTab = 'notes' | 'data' | 'papers' | 'memory'

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
  // GPT-5.x
  { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'OpenAI' },
  { id: 'gpt-5.1', label: 'GPT-5.1', provider: 'OpenAI' },
  { id: 'gpt-5.1-mini', label: 'GPT-5.1 Mini', provider: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'OpenAI' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', provider: 'OpenAI' },
  // GPT-4
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'OpenAI' },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'OpenAI' },
]

interface UIState {
  theme: Theme
  leftTab: LeftTab
  selectedModel: ModelId
  isIdle: boolean
  rightSidebarCollapsed: boolean
  leftSidebarCollapsed: boolean
  workingFiles: WorkingFile[]
  previewEntity: EntityItem | null
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setLeftTab: (tab: LeftTab) => void
  setModel: (model: ModelId) => void
  setIdle: (idle: boolean) => void
  toggleRightSidebar: () => void
  addWorkingFile: (path: string) => void
  setWorkingFiles: (paths: string[]) => void
  clearWorkingFiles: () => void
  openPreview: (entity: EntityItem) => void
  closePreview: () => void
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'light',
  leftTab: 'notes',
  selectedModel: 'gpt-5.2',
  isIdle: true,
  rightSidebarCollapsed: false,
  leftSidebarCollapsed: false,
  workingFiles: [],
  previewEntity: null,

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
  setLeftTab: (leftTab) => set({ leftTab }),
  setModel: (selectedModel) => set({ selectedModel }),
  setIdle: (isIdle) => set({ isIdle }),
  toggleRightSidebar: () => set((s) => ({ rightSidebarCollapsed: !s.rightSidebarCollapsed })),
  addWorkingFile: (path) =>
    set((s) => {
      // Skip if already exists (check first to avoid unnecessary state updates)
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
      return { workingFiles: files }
    }),
  clearWorkingFiles: () => set({ workingFiles: [] }),
  openPreview: (entity) => set({ previewEntity: entity, leftSidebarCollapsed: true }),
  closePreview: () => set({ previewEntity: null, leftSidebarCollapsed: false })
}))
