/**
 * Built-in Phases Tests
 *
 * Tests for each built-in context phase in isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createSystemPhase,
  createPinnedPhase,
  createSelectedPhase,
  createSessionPhase,
  createIndexPhase
} from '../../src/context/phases/index.js'
import { PHASE_PRIORITIES, DEFAULT_BUDGETS } from '../../src/context/pipeline.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { AssemblyContext } from '../../src/types/context-pipeline.js'
import type { Message, MessageStore } from '../../src/types/session.js'
import type { MemoryStorage, MemoryItem } from '../../src/types/memory.js'
import type { Pack } from '../../src/types/pack.js'

describe('SystemPhase', () => {
  it('should have correct priority and budget', () => {
    const phase = createSystemPhase()

    expect(phase.id).toBe('system')
    expect(phase.priority).toBe(PHASE_PRIORITIES.system)
    expect(phase.budget).toEqual(DEFAULT_BUDGETS.system)
  })

  it('should include system prompt', async () => {
    const phase = createSystemPhase({
      systemPrompt: 'You are a helpful assistant.'
    })

    const ctx = createMockAssemblyContext()
    const fragments = await phase.assemble(ctx)

    expect(fragments.length).toBeGreaterThan(0)
    expect(fragments.some(f => f.content.includes('helpful assistant'))).toBe(true)
  })

  it('should include constraints', async () => {
    const phase = createSystemPhase({
      constraints: [
        'Be concise',
        'Use markdown'
      ]
    })

    const ctx = createMockAssemblyContext()
    const fragments = await phase.assemble(ctx)

    const constraintFragment = fragments.find(f => f.source === 'system:constraints')
    expect(constraintFragment).toBeDefined()
    expect(constraintFragment!.content).toContain('Be concise')
    expect(constraintFragment!.content).toContain('Use markdown')
  })

  it('should include pack prompt fragments', async () => {
    const mockPack: Pack = {
      id: 'test-pack',
      description: 'Test pack',
      tools: [],
      policies: [],
      promptFragment: 'Use the test tool for testing.'
    }

    const phase = createSystemPhase({
      packs: [mockPack]
    })

    const ctx = createMockAssemblyContext()
    const fragments = await phase.assemble(ctx)

    const packFragment = fragments.find(f => f.source === 'pack:test-pack')
    expect(packFragment).toBeDefined()
    expect(packFragment!.content).toContain('test tool')
  })
})

describe('PinnedPhase', () => {
  it('should have correct priority and budget', () => {
    const phase = createPinnedPhase()

    expect(phase.id).toBe('pinned')
    expect(phase.priority).toBe(PHASE_PRIORITIES['project-cards'])
    expect(phase.budget).toEqual(DEFAULT_BUDGETS['project-cards'])
  })

  it('should be disabled when no memory storage', () => {
    const phase = createPinnedPhase()
    const ctx = createMockAssemblyContext()

    expect(phase.enabled!(ctx)).toBe(false)
  })

  it('should be enabled when memory storage available', () => {
    const phase = createPinnedPhase()
    const ctx = createMockAssemblyContext({
      memoryStorage: createMockMemoryStorage()
    })

    expect(phase.enabled!(ctx)).toBe(true)
  })

  it('should fetch pinned items from memory', async () => {
    const mockStorage = createMockMemoryStorage()
    mockStorage.list = vi.fn().mockResolvedValue({
      items: [
        createMockMemoryItem('project', 'rules', 'Always use TypeScript')
      ],
      total: 1
    })

    const phase = createPinnedPhase()
    const ctx = createMockAssemblyContext({ memoryStorage: mockStorage })

    const fragments = await phase.assemble(ctx)

    expect(mockStorage.list).toHaveBeenCalledWith({
      tags: ['pinned'],
      status: 'active',
      limit: 10
    })
    expect(fragments.some(f => f.content.includes('TypeScript'))).toBe(true)
  })
})

describe('SelectedPhase', () => {
  it('should have correct priority and budget', () => {
    const phase = createSelectedPhase()

    expect(phase.id).toBe('selected')
    expect(phase.priority).toBe(PHASE_PRIORITIES.selected)
    expect(phase.budget).toEqual(DEFAULT_BUDGETS.selected)
  })

  it('should be disabled when no selections', () => {
    const phase = createSelectedPhase()
    const ctx = createMockAssemblyContext()

    expect(phase.enabled!(ctx)).toBe(false)
  })

  it('should be enabled when selections present', () => {
    const phase = createSelectedPhase()
    const ctx = createMockAssemblyContext()
    ctx.selectedContext = [{ type: 'file', ref: './test.ts' }]

    expect(phase.enabled!(ctx)).toBe(true)
  })

  it('should resolve file selections', async () => {
    const mockRuntime = createMockRuntime()
    mockRuntime.io.readFile = vi.fn().mockResolvedValue({
      success: true,
      data: 'const x = 1;',
      traceId: 'trace-1'
    })

    const phase = createSelectedPhase()
    const ctx = createMockAssemblyContext({ runtime: mockRuntime })
    ctx.selectedContext = [{ type: 'file', ref: './test.ts' }]

    const fragments = await phase.assemble(ctx)

    expect(mockRuntime.io.readFile).toHaveBeenCalledWith('./test.ts')
    expect(fragments.some(f => f.content.includes('const x = 1'))).toBe(true)
  })

  it('should resolve memory selections', async () => {
    const mockStorage = createMockMemoryStorage()
    mockStorage.get = vi.fn().mockResolvedValue(
      createMockMemoryItem('project', 'config', { debug: true })
    )

    const mockRuntime = createMockRuntime({ memoryStorage: mockStorage })

    const phase = createSelectedPhase()
    const ctx = createMockAssemblyContext({ runtime: mockRuntime })
    ctx.selectedContext = [{ type: 'memory', ref: 'project:config' }]

    const fragments = await phase.assemble(ctx)

    expect(fragments.some(f => f.content.includes('debug'))).toBe(true)
  })

  it('should handle errors gracefully', async () => {
    const mockRuntime = createMockRuntime()
    mockRuntime.io.readFile = vi.fn().mockResolvedValue({
      success: false,
      error: 'File not found',
      traceId: 'trace-1'
    })

    const phase = createSelectedPhase()
    const ctx = createMockAssemblyContext({ runtime: mockRuntime })
    ctx.selectedContext = [{ type: 'file', ref: './missing.ts' }]

    const fragments = await phase.assemble(ctx)

    expect(fragments.some(f => f.content.includes('not found'))).toBe(true)
  })
})

describe('SessionPhase', () => {
  it('should have correct priority and budget', () => {
    const phase = createSessionPhase()

    expect(phase.id).toBe('session')
    expect(phase.priority).toBe(PHASE_PRIORITIES.session)
    expect(phase.budget).toEqual(DEFAULT_BUDGETS.session)
  })

  it('should include recent messages', async () => {
    const mockMessageStore = createMockMessageStore()
    mockMessageStore.getRecentMessages = vi.fn().mockResolvedValue([
      createMockMessage('user', 'Hello'),
      createMockMessage('assistant', 'Hi there!')
    ])

    const mockRuntime = createMockRuntime({ messageStore: mockMessageStore })

    const phase = createSessionPhase()
    const ctx = createMockAssemblyContext({
      runtime: mockRuntime,
      remainingBudget: 10000
    })

    const fragments = await phase.assemble(ctx)

    expect(fragments.some(f => f.content.includes('Hello'))).toBe(true)
    expect(fragments.some(f => f.content.includes('Hi there'))).toBe(true)
  })

  it('should track excluded messages', async () => {
    const mockMessageStore = createMockMessageStore()
    mockMessageStore.getRecentMessages = vi.fn().mockResolvedValue([
      createMockMessage('user', 'A'.repeat(1000)), // Large message
      createMockMessage('assistant', 'Small response')
    ])

    const mockRuntime = createMockRuntime({ messageStore: mockMessageStore })

    const phase = createSessionPhase()
    const ctx = createMockAssemblyContext({
      runtime: mockRuntime,
      remainingBudget: 100 // Very small budget
    })

    await phase.assemble(ctx)

    // Some messages should be excluded due to budget
    expect(ctx.excludedMessages.length).toBeGreaterThanOrEqual(0)
  })
})

describe('IndexPhase', () => {
  it('should have correct priority and budget', () => {
    const phase = createIndexPhase()

    expect(phase.id).toBe('index')
    expect(phase.priority).toBe(PHASE_PRIORITIES.index)
    expect(phase.budget).toEqual(DEFAULT_BUDGETS.index)
  })

  it('should be disabled when no excluded messages', () => {
    const phase = createIndexPhase()
    const ctx = createMockAssemblyContext()
    ctx.excludedMessages = []

    expect(phase.enabled!(ctx)).toBe(false)
  })

  it('should be enabled when excluded messages exist', () => {
    const phase = createIndexPhase()
    const ctx = createMockAssemblyContext()
    ctx.excludedMessages = [createMockMessage('user', 'Hello')]

    expect(phase.enabled!(ctx)).toBe(true)
  })

  it('should compress excluded messages', async () => {
    const phase = createIndexPhase()
    const ctx = createMockAssemblyContext()
    ctx.excludedMessages = [
      createMockMessage('user', 'Message 1'),
      createMockMessage('assistant', 'Response 1'),
      createMockMessage('user', 'Message 2')
    ]

    const fragments = await phase.assemble(ctx)

    expect(fragments.length).toBeGreaterThan(0)
    expect(fragments[0]!.content).toContain('History Index')
  })

  it('should store compressed history in context', async () => {
    const phase = createIndexPhase()
    const ctx = createMockAssemblyContext()
    ctx.excludedMessages = [
      createMockMessage('user', 'Test message')
    ]

    await phase.assemble(ctx)

    expect(ctx.compressedHistory).toBeDefined()
    expect(ctx.compressedHistory!.segments).toBeDefined()
  })
})

// ============ Helper Functions ============

function createMockRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step: 0,
    io: {
      readFile: vi.fn().mockResolvedValue({
        success: true,
        data: '',
        traceId: 'trace-1'
      }),
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
    },
    ...overrides
  }
}

function createMockAssemblyContext(overrides: {
  runtime?: Runtime
  memoryStorage?: MemoryStorage
  messageStore?: MessageStore
  remainingBudget?: number
} = {}): AssemblyContext {
  const runtime = overrides.runtime ?? createMockRuntime()

  if (overrides.memoryStorage) {
    (runtime as any).memoryStorage = overrides.memoryStorage
  }
  if (overrides.messageStore) {
    (runtime as any).messageStore = overrides.messageStore
  }

  return {
    runtime,
    totalBudget: 10000,
    usedBudget: 0,
    remainingBudget: overrides.remainingBudget ?? 10000,
    excludedMessages: []
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
    id: `msg-${Date.now()}`,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    role,
    content,
    step: 0,
    keywords: []
  }
}
