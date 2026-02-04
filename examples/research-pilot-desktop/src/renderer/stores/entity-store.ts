import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'paper' | 'data'
  title: string
  pinned?: boolean           // Legacy field, kept for backward compatibility
  projectCard?: boolean      // RFC-009: New field for Project Cards
  selectedForAI?: boolean    // Legacy field, kept for backward compatibility (not used in RFC-009)
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  papers: EntityItem[]
  data: EntityItem[]
  projectCards: EntityItem[]   // RFC-009: Renamed from pinned
  workingSet: EntityItem[]     // RFC-009: Renamed from selected
  // Legacy aliases
  pinned: EntityItem[]
  selected: EntityItem[]
  enrichingPapers: Set<string>
  setEnriching: (id: string) => void
  clearEnriching: (id: string) => void
  clearAllEnriching: () => void
  reset: () => void
  refreshAll: () => Promise<void>
  toggleProjectCard: (id: string) => Promise<void>   // RFC-009: Renamed from togglePin
  toggleWorkingSet: (id: string) => Promise<void>    // RFC-009: Renamed from toggleSelect
  // Legacy aliases
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  renameNote: (id: string, newTitle: string) => Promise<void>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  papers: [],
  data: [],
  projectCards: [],   // RFC-009
  workingSet: [],     // RFC-009
  // Legacy aliases pointing to the same data
  get pinned() { return get().projectCards },
  get selected() { return get().workingSet },
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

  reset: () => set({ notes: [], papers: [], data: [], projectCards: [], workingSet: [], enrichingPapers: new Set<string>() }),

  refreshAll: async () => {
    const [notes, papers, data, projectCards, workingSet] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData(),
      api.getPinned(),      // Backend still uses legacy name
      api.getSelected()     // Backend still uses legacy name
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
      projectCards: projectCards || [],
      workingSet: workingSet || []
    })
  },

  // RFC-009: Primary method names
  toggleProjectCard: async (id: string) => {
    await api.togglePin(id)  // Backend still uses legacy name
    const [notes, papers, data, projectCards, workingSet] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), papers: stamp(papers, 'paper'),
      data: stamp(data, 'data'), projectCards: projectCards || [], workingSet: workingSet || []
    })
  },

  toggleWorkingSet: async (id: string) => {
    await api.toggleSelect(id)  // Backend still uses legacy name
    const [notes, papers, data, projectCards, workingSet] = await Promise.all([
      api.listNotes(), api.listLiterature(), api.listData(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), papers: stamp(papers, 'paper'),
      data: stamp(data, 'data'), projectCards: projectCards || [], workingSet: workingSet || []
    })
  },

  // Legacy aliases
  togglePin: async (id: string) => { return get().toggleProjectCard(id) },
  toggleSelect: async (id: string) => { return get().toggleWorkingSet(id) },

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
    const [notes, papers, data, projectCards, workingSet] = await Promise.all([
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
      projectCards: projectCards || [],
      workingSet: workingSet || []
    })
  }
}))
