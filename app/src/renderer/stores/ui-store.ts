import { create } from 'zustand'
import type { EntityItem } from './entity-store'
import { REASONING_MODELS, SUPPORTED_MODELS, DEFAULT_MODEL, RETIRED_MODEL_MIGRATIONS } from '../../../../shared-ui/constants'
import { parseModelKey } from '../../../../shared-ui/utils'
import type { ModelOption, ReasoningEffort } from '../../../../shared-ui/types'

import {
  getInitialThemePref, persistThemePref, applyThemePref, resolveThemePref,
  getInitialReadingSize, persistReadingSize, applyReadingSize,
  type Theme, type ThemePref, type ReadingSize
} from '../theme-boot'
type LeftTab = 'library' | 'files' | 'skills'
type CenterView = 'chat' | 'literature' | 'compute' | 'audit'
export type { LeftTab, CenterView }
export type { ReasoningEffort }

const DRAWER_WIDTH_MIN = 360
const DRAWER_WIDTH_MAX = 720
const DRAWER_WIDTH_DEFAULT = 540
const clampDrawerWidth = (px: number): number =>
  Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, Math.round(px)))

// Left sidebar width. Bounds chosen so the top toolbar (ModelSelector +
// ReasoningToggle + overflow menu) never clips at min, and so the center
// panel keeps reading-comfortable width at max on a 13" laptop.
const LEFT_WIDTH_MIN = 260
const LEFT_WIDTH_MAX = 480
const LEFT_WIDTH_DEFAULT = 320
const LEFT_WIDTH_KEY = 'ui.leftSidebarWidth'
const LEFT_COLLAPSED_KEY = 'ui.leftSidebarCollapsed'
const clampLeftWidth = (px: number): number =>
  Math.max(LEFT_WIDTH_MIN, Math.min(LEFT_WIDTH_MAX, Math.round(px)))
const readLeftWidth = (): number => {
  if (typeof window === 'undefined') return LEFT_WIDTH_DEFAULT
  const raw = window.localStorage?.getItem(LEFT_WIDTH_KEY)
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? clampLeftWidth(n) : LEFT_WIDTH_DEFAULT
}
const readLeftCollapsed = (): boolean => {
  if (typeof window === 'undefined') return false
  return window.localStorage?.getItem(LEFT_COLLAPSED_KEY) === 'true'
}

