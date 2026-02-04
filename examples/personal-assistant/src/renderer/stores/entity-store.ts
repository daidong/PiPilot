import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'doc' | 'todo'
  title: string
  pinned?: boolean           // Legacy field, kept for backward compatibility
  projectCard?: boolean      // RFC-009: New field for Project Cards
  selectedForAI?: boolean    // Legacy field, kept for backward compatibility (not used in RFC-009)
  status?: 'pending' | 'completed'
  completedAt?: string
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  docs: EntityItem[]
  todos: EntityItem[]
  projectCards: EntityItem[]   // RFC-009: Renamed from pinned
  workingSet: EntityItem[]     // RFC-009: Renamed from selected
  // Legacy aliases
  pinned: EntityItem[]
  selected: EntityItem[]
  reset: () => void
  refreshAll: () => Promise<void>
  toggleProjectCard: (id: string) => Promise<void>   // RFC-009: Renamed from togglePin
  toggleWorkingSet: (id: string) => Promise<void>    // RFC-009: Renamed from toggleSelect
  // Legacy aliases
  togglePin: (id: string) => Promise<void>
  toggleSelect: (id: string) => Promise<void>
  toggleTodoComplete: (id: string) => Promise<void>
  renameNote: (id: string, newTitle: string) => Promise<void>
  updateEntity: (id: string, updates: { title?: string; content?: string }) => Promise<void>
  deleteEntity: (id: string) => Promise<void>
}

const api = (window as any).api

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  docs: [],
  todos: [],
  projectCards: [],   // RFC-009
  workingSet: [],     // RFC-009
  // Legacy aliases pointing to the same data
  get pinned() { return get().projectCards },
  get selected() { return get().workingSet },

  reset: () => set({ notes: [], docs: [], todos: [], projectCards: [], workingSet: [] }),

  refreshAll: async () => {
    try {
      const [notes, docs, todos, projectCards, workingSet] = await Promise.all([
        api.listNotes(),
        api.listDocs(),
        api.listTodos(),
        api.getPinned(),      // Backend still uses legacy name
        api.getSelected()     // Backend still uses legacy name
      ])
      const stamp = (items: any[], type: EntityItem['type']) =>
        (items || []).map((i: any) => ({ ...i, type, title: i.title || i.name || i.id }))
      set({
        notes: stamp(notes, 'note'),
        docs: stamp(docs, 'doc'),
        todos: stamp(todos, 'todo'),
        projectCards: projectCards || [],
        workingSet: workingSet || []
      })
    } catch (err) {
      console.warn('[entity-store] refreshAll failed:', err)
    }
  },

  // RFC-009: Primary method names
  toggleProjectCard: async (id: string) => {
    await api.togglePin(id)  // Backend still uses legacy name
    const [notes, docs, todos, projectCards, workingSet] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'), todos: stamp(todos, 'todo'),
      projectCards: projectCards || [], workingSet: workingSet || []
    })
  },

  toggleWorkingSet: async (id: string) => {
    await api.toggleSelect(id)  // Backend still uses legacy name
    const [notes, docs, todos, projectCards, workingSet] = await Promise.all([
      api.listNotes(), api.listDocs(), api.listTodos(),
      api.getPinned(), api.getSelected()
    ])
    const stamp = (items: any[], type: EntityItem['type']) =>
      (items || []).map((i: any) => ({ ...i, type }))
    set({
      notes: stamp(notes, 'note'), docs: stamp(docs, 'doc'), todos: stamp(todos, 'todo'),
      projectCards: projectCards || [], workingSet: workingSet || []
    })
  },

  // Legacy aliases
  togglePin: async (id: string) => { return get().toggleProjectCard(id) },
  toggleSelect: async (id: string) => { return get().toggleWorkingSet(id) },

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
    const [notes, docs, todos, projectCards, workingSet] = await Promise.all([
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
      projectCards: projectCards || [],
      workingSet: workingSet || []
    })
  }
}))
