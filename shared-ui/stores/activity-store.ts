import { create } from 'zustand'

export interface ActivityEvent {
  id: string
  timestamp: string
  type: 'tool-call' | 'tool-result' | 'error' | 'system'
  tool?: string
  /** Unique ID to correlate tool-call → tool-result */
  toolCallId?: string
  /** Short summary displayed in the panel */
  summary: string
  /** Structured tool-call parameters for rich rendering */
  detail?: Record<string, unknown>
  /** Structured tool-result info for rich rendering */
  resultDetail?: Record<string, unknown>
  /** Whether the tool result was successful (only for tool-result type) */
  success?: boolean
  /** Error message if failed */
  error?: string
  /** Execution duration in ms (set on tool-result events) */
  durationMs?: number
}

interface ActivityState {
  events: ActivityEvent[]
  /** Skills loaded during the current run */
  activeSkills: string[]
  push: (event: ActivityEvent) => void
  addSkill: (name: string) => void
  clear: () => void
}

const MAX_EVENTS = 50

export const useActivityStore = create<ActivityState>((set) => ({
  events: [],
  activeSkills: [],
  addSkill: (name) =>
    set((state) => {
      if (state.activeSkills.includes(name)) return state
      return { activeSkills: [...state.activeSkills, name] }
    }),
  push: (event) =>
    set((state) => {
      // Filter out internal todo-* tool events (subagent pipeline noise)
      if (event.tool && event.tool.startsWith('todo-')) return state

      // When a tool-result arrives, merge it into the matching pending tool-call
      // instead of appending a separate row. This turns the spinning icon into
      // a completed checkmark in-place.
      if (event.type === 'tool-result') {
        // Prefer matching by toolCallId for reliable correlation; fall back to tool name
        const idx = event.toolCallId
          ? findLastIndex(state.events, (e) => e.type === 'tool-call' && e.toolCallId === event.toolCallId)
          : findLastIndex(state.events, (e) => e.type === 'tool-call' && e.tool === event.tool)
        if (idx !== -1) {
          const updated = [...state.events]
          updated[idx] = {
            ...updated[idx],            // preserve original detail (tool-call params)
            type: 'tool-result',
            summary: event.summary,
            success: event.success,
            error: event.error,
            timestamp: event.timestamp,
            resultDetail: event.resultDetail,
            durationMs: event.durationMs,
          }
          return { events: updated }
        }
      }

      const next = [...state.events, event]
      // Keep only the most recent events
      return { events: next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next }
    }),
  clear: () => set({ events: [], activeSkills: [] }),
}))

/** Find index of the last element matching a predicate */
function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}
