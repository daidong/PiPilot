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
  refreshAll: () => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  renameNote: (id: string, newTitle: string) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

export const useEntityStore = create<EntityState>((set) => ({
  notes: [],
  papers: [],
  data: [],
  pinned: [],
  selected: [],

  refreshAll: async () => {
    const [notes, papers, data, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listLiterature(),
      api.listData(),
      api.getPinned(),
      api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'),
      papers: stamp(papers, 'paper'),
      data: stamp(data, 'data'),
      pinned: pinned || [],
      selected: selected || []
    })
  },

  togglePin: async (id: string) => {
    await api.togglePin(id)
    const pinned = await api.getPinned()
    set({ pinned: pinned || [] })
  },

  toggleSelect: async (id: string) => {
    await api.toggleSelect(id)
    const selected = await api.getSelected()
    set({ selected: selected || [] })
  },

  renameNote: async (id: string, newTitle: string) => {
    await api.renameNote(id, newTitle)
    const notes = await api.listNotes()
    set({ notes: notes || [] })
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
