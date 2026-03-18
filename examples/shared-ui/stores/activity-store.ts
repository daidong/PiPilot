import { create } from 'zustand'

export interface ActivityEvent {
  id: string
  timestamp: string
  type: 'tool-call' | 'tool-result' | 'error' | 'system'
  tool?: string
  /** Short summary displayed in the panel */
  summary: string
  /** Whether the tool result was successful (only for tool-result type) */
  success?: boolean
  /** Error message if failed */
  error?: string
}

interface ActivityState {
  events: ActivityEvent[]
  push: (event: ActivityEvent) => void
  clear: () => void
}

const MAX_EVENTS = 50

export const useActivityStore = create<ActivityState>((set) => ({
  events: [],
  push: (event) =>
    set((state) => {
      // Filter out internal todo-* tool events (subagent pipeline noise)
      if (event.tool && event.tool.startsWith('todo-')) return state

      // When a tool-result arrives, merge it into the matching pending tool-call
      // instead of appending a separate row. This turns the spinning icon into
      // a completed checkmark in-place.
      if (event.type === 'tool-result') {
        // Find the last tool-call for the same tool that hasn't been resolved yet
        const idx = findLastIndex(state.events, (e) => e.type === 'tool-call' && e.tool === event.tool)
        if (idx !== -1) {
          const updated = [...state.events]
          updated[idx] = {
            ...updated[idx],
            type: 'tool-result',
            summary: event.summary,
            success: event.success,
            error: event.error,
            timestamp: event.timestamp
          }
          return { events: updated }
        }
      }

      const next = [...state.events, event]
      // Keep only the most recent events
      return { events: next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next }
    }),
  clear: () => set({ events: [] }),
}))

/** Find index of the last element matching a predicate */
function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}
