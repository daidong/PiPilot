import { create } from 'zustand'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
}

export interface MemoryEntry {
  frontmatter: MemoryFrontmatter
  content: string
  filename: string
}

// MemoryItem is the renderer-side shape used by EntityRow and the preview
// drawer. We flatten frontmatter onto the top level (mirroring how
// EntityItem is structured) so the same row component can handle notes
// and memories without branching on a nested shape.
export interface MemoryItem {
  // Use filename as a stable id. agent.md links to memory by filename, so
  // it stays stable across body edits; rename produces a new filename and
  // a new id, which is fine — the UI re-fetches after save.
  id: string
  filename: string
  type: 'memory'
  memoryType: MemoryType
  title: string // = frontmatter.name (so existing EntityRow renders correctly)
  description: string
  content: string
}

interface MemoryState {
  // Flat list, ordered by type then name. UI groups by `memoryType`.
  items: MemoryItem[]
  loaded: boolean
  refreshAll: () => Promise<void>
  saveMemory: (input: {
    filename?: string
    name: string
    type: MemoryType
    description: string
    content: string
  }) => Promise<{ success: boolean; filename?: string; error?: string }>
  deleteMemory: (filename: string) => Promise<{ success: boolean; error?: string }>
  reset: () => void
}

const api = (window as any).api

const TYPE_ORDER: MemoryType[] = ['user', 'feedback', 'project', 'reference']

function entryToItem(entry: MemoryEntry): MemoryItem {
  return {
    id: entry.filename,
    filename: entry.filename,
    type: 'memory',
    memoryType: entry.frontmatter.type,
    title: entry.frontmatter.name,
    description: entry.frontmatter.description,
    content: entry.content,
  }
}

function sortItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    const ta = TYPE_ORDER.indexOf(a.memoryType)
    const tb = TYPE_ORDER.indexOf(b.memoryType)
    if (ta !== tb) return ta - tb
    return a.title.localeCompare(b.title)
  })
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  items: [],
  loaded: false,

  refreshAll: async () => {
    const raw: MemoryEntry[] = await api.memoryList()
    const items = sortItems((raw || []).map(entryToItem))
    set({ items, loaded: true })
  },

  saveMemory: async (input) => {
    const result = await api.memorySave(input)
    if (result?.success) await get().refreshAll()
    return result
  },

  deleteMemory: async (filename) => {
    const result = await api.memoryDelete(filename)
    if (result?.success) await get().refreshAll()
    return result
  },

  reset: () => set({ items: [], loaded: false }),
}))
