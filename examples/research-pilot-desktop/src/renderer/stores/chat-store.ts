import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const PAGE_SIZE = 20

interface ChatState {
  messages: ChatMessage[]
  streamingText: string
  isStreaming: boolean
  savedMessageIds: Set<string>
  hasMore: boolean
  isLoadingHistory: boolean
  _offset: number

  send: (text: string) => Promise<void>
  appendChunk: (chunk: string) => void
  finalize: (result: { success: boolean; response?: string; error?: string }) => void
  clear: () => void
  markSaved: (messageId: string) => void
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
  hasMore: false,
  isLoadingHistory: false,
  _offset: 0,
  scrollToMessageId: null,

  send: async (text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
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

    try {
      const { useUIStore } = await import('./ui-store')
      const model = useUIStore.getState().selectedModel
      await api.sendMessage(text, undefined, model)
    } catch {
      // Error handled via agent:done event
    }
  },

  appendChunk: (chunk: string) => {
    set((s) => ({ streamingText: s.streamingText + chunk }))
  },

  finalize: (result) => {
    const content = result.response || result.error || 'No response'
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now()
    }
    set((s) => ({
      messages: [...s.messages, assistantMsg],
      streamingText: '',
      isStreaming: false
    }))

    // Persist assistant message
    if (_sessionId) {
      api.saveMessage(_sessionId, assistantMsg).catch(() => {})
    }
  },

  clear: () => set({
    messages: [],
    streamingText: '',
    isStreaming: false,
    savedMessageIds: new Set<string>(),
    hasMore: false,
    isLoadingHistory: false,
    _offset: 0,
    scrollToMessageId: null
  }),

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
