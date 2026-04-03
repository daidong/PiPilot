import { create } from 'zustand'

export interface ToolEvent {
  id: string
  toolCallId: string
  tool: string
  status: 'running' | 'success' | 'error'
  summary: string
  detail?: Record<string, unknown>
  resultSummary?: string
  resultDetail?: Record<string, unknown>
  progress?: string
  durationMs?: number
  startedAt: number
  completedAt?: number
}

interface ToolEventsState {
  /** Events for the current streaming turn (chat-inline rendering) */
  currentRunEvents: ToolEvent[]
  /** Push a tool-call event */
  onToolCall: (event: {
    tool: string
    toolCallId?: string
    summary: string
    detail?: Record<string, unknown>
  }) => void
  /** Push a tool-result event (merges into matching tool-call) */
  onToolResult: (event: {
    tool: string
    toolCallId?: string
    summary: string
    success?: boolean
    resultDetail?: Record<string, unknown>
    durationMs?: number
  }) => void
  /** Update progress for an in-flight tool */
  onToolProgress: (event: {
    tool: string
    toolCallId: string
    phase: string
    data: any
  }) => void
  /** Get a snapshot of current events (for persisting with completed messages) */
  snapshot: () => ToolEvent[]
  /** Clear all events (on new run or finalize) */
  clearRun: () => void
}

/** Extract partial output from progress data */
function extractProgress(tool: string, data: any): string | undefined {
  if (!data?.partialResult) return undefined
  const text = data.partialResult?.content?.[0]?.text
  if (typeof text === 'string' && text.length > 0) {
    const lines = text.split('\n').filter(Boolean)
    const maxLines = tool === 'bash' ? 5 : 3
    return lines.slice(-maxLines).join('\n')
  }
  return undefined
}

export const useToolEventsStore = create<ToolEventsState>((set, get) => ({
  currentRunEvents: [],

  onToolCall: (event) => {
    const toolCallId = event.toolCallId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const newEvent: ToolEvent = {
      id: toolCallId,
      toolCallId,
      tool: event.tool,
      status: 'running',
      summary: event.summary,
      detail: event.detail,
      startedAt: Date.now(),
    }
    set((state) => ({
      currentRunEvents: [...state.currentRunEvents, newEvent]
    }))
  },

  onToolResult: (event) => {
    set((state) => {
      const events = [...state.currentRunEvents]
      // Find matching running event by toolCallId or tool name
      const idx = event.toolCallId
        ? events.findLastIndex((e) => e.toolCallId === event.toolCallId && e.status === 'running')
        : events.findLastIndex((e) => e.tool === event.tool && e.status === 'running')

      if (idx !== -1) {
        events[idx] = {
          ...events[idx],
          status: event.success !== false ? 'success' : 'error',
          resultSummary: event.summary,
          resultDetail: event.resultDetail,
          durationMs: event.durationMs,
          completedAt: Date.now(),
        }
      }
      return { currentRunEvents: events }
    })
  },

  onToolProgress: (event) => {
    if (event.phase === 'end') return // handled by onToolResult
    set((state) => {
      const events = [...state.currentRunEvents]
      const idx = events.findLastIndex((e) => e.toolCallId === event.toolCallId)
      if (idx !== -1) {
        const progress = extractProgress(event.tool, event.data) ?? events[idx].progress
        events[idx] = { ...events[idx], progress }
      }
      return { currentRunEvents: events }
    })
  },

  snapshot: () => [...get().currentRunEvents],

  clearRun: () => set({ currentRunEvents: [] }),
}))
