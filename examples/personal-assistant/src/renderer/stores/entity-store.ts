import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'doc' | 'todo'
  title: string
  pinned?: boolean
  selectedForAI?: boolean
  status?: 'pending' | 'completed'
  completedAt?: string
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  docs: EntityItem[]
  todos: EntityItem[]
  pinned: EntityItem[]
  selected: EntityItem[]
  reset: () => void
  refreshAll: () => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  toggleTodoComplete: (id: string) => Promise<void>
  renameNote: (id: string, newTitle: string) => Promise<void>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

export const useEntityStore = create<EntityState>((set) => ({
  notes: [],
  docs: [],
  todos: [],
  pinned: [],
  selected: [],

  reset: () => set({ notes: [], docs: [], todos: [], pinned: [], selected: [] }),

  refreshAll: async () => {
    try {
      const [notes, docs, todos, pinned, selected] = await Promise.all([
        api.listNotes(),
        api.listDocs(),
        api.listTodos(),
        api.getPinned(),
        api.getSelected()
      ])
      const stamp = (items: any[], type: EntityItem['type']) =>
        (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
      set({
        notes: stamp(notes, 'note'),
        docs: stamp(docs, 'doc'),
        todos: stamp(todos, 'todo'),
        pinned: pinned || [],
        selected: selected || []
      })
    } catch (err) {
      console.warn('[entity-store] refreshAll failed:', err)
    }
  },

  togglePin: async (id: string) => {
    await api.togglePin(id)
    const [notes, docs, todos, pinned, selected] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'), todos: stamp(todos, 'todo'),
      pinned: pinned || [], selected: selected || []
    })
  },

  toggleSelect: async (id: string) => {
    await api.toggleSelect(id)
    const [notes, docs, todos, pinned, selected] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'), todos: stamp(todos, 'todo'),
      pinned: pinned || [], selected: selected || []
    })
  },

  toggleTodoComplete: async (id: string) => {
    await api.toggleTodoComplete(id)
    const todos = await api.listTodos()
    const stamp = (items: any[]) =>
      (items || []).map((i: any) => ({ ...i, type: 'todo' as const }))
    set({ todos: stamp(todos) })
  },

  renameNote: async (id: string, newTitle: string) => {
    await api.renameNote(id, newTitle)
    const [notes, docs, todos] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc'),
      todos: stamp(todos, 'todo')
    })
  },

  updateEntity: async (id: string, updates: { title?: string; content?: string }) => {
    await api.updateEntity(id, updates)
    const [notes, docs, todos] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc'),
      todos: stamp(todos, 'todo')
    })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    const [notes, docs, todos, pinned, selected] = await Promise.all([
      api.listNotes(),
      api.listDocs(),
      api.listTodos(),
      api.getPinned(),
      api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'),
      docs: stamp(docs, 'doc'),
      todos: stamp(todos, 'todo'),
      pinned: pinned || [],
      selected: selected || []
    })
  }
}))
