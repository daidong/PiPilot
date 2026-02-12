import { create } from 'zustand'

export interface EntityItem {
  id: string
  type: 'note' | 'doc' | 'todo' | 'mail' | 'calendar'
  title: string
  status?: 'pending' | 'completed'
  completedAt?: string
  [key: string]: any
}

interface EntityState {
  notes: EntityItem[]
  docs: EntityItem[]
  todos: EntityItem[]
  mail: EntityItem[]
  calendar: EntityItem[]

  reset: () => void
  refreshAll: () => Promise<void>
  toggleTodoComplete: (id: string) => Promise<void>
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

export const useEntityStore = create<EntityState>((set, get) => ({
  notes: [],
  docs: [],
  todos: [],
  mail: [],
  calendar: [],

  reset: () => set({
    notes: [],
    docs: [],
    todos: [],
    mail: [],
    calendar: []
  }),

  refreshAll: async () => {
    try {
      const [
        notesRaw,
        docsRaw,
        todosRaw,
        mailRaw,
        calendarRaw
      ] = await Promise.all([
        api.listNotes(),
        api.listDocs(),
        api.listTodos(),
        api.listMail?.() ?? [],
        api.listCalendar?.() ?? []
      ])

      set({
        notes: stamp(notesRaw, 'note'),
        docs: stamp(docsRaw, 'doc'),
        todos: stamp(todosRaw, 'todo'),
        mail: stamp(mailRaw, 'mail'),
        calendar: stamp(calendarRaw, 'calendar')
      })
    } catch (err) {
      console.warn('[entity-store] refreshAll failed:', err)
    }
  },

  toggleTodoComplete: async (id: string) => {
    await api.toggleTodoComplete(id)
    const todosRaw = await api.listTodos()
    set({ todos: stamp(todosRaw, 'todo') })
  },

  deleteEntity: async (id: string) => {
    await api.deleteEntity(id)
    await get().refreshAll()
  }
}))