// Markdown edit mode preference (rendered Milkdown vs raw CodeMirror).
// Global, persisted across sessions and tab switches — see ui-store.ts
// design notes for why this lives in localStorage rather than per-entity.
export type MarkdownEditMode = 'rendered' | 'raw'
const MARKDOWN_EDIT_MODE_KEY = 'ui.markdownEditMode'
const readMarkdownEditMode = (): MarkdownEditMode => {
  if (typeof window === 'undefined') return 'rendered'
  const raw = window.localStorage?.getItem(MARKDOWN_EDIT_MODE_KEY)
  return raw === 'raw' ? 'raw' : 'rendered'
}

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
  theme: Theme            // resolved binary appearance (drives html class + `theme === 'dark'` checks)
  themePref: ThemePref    // the user's pick: light | dark | dim | system
  readingSize: ReadingSize
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
  drawerWidth: number
  leftSidebarWidth: number
  markdownEditMode: MarkdownEditMode

  // Literature view state
  literatureFilter: LiteratureFilter

  // Wiki reader state
  wikiReaderSlug: string | null
  wikiReaderHistory: string[]
  setWikiReaderSlug: (slug: string | null) => void
  wikiReaderBack: () => void

  setReasoningEffort: (level: ReasoningEffort) => void
  setThemePref: (pref: ThemePref) => void
  setReadingSize: (size: ReadingSize) => void
  setLeftTab: (tab: LeftTab) => void
  setCenterView: (view: CenterView) => void
  setModel: (model: ModelId) => void
  setIdle: (idle: boolean) => void
  toggleRightSidebar: () => void
  /** ⌘B / Ctrl+B — hides the entire left panel for max chat/view width. Persisted to localStorage. */
  toggleLeftSidebar: () => void
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
  setDrawerWidth: (width: number) => void
  setLeftSidebarWidth: (width: number) => void
  setLiteratureFilter: (filter: Partial<LiteratureFilter>) => void
  setMarkdownEditMode: (mode: MarkdownEditMode) => void
  toggleMarkdownEditMode: () => void
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
  // Appearance hydrates from localStorage at module init so the zustand state
  // matches the <html> classes applied by bootTheme() in main.tsx. Both ends
  // derive from getInitialThemePref()/getInitialReadingSize() — they stay in
  // sync. `theme` is the resolved binary appearance ('system'/'high-contrast' folded in).
  theme: resolveThemePref(getInitialThemePref()).theme,
  themePref: getInitialThemePref(),
  readingSize: getInitialReadingSize(),
  leftTab: 'files',
  centerView: 'chat',
  selectedModel: DEFAULT_MODEL,
  isIdle: true,
  rightSidebarCollapsed: false,
  leftSidebarCollapsed: readLeftCollapsed(),
  terminalVisible: false,
  terminalAlive: false,
  workingFiles: [],
  reasoningEffort: 'medium',
  previewEntity: null,
  previewSourceTab: null,
  previewEditorFocused: false,
  drawerWidth: DRAWER_WIDTH_DEFAULT,
  leftSidebarWidth: readLeftWidth(),
  markdownEditMode: readMarkdownEditMode(),
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
  // Set the full appearance preference (light | dark | dim | system).
  // Appearance is a GLOBAL user preference, not per-project — persist to
  // localStorage and update the <html> classes immediately so the next app
  // launch (and the welcome screen in particular) respects it.
  setThemePref: (pref) => {
    const { theme } = resolveThemePref(pref)
    set({ themePref: pref, theme })
    persistThemePref(pref)
    applyThemePref(pref)
    // Broadcast to every other open window via main so multi-window sessions
    // stay in sync. Main echoes back to the sender too; applyThemeFromBroadcast
    // below short-circuits when local state already matches.
    ;(window as any).api?.setTheme?.(pref)
  },
  setReadingSize: (size) => {
    set({ readingSize: size })
    persistReadingSize(size)
    applyReadingSize(size)
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
  toggleLeftSidebar: () =>
    set((s) => {
      const next = !s.leftSidebarCollapsed
      try { window.localStorage?.setItem(LEFT_COLLAPSED_KEY, String(next)) } catch { /* quota/disabled */ }
      return { leftSidebarCollapsed: next }
    }),
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
      // Mirror leftSidebarWidth below — collapsed state is a global UX
      // preference, not a per-session/per-project flag, so re-read it from
      // localStorage instead of hardcoding false. Without this, switching
      // projects (which calls reset()) silently un-hides the panel.
      leftSidebarCollapsed: readLeftCollapsed(),
      workingFiles: [],
      previewEntity: null,
      previewSourceTab: null,
      previewEditorFocused: false,
      drawerWidth: DRAWER_WIDTH_DEFAULT,
      leftSidebarWidth: readLeftWidth(),
      literatureFilter: { search: '', subTopic: null, sortBy: 'year', sortDir: 'desc', minScore: 0, source: null, round: null },
      wikiReaderSlug: null,
      wikiReaderHistory: []
    }),
  // Opening a preview routes the user to chat view — the drawer is mounted
  // inside the chat-body host, so it only renders there. Researchers expect
  // clicking a file to show them the file; forcing the view switch is the
  // honest implementation of that expectation.
  openPreview: (entity) => {
    // Telemetry §8.4: passive view-log entry. Fire-and-forget; main process
    // drops silently when tracingMode='disabled'. Only entities of types we
    // model in the spec target enum produce a row.
    const api = (window as any).api as
      | {
          telemetryViewLog?: (payload: {
            viewId: string
            target: { kind: 'artifact' | 'memory' | 'trace' | 'session-summary'; id: string }
            op: 'view'
          }) => Promise<{ success: boolean }>
        }
      | undefined
    if (api?.telemetryViewLog) {
      const viewId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      void api.telemetryViewLog({
        viewId,
        target: { kind: 'artifact', id: entity.id },
        op: 'view'
      })
    }
    set((s) => ({
      previewEntity: entity,
      previewSourceTab: s.leftTab,
      previewEditorFocused: false,
      centerView: 'chat',
    }))
  },
  closePreview: () => set({ previewEntity: null, previewSourceTab: null, previewEditorFocused: false }),
  setPreviewEditorFocused: (previewEditorFocused) => set({ previewEditorFocused }),
  setDrawerWidth: (drawerWidth) => set({ drawerWidth: clampDrawerWidth(drawerWidth) }),
  setLeftSidebarWidth: (width) => {
    const clamped = clampLeftWidth(width)
    set({ leftSidebarWidth: clamped })
    try { window.localStorage?.setItem(LEFT_WIDTH_KEY, String(clamped)) } catch { /* quota/disabled */ }
  },
  setMarkdownEditMode: (mode) => {
    set({ markdownEditMode: mode })
    try { window.localStorage?.setItem(MARKDOWN_EDIT_MODE_KEY, mode) } catch { /* quota/disabled */ }
  },
  toggleMarkdownEditMode: () => {
    const next: MarkdownEditMode = useUIStore.getState().markdownEditMode === 'rendered' ? 'raw' : 'rendered'
    useUIStore.getState().setMarkdownEditMode(next)
  }
}))

