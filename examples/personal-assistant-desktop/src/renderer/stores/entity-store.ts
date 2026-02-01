import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'doc'
  title: string
  pinned?: boolean
  selectedForAI?: boolean
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  docs: EntityItem[]
  pinned: EntityItem[]
  selected: EntityItem[]
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
  docs: [],
  pinned: [],
  selected: [],

  reset: () => set({ notes: [], docs: [], pinned: [], selected: [] }),

  refreshAll: async () => {
    const [notes, docs, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listDocs(),
      api.getPinned(),
      api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc'),
      pinned: pinned || [],
      selected: selected || []
    })
  },

  togglePin: async (id: string) => {
    await api.togglePin(id)
    const [notes, docs, pinned, selected] = await Promise.all([
      api.listNotes(), api.listDocs(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'),
      pinned: pinned || [], selected: selected || []
    })
  },

  toggleSelect: async (id: string) => {
    await api.toggleSelect(id)
    const [notes, docs, pinned, selected] = await Promise.all([
      api.listNotes(), api.listDocs(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'),
      pinned: pinned || [], selected: selected || []
    })
  },

  renameNote: async (id: string, newTitle: string) => {
    await api.renameNote(id, newTitle)
    const [notes, docs] = await Promise.all([
      api.listNotes(), api.listDocs()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc')
    })
  },

  updateEntity: async (id: string, updates: { title?: string; content?: string }) => {
    await api.updateEntity(id, updates)
    const [notes, docs] = await Promise.all([
      api.listNotes(), api.listDocs()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc')
    })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    const [notes, docs, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listDocs(),
      api.getPinned(),
      api.getSelected()
    ])
    set({
      notes: notes || [],
      docs: docs || [],
      pinned: pinned || [],
      selected: selected || []
    })
  }
}))
