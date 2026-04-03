import { create } from 'zustand'

export interface ToolProgressEntry {
  tool: string
  toolCallId: string
  phase: 'start' | 'update' | 'end'
  /** Last N lines of partial output (e.g., bash stdout) */
  partialOutput?: string
  startedAt: number
  updatedAt: number
}

interface ToolProgressState {
  /** In-flight tool progress keyed by toolCallId */
  inFlight: Map<string, ToolProgressEntry>
  reportProgress: (event: { tool: string; toolCallId: string; phase: string; data: any; timestamp: number }) => void
  clearAll: () => void
}

/** Extract last N lines from a text block */
function lastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(Boolean)
  return lines.slice(-n).join('\n')
}

/** Extract partial output string from tool progress data */
function extractPartialOutput(tool: string, data: any): string | undefined {
  if (!data?.partialResult) return undefined
  const pr = data.partialResult
  // pi-agent-core AgentToolResult format: { content: [{type:'text', text:'...'}], details: ... }
  const text = pr?.content?.[0]?.text
  if (typeof text === 'string' && text.length > 0) {
    // For bash-like tools, show last 5 lines; for others, last 3
    const maxLines = (tool === 'bash') ? 5 : 3
    return lastNLines(text, maxLines)
  }
  return undefined
}

export const useToolProgressStore = create<ToolProgressState>((set) => ({
  inFlight: new Map(),

  reportProgress: (event) => {
    set((state) => {
      const next = new Map(state.inFlight)
      const phase = event.phase as 'start' | 'update' | 'end'

      if (phase === 'start') {
        next.set(event.toolCallId, {
          tool: event.tool,
          toolCallId: event.toolCallId,
          phase,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
        })
      } else if (phase === 'update') {
        const existing = next.get(event.toolCallId)
        const partialOutput = extractPartialOutput(event.tool, event.data)
        next.set(event.toolCallId, {
          tool: event.tool,
          toolCallId: event.toolCallId,
          phase,
          partialOutput: partialOutput ?? existing?.partialOutput,
          startedAt: existing?.startedAt ?? event.timestamp,
          updatedAt: event.timestamp,
        })
      } else if (phase === 'end') {
        next.delete(event.toolCallId)
      }

      return { inFlight: next }
    })
  },

  clearAll: () => set({ inFlight: new Map() }),
}))
