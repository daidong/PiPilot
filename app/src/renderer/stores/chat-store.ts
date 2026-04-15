import { create } from 'zustand'
import { useToolEventsStore, type ToolEvent } from '@shared/stores/tool-events-store'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: string[] // data URLs for user-pasted images
  timestamp: number
}

const PAGE_SIZE = 20

interface ChatState {
  messages: ChatMessage[]
  streamingText: string
  isStreaming: boolean
  savedMessageIds: Set<string>
  /** Tool events associated with each assistant message (messageId → events) */
  turnToolEvents: Map<string, ToolEvent[]>
  /** Draft input text — persists across component unmount/remount */
  draftText: string
  setDraftText: (text: string) => void
  hasMore: boolean
  isLoadingHistory: boolean
  _offset: number

  send: (text: string, images?: Array<{ base64: string; mimeType: string }>) => Promise<void>
  stop: () => Promise<void>
  appendChunk: (chunk: string) => void
  finalize: (result: { success: boolean; response?: string; error?: string; images?: Array<{ base64: string; mimeType: string }> }) => void
  clear: () => void
  markSaved: (messageId: string) => void
  insertContextReset: () => void
  loadInitial: (sessionId: string) => Promise<void>
  loadHistory: () => Promise<void>
  scrollToMessageId: string | null
  requestScrollTo: (messageId: string) => void
}

const api = (window as any).api

// Session ID cached from loadInitial
let _sessionId = ''

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streamingText: '',
  isStreaming: false,
  savedMessageIds: new Set<string>(),
  turnToolEvents: new Map<string, ToolEvent[]>(),
  draftText: '',
  setDraftText: (text: string) => set({ draftText: text }),
  hasMore: false,
  isLoadingHistory: false,
  _offset: 0,
  scrollToMessageId: null,

  send: async (text: string, images?: Array<{ base64: string; mimeType: string }>) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      images: images?.map(i => `data:${i.mimeType};base64,${i.base64}`),
      timestamp: Date.now()
    }
    set((s) => ({
      messages: [...s.messages, userMsg],
      streamingText: '',
      isStreaming: true
    }))

    // Persist user message
    if (_sessionId) {
      api.saveMessage(_sessionId, userMsg).catch(() => {})
    }

    // Reset run stats for the new message
    const { useUsageStore } = await import('./usage-store')
    useUsageStore.getState().resetRun()

    try {
      const { useUIStore } = await import('./ui-store')
      const model = useUIStore.getState().selectedModel
      await api.sendMessage(text, undefined, model, images)
    } catch {
      // Error handled via agent:done event
    }
  },

  stop: async () => {
    await api.stopAgent()
  },

  appendChunk: (chunk: string) => {
    set((s) => ({ streamingText: s.streamingText + chunk }))
  },

  finalize: (result) => {
    const content = result.response || result.error
      || 'Something unexpected happened — the agent returned no response and no error. This usually indicates an issue on the LLM server side. Please try again. If you are using a Claude or ChatGPT subscription, try signing out and back in via Settings.'
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      images: result.images?.map(i => `data:${i.mimeType};base64,${i.base64}`),
      timestamp: Date.now()
    }

    // Snapshot tool events for this turn before clearing
    const toolEventsSnapshot = useToolEventsStore.getState().snapshot()
    useToolEventsStore.getState().clearRun()

    set((s) => {
      const nextToolEvents = new Map(s.turnToolEvents)
      if (toolEventsSnapshot.length > 0) {
        nextToolEvents.set(assistantMsg.id, toolEventsSnapshot)
      }
      return {
        messages: [...s.messages, assistantMsg],
        streamingText: '',
        isStreaming: false,
        turnToolEvents: nextToolEvents,
      }
    })

    // Persist assistant message
    if (_sessionId) {
      api.saveMessage(_sessionId, assistantMsg).catch(() => {})
    }
  },

  clear: () => {
    _sessionId = ''
    return set({
    messages: [],
    streamingText: '',
    isStreaming: false,
    savedMessageIds: new Set<string>(),
    turnToolEvents: new Map<string, ToolEvent[]>(),
    draftText: '',
    hasMore: false,
    isLoadingHistory: false,
    _offset: 0,
    scrollToMessageId: null
  })},

  markSaved: (messageId: string) => {
    set((s) => {
      const next = new Set(s.savedMessageIds)
      next.add(messageId)
      return { savedMessageIds: next }
    })
    if (_sessionId) {
      api.markMessageSaved(_sessionId, messageId).catch(() => {})
    }
  },

  insertContextReset: () => {
    const divider: ChatMessage = {
      id: `ctx-reset-${Date.now()}`,
      role: 'system',
      content: 'AI context has been reset — chat history is preserved.',
      timestamp: Date.now()
    }
    set((s) => ({ messages: [...s.messages, divider] }))
  },

  loadInitial: async (sessionId: string) => {
    _sessionId = sessionId
    try {
      const [count, messages, savedIds] = await Promise.all([
        api.getMessageCount(sessionId),
        api.loadMessages(sessionId, 0, PAGE_SIZE),
        api.loadSavedMessageIds(sessionId)
      ])
      set({
        messages,
        hasMore: count > PAGE_SIZE,
        _offset: PAGE_SIZE,
        savedMessageIds: new Set<string>(savedIds || [])
      })
    } catch {
      // Fresh session, no history
    }
  },

  loadHistory: async () => {
    const { hasMore, isLoadingHistory, _offset } = get()
    if (!hasMore || isLoadingHistory || !_sessionId) return
    set({ isLoadingHistory: true })
    try {
      const [count, older] = await Promise.all([
        api.getMessageCount(_sessionId),
        api.loadMessages(_sessionId, _offset, PAGE_SIZE)
      ])
      if (older.length > 0) {
        set((s) => ({
          messages: [...older, ...s.messages],
          _offset: s._offset + older.length,
          hasMore: s._offset + older.length < count,
          isLoadingHistory: false
        }))
      } else {
        set({ hasMore: false, isLoadingHistory: false })
      }
    } catch {
      set({ isLoadingHistory: false })
    }
  },

  requestScrollTo: (messageId: string) => {
    set({ scrollToMessageId: messageId })
    // Clear after a tick so re-triggers work
    setTimeout(() => set({ scrollToMessageId: null }), 100)
  }
}))