/** Apply a theme preference broadcast from another window. Idempotent:
 *  short-circuits when local preference already matches, breaking any echo
 *  loop with main. */
export function applyThemeFromBroadcast(pref: ThemePref): void {
  if (useUIStore.getState().themePref === pref) return
  const { theme } = resolveThemePref(pref)
  useUIStore.setState({ themePref: pref, theme })
  persistThemePref(pref)
  applyThemePref(pref)
}

/** Re-resolve the current preference and re-apply. Used by the system-theme
 *  listener: when the OS flips light/dark and the user is on 'system', the
 *  resolved appearance must follow without changing the stored preference. */
export function refreshResolvedTheme(): void {
  const pref = useUIStore.getState().themePref
  const { theme } = resolveThemePref(pref)
  if (useUIStore.getState().theme !== theme) useUIStore.setState({ theme })
  applyThemePref(pref)
}

/** Load persisted model, reasoning, and theme preferences from disk. Call after project path is set. */
export async function hydratePreferences(): Promise<void> {
  const api = (window as any).api
  const prefs = await api?.loadPreferences?.()
  const updates: Partial<{ selectedModel: string; reasoningEffort: ReasoningEffort; theme: Theme }> = {}
  if (prefs?.selectedModel) {
    // Step 1: legacy bare-ID format (e.g. 'gpt-5.4' → 'openai:gpt-5.4')
    const raw = prefs.selectedModel as string
    let normalized: string
    if (!raw.includes(':')) {
      const { provider, modelId } = parseModelKey(raw)
      normalized = `${provider}:${modelId}`
    } else {
      normalized = raw
    }
    // Step 2: retired flagship/low-tier IDs → current replacement (see lib/models.ts)
    updates.selectedModel = RETIRED_MODEL_MIGRATIONS[normalized] ?? normalized
  } else {
    // No saved preference — pick highest-priority available auth
    // Priority: OpenAI sub → Anthropic sub → OpenAI API → Anthropic API
    try {
      const preferred = await api?.pickPreferredModel?.()
      if (preferred) updates.selectedModel = preferred
    } catch { /* fall back to DEFAULT_MODEL already in store */ }
  }
  if (prefs?.reasoningEffort) updates.reasoningEffort = prefs.reasoningEffort
  // NOTE: theme is deliberately NOT restored from per-project prefs. It's
  // a global user preference managed via localStorage (see theme-boot.ts)
  // so the welcome screen respects it even when no project is open.
  if (Object.keys(updates).length > 0) useUIStore.setState(updates)
}
