/**
 * ctx-expand Tool Tests
 *
 * Tests for the context expansion tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ctxExpand } from '../../src/tools/ctx-expand.js'
import type { ToolContext } from '../../src/types/tool.js'
import type { Runtime } from '../../src/types/runtime.js'
import type {
  CompressedHistory,
  HistorySegment,
  RuntimeWithCompressor
} from '../../src/types/context-pipeline.js'
import type { Message, MessageStore } from '../../src/types/session.js'
import type { MemoryStorage, MemoryItem } from '../../src/types/memory.js'

describe('ctxExpand', () => {
  let mockRuntime: RuntimeWithCompressor
  let mockToolContext: ToolContext

  beforeEach(() => {
    mockRuntime = createMockRuntime()
    mockToolContext = {
      runtime: mockRuntime,
      sessionId: 'test-session',
      step: 1,
      agentId: 'test-agent'
    }
  })

  describe('segment expansion', () => {
    it('should expand a segment by ID', async () => {
      const compressedHistory = createMockCompressedHistory()
      mockRuntime.compressedHistory = compressedHistory

      // Mock message store to return messages
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([
        createMockMessage('user', 'Hello'),
        createMockMessage('assistant', 'Hi there!')
      ])

      const result = await ctxExpand.execute(
        { type: 'segment', ref: 'seg-0' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.type).toBe('segment')
      expect(result.data?.content).toContain('Hello')
      expect(result.data?.content).toContain('Hi there')
    })

    it('should return error for non-existent segment', async () => {
      const compressedHistory = createMockCompressedHistory()
      mockRuntime.compressedHistory = compressedHistory

      const result = await ctxExpand.execute(
        { type: 'segment', ref: 'seg-999' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('not found')
    })
  })

  describe('message expansion', () => {
    it('should expand a message range', async () => {
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([
        createMockMessage('user', 'First message'),
        createMockMessage('assistant', 'First response'),
        createMockMessage('user', 'Second message')
      ])

      const result = await ctxExpand.execute(
        { type: 'message', ref: '0-3' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.type).toBe('message')
      expect(result.data?.content).toContain('First message')
      expect(result.data?.content).toContain('Second message')
    })

    it('should handle last-N format', async () => {
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getRecentMessages = vi.fn().mockResolvedValue([
        createMockMessage('user', 'Msg 1'),
        createMockMessage('user', 'Msg 2'),
        createMockMessage('user', 'Msg 3'),
        createMockMessage('user', 'Msg 4'),
        createMockMessage('user', 'Msg 5')
      ])
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([
        createMockMessage('user', 'Msg 4'),
        createMockMessage('user', 'Msg 5')
      ])

      const result = await ctxExpand.execute(
        { type: 'message', ref: 'last-2' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(mockRuntime.messageStore.getMessageRange).toHaveBeenCalled()
    })

    it('should handle empty range', async () => {
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([])

      const result = await ctxExpand.execute(
        { type: 'message', ref: '100-110' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('No messages')
    })
  })

  describe('memory expansion', () => {
    it('should expand memory by key', async () => {
      const mockItem = createMockMemoryItem('project', 'config', { debug: true })
      mockRuntime.memoryStorage = createMockMemoryStorage()
      mockRuntime.memoryStorage.get = vi.fn().mockResolvedValue(mockItem)

      const result = await ctxExpand.execute(
        { type: 'memory', ref: 'project:config' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.type).toBe('memory')
      expect(result.data?.content).toContain('config')
      expect(result.data?.content).toContain('debug')
    })

    it('should handle missing memory key', async () => {
      mockRuntime.memoryStorage = createMockMemoryStorage()
      mockRuntime.memoryStorage.get = vi.fn().mockResolvedValue(null)

      const result = await ctxExpand.execute(
        { type: 'memory', ref: 'project:missing' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('not found')
    })

    it('should handle missing memory storage', async () => {
      delete mockRuntime.memoryStorage

      const result = await ctxExpand.execute(
        { type: 'memory', ref: 'project:config' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('not available')
    })
  })

  describe('search expansion', () => {
    it('should search through compressed history', async () => {
      const compressedHistory = createMockCompressedHistory()
      // Add relevant keywords to segment
      compressedHistory.segments[0]!.keywords = ['authentication', 'login', 'error']
      compressedHistory.segments[0]!.summary = 'Discussion about authentication'
      mockRuntime.compressedHistory = compressedHistory

      const result = await ctxExpand.execute(
        { type: 'search', ref: 'authentication' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.type).toBe('search')
      expect(result.data?.content).toContain('authentication')
    })

    it('should handle no matching segments', async () => {
      const compressedHistory = createMockCompressedHistory()
      compressedHistory.segments[0]!.keywords = ['unrelated', 'topic']
      mockRuntime.compressedHistory = compressedHistory

      const result = await ctxExpand.execute(
        { type: 'search', ref: 'xyznonexistent' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('No segments match')
    })

    it('should handle missing compressed history', async () => {
      delete mockRuntime.compressedHistory

      const result = await ctxExpand.execute(
        { type: 'search', ref: 'test' },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.content).toContain('No compressed history')
    })
  })

  describe('maxTokens parameter', () => {
    it('should truncate content when exceeding maxTokens', async () => {
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([
        createMockMessage('user', 'A'.repeat(1000))
      ])

      const result = await ctxExpand.execute(
        { type: 'message', ref: '0-1', maxTokens: 50 },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.truncated).toBe(true)
      expect(result.data?.tokens).toBeLessThanOrEqual(50)
    })

    it('should not truncate when within budget', async () => {
      mockRuntime.messageStore = createMockMessageStore()
      mockRuntime.messageStore.getMessageRange = vi.fn().mockResolvedValue([
        createMockMessage('user', 'Short message')
      ])

      const result = await ctxExpand.execute(
        { type: 'message', ref: '0-1', maxTokens: 1000 },
        mockToolContext
      )

      expect(result.success).toBe(true)
      expect(result.data?.truncated).toBe(false)
    })
  })

  describe('unknown type', () => {
    it('should return error for unknown expansion type', async () => {
      const result = await ctxExpand.execute(
        { type: 'unknown' as any, ref: 'test' },
        mockToolContext
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown expansion type')
    })
  })
})

// ============ Helper Functions ============

function createMockRuntime(): RuntimeWithCompressor {
  return {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step: 0,
    io: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      readdir: vi.fn(),
      exists: vi.fn(),
      exec: vi.fn(),
      glob: vi.fn(),
      grep: vi.fn()
    } as any,
    eventBus: {} as any,
    trace: {} as any,
    tokenBudget: {} as any,
    toolRegistry: {} as any,
    policyEngine: {} as any,
    contextManager: {} as any,
    sessionState: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      has: () => false
    }
  }
}

function createMockCompressedHistory(): CompressedHistory {
  const segment: HistorySegment = {
    id: 'seg-0',
    range: [0, 20],
    summary: 'Test segment summary',
    keywords: ['test', 'keyword'],
    messageCount: 20
  }

  return {
    summary: 'Test conversation summary',
    segments: [segment],
    tokens: 100
  }
}

function createMockMessageStore(): MessageStore {
  return {
    init: vi.fn(),
    close: vi.fn(),
    appendMessage: vi.fn(),
    getRecentMessages: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn(),
    getMessageRange: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getCurrentSessionId: vi.fn(),
    setCurrentSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    archiveSession: vi.fn()
  }
}

function createMockMemoryStorage(): MemoryStorage {
  return {
    init: vi.fn(),
    close: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    search: vi.fn().mockResolvedValue([]),
    has: vi.fn().mockResolvedValue(false),
    cleanExpired: vi.fn(),
    rebuildIndex: vi.fn(),
    getStats: vi.fn()
  }
}

function createMockMemoryItem(
  namespace: string,
  key: string,
  value: unknown
): MemoryItem {
  return {
    id: `${namespace}:${key}`,
    namespace,
    key,
    value,
    valueText: typeof value === 'string' ? value : undefined,
    tags: [],
    sensitivity: 'internal',
    status: 'active',
    provenance: {
      traceId: 'trace-1',
      createdBy: 'user'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function createMockMessage(role: 'user' | 'assistant' | 'tool', content: string): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    role,
    content,
    step: 0,
    keywords: []
  }
}
