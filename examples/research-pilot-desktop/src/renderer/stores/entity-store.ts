import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'paper' | 'data'
  title: string
  pinned?: boolean
  selectedForAI?: boolean
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  papers: EntityItem[]
  data: EntityItem[]
  pinned: EntityItem[]
  selected: EntityItem[]
  enrichingPapers: Set<string>
  setEnriching: (id: string) => void
  clearEnriching: (id: string) => void
  clearAllEnriching: () => void
  reset: () => void
  refreshAll: () => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  renameNote: (id: string, newTitle: string) => Promise<void>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

export const useEntityStore = create<EntityState>((set) => ({
  notes: [],
  papers: [],
  data: [],
  pinned: [],
  selected: [],
  enrichingPapers: new Set<string>(),

  setEnriching: (id: string) => set((state) => {
    const next = new Set(state.enrichingPapers)
    next.add(id)
    return { enrichingPapers: next }
  }),
  clearEnriching: (id: string) => set((state) => {
    const next = new Set(state.enrichingPapers)
    next.delete(id)
    return { enrichingPapers: next }
  }),
  clearAllEnriching: () => set({ enrichingPapers: new Set<string>() }),

  reset: () => set({ notes: [], papers: [], data: [], pinned: [], selected: [], enrichingPapers: new Set<string>() }),

  refreshAll: async () => {
    const [notes, papers, data, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData(),
      api.getPinned(),
      api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    const sortByYear = (items: EntityItem[]) => items.sort((a: any, b: any) => {
      if (!a.year && !b.year) return 0
      if (!a.year) return 1
      if (!b.year) return -1
      return b.year - a.year
    })
    set({
      notes: stamp(notes, 'note'),
      papers: sortByYear(stamp(papers, 'paper')),
      data: stamp(data, 'data'),
      pinned: pinned || [],
      selected: selected || []
    })
  },

  togglePin: async (id: string) => {
    await api.togglePin(id)
    const [notes, papers, data, pinned, selected] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), papers: stamp(papers, 'paper'),
      data: stamp(data, 'data'), pinned: pinned || [], selected: selected || []
    })
  },

  toggleSelect: async (id: string) => {
    await api.toggleSelect(id)
    const [notes, papers, data, pinned, selected] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), papers: stamp(papers, 'paper'),
      data: stamp(data, 'data'), pinned: pinned || [], selected: selected || []
    })
  },

  renameNote: async (id: string, newTitle: string) => {
    await api.renameNote(id, newTitle)
    const [notes, papers, data] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      papers: stamp(papers, 'paper'),
      data: stamp(data, 'data')
    })
  },

  updateEntity: async (id: string, updates: { title?: string; content?: string }) => {
    await api.updateEntity(id, updates)
    const [notes, papers, data] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      papers: stamp(papers, 'paper'),
      data: stamp(data, 'data')
    })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    const [notes, papers, data, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData(),
      api.getPinned(),
      api.getSelected()
    ])
    set({
      notes: notes || [],
      papers: papers || [],
      data: data || [],
      pinned: pinned || [],
      selected: selected || []
    })
  }
}))
