import { create } from 'zustand'

export interface TodoItem {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  priority: string
  tags?: string[]
  createdAt: string
  updatedAt: string
  completedAt?: string
}

interface ProgressState {
  items: TodoItem[]
  upsertItem: (item: TodoItem) => void
  clear: () => void
}

export const useProgressStore = create<ProgressState>((set) => ({
  items: [],
  upsertItem: (item) =>
    set((state) => {
      const idx = state.items.findIndex((i) => i.id === item.id)
      if (idx >= 0) {
        const updated = [...state.items]
        updated[idx] = item
        return { items: updated }
      }
      return { items: [...state.items, item] }
    }),
  clear: () => set({ items: [] }),
}))
