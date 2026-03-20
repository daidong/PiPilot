import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'paper' | 'data'
  title: string
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  papers: EntityItem[]
  data: EntityItem[]

  enrichingPapers: Set<string>
  setEnriching: (id: string) => void
  clearEnriching: (id: string) => void
  clearAllEnriching: () => void

  reset: () => void
  refreshAll: () => Promise<void>

  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

function stamp(items: any[], type: EntityItem['type']): EntityItem[] {
  return (items || []).map((i: any) => ({
    ...i,
    type,
    title: i.title || i.name || i.id
  }))
}

function sortByYear(items: EntityItem[]): EntityItem[] {
  return [...items].sort((a: any, b: any) => {
    if (!a.year && !b.year) return 0
    if (!a.year) return 1
    if (!b.year) return -1
    return b.year - a.year
  })
}

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  papers: [],
  data: [],
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

  reset: () => set({
    notes: [],
    papers: [],
    data: [],
    enrichingPapers: new Set<string>()
  }),

  refreshAll: async () => {
    const [notesRaw, papersRaw, dataRaw] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData()
    ])

    const notes = stamp(notesRaw, 'note')
    // Sort agent-md to top of notes list
    notes.sort((a, b) => (a.id === 'agent-md' ? -1 : b.id === 'agent-md' ? 1 : 0))
    const papers = sortByYear(stamp(papersRaw, 'paper'))
    const data = stamp(dataRaw, 'data')

    set({
      notes,
      papers,
      data
    })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    await get().refreshAll()
  }
}))
