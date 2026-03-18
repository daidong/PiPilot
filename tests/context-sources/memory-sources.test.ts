/**
 * Tests for memory.get, memory.search, and memory.list context sources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryGet } from '../../src/context-sources/memory-get.js'
import { memorySearch } from '../../src/context-sources/memory-search.js'
import { memoryList } from '../../src/context-sources/memory-list.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { MemoryItem, MemoryStorage, MemorySearchResult } from '../../src/types/memory.js'

function createMockMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'item-1',
    namespace: 'user',
    key: 'code.style',
    value: { indentation: 'spaces', tabWidth: 2 },
    valueText: 'Prefers 2-space indentation',
    tags: ['config', 'style'],
    sensitivity: 'internal',
    status: 'active',
    provenance: {
      traceId: 'trace-001',
      createdBy: 'user',
      sessionId: 'session-001'
    },
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides
  }
}

function createMockMemoryStorage(): MemoryStorage {
  return {
    init: vi.fn(),
    close: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    search: vi.fn().mockResolvedValue([]),
    has: vi.fn(),
    cleanExpired: vi.fn(),
    rebuildIndex: vi.fn(),
    getStats: vi.fn().mockResolvedValue({ totalItems: 0, byNamespace: {}, bySensitivity: { public: 0, internal: 0, sensitive: 0 } })
  }
}

function createMockRuntime(memoryStorage?: MemoryStorage): Runtime {
  return {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step: 1,
    io: {} as any,
    eventBus: {} as any,
    trace: {} as any,
    tokenBudget: {} as any,
    toolRegistry: {} as any,
    policyEngine: {} as any,
    contextManager: {} as any,
    sessionState: {} as any,
    memoryStorage
  } as Runtime
}

// ============ memory.get ============

describe('memory.get', () => {
  let runtime: Runtime
  let memoryStorage: MemoryStorage

  beforeEach(() => {
    memoryStorage = createMockMemoryStorage()
    runtime = createMockRuntime(memoryStorage)
  })

  it('should retrieve an item by namespace and key', async () => {
    const item = createMockMemoryItem()
    ;(memoryStorage.get as any).mockResolvedValue(item)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'code.style' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data!.found).toBe(true)
    expect(result.data!.item).toEqual(item)
    expect(result.data!.fullKey).toBe('user:code.style')
    expect(memoryStorage.get).toHaveBeenCalledWith('user', 'code.style')
  })

  it('should return error when item is not found', async () => {
    ;(memoryStorage.get as any).mockResolvedValue(null)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'nonexistent' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
    expect(result.error).toContain('user:nonexistent')
  })

  it('should handle deprecated items by default (exclude them)', async () => {
    const deprecatedItem = createMockMemoryItem({ status: 'deprecated' })
    ;(memoryStorage.get as any).mockResolvedValue(deprecatedItem)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'code.style' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.item).toBeNull()
    expect(result.data!.found).toBe(true)
    expect(result.rendered).toContain('Deprecated')
  })

  it('should include deprecated items when includeDeprecated is true', async () => {
    const deprecatedItem = createMockMemoryItem({ status: 'deprecated' })
    ;(memoryStorage.get as any).mockResolvedValue(deprecatedItem)

    const result = await memoryGet.fetch(
      { namespace: 'user', key: 'code.style', includeDeprecated: true },
      runtime
    )

    expect(result.success).toBe(true)
    expect(result.data!.item).toEqual(deprecatedItem)
    expect(result.data!.found).toBe(true)
  })

  it('should return error when namespace is missing', async () => {
    const result = await memoryGet.fetch({ key: 'code.style' } as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "namespace"')
  })

  it('should return error when key is missing', async () => {
    const result = await memoryGet.fetch({ namespace: 'user' } as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "key"')
  })

  it('should return error when memory storage is not available', async () => {
    const runtimeNoMemory = createMockRuntime(undefined)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'code.style' }, runtimeNoMemory)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Memory storage not available')
  })

  it('should render value and metadata in output', async () => {
    const item = createMockMemoryItem()
    ;(memoryStorage.get as any).mockResolvedValue(item)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'code.style' }, runtime)

    expect(result.rendered).toContain('# Memory Item: user:code.style')
    expect(result.rendered).toContain('## Value')
    expect(result.rendered).toContain('## Metadata')
    expect(result.rendered).toContain('## Provenance')
    expect(result.rendered).toContain('Prefers 2-space indentation')
  })

  it('should include kindEcho in successful result', async () => {
    const item = createMockMemoryItem()
    ;(memoryStorage.get as any).mockResolvedValue(item)

    const result = await memoryGet.fetch({ namespace: 'user', key: 'code.style' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('memory.get')
    expect(result.kindEcho!.kind).toBe('get')
    expect(result.kindEcho!.paramsUsed).toEqual({ namespace: 'user', key: 'code.style' })
  })

  it('should handle params being undefined', async () => {
    const result = await memoryGet.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "namespace"')
  })
})

// ============ memory.search ============

describe('memory.search', () => {
  let runtime: Runtime
  let memoryStorage: MemoryStorage

  beforeEach(() => {
    memoryStorage = createMockMemoryStorage()
    runtime = createMockRuntime(memoryStorage)
  })

  it('should search memory items by query', async () => {
    const item = createMockMemoryItem()
    const searchResults: MemorySearchResult[] = [
      { item, score: 0.95, matchedKeywords: ['style', 'code'] }
    ]
    ;(memoryStorage.search as any).mockResolvedValue(searchResults)

    const result = await memorySearch.fetch({ query: 'code style' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.results).toHaveLength(1)
    expect(result.data!.total).toBe(1)
    expect(result.data!.query).toBe('code style')
    expect(memoryStorage.search).toHaveBeenCalledWith('code style', expect.objectContaining({
      limit: 20
    }))
  })

  it('should handle empty search results', async () => {
    ;(memoryStorage.search as any).mockResolvedValue([])

    const result = await memorySearch.fetch({ query: 'nonexistent' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.results).toHaveLength(0)
    expect(result.data!.total).toBe(0)
    expect(result.rendered).toContain('No matching items found')
  })

  it('should pass namespace and tag filters to storage', async () => {
    ;(memoryStorage.search as any).mockResolvedValue([])

    await memorySearch.fetch(
      { query: 'test', namespace: 'user', tags: ['config'] },
      runtime
    )

    expect(memoryStorage.search).toHaveBeenCalledWith('test', expect.objectContaining({
      namespace: 'user',
      tags: ['config']
    }))
  })

  it('should respect custom limit', async () => {
    ;(memoryStorage.search as any).mockResolvedValue([])

    await memorySearch.fetch({ query: 'test', limit: 5 }, runtime)

    expect(memoryStorage.search).toHaveBeenCalledWith('test', expect.objectContaining({
      limit: 5
    }))
  })

  it('should return error when query is missing', async () => {
    const result = await memorySearch.fetch({} as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "query"')
  })

  it('should return error when memory storage is not available', async () => {
    const runtimeNoMemory = createMockRuntime(undefined)

    const result = await memorySearch.fetch({ query: 'test' }, runtimeNoMemory)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Memory storage not available')
  })

  it('should include next step suggestion for top result', async () => {
    const item = createMockMemoryItem()
    const searchResults: MemorySearchResult[] = [
      { item, score: 0.9, matchedKeywords: ['style'] }
    ]
    ;(memoryStorage.search as any).mockResolvedValue(searchResults)

    const result = await memorySearch.fetch({ query: 'style' }, runtime)

    expect(result.next).toBeDefined()
    expect(result.next).toHaveLength(1)
    expect(result.next![0]!.source).toBe('memory.get')
    expect(result.next![0]!.params).toEqual({ namespace: 'user', key: 'code.style' })
  })

  it('should render results table in output', async () => {
    const item = createMockMemoryItem()
    const searchResults: MemorySearchResult[] = [
      { item, score: 0.95, matchedKeywords: ['style'] }
    ]
    ;(memoryStorage.search as any).mockResolvedValue(searchResults)

    const result = await memorySearch.fetch({ query: 'style' }, runtime)

    expect(result.rendered).toContain('# Memory Search Results')
    expect(result.rendered).toContain('"style"')
    expect(result.rendered).toContain('## Results')
    expect(result.rendered).toContain('## Top Result Detail')
  })

  it('should mark coverage as incomplete when results hit limit', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      createMockMemoryItem({ id: `item-${i}`, key: `key-${i}` })
    )
    const searchResults: MemorySearchResult[] = items.map(item => ({
      item, score: 0.8, matchedKeywords: ['test']
    }))
    ;(memoryStorage.search as any).mockResolvedValue(searchResults)

    const result = await memorySearch.fetch({ query: 'test', limit: 5 }, runtime)

    expect(result.coverage.complete).toBe(false)
  })

  it('should handle undefined params', async () => {
    const result = await memorySearch.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "query"')
  })
})

// ============ memory.list ============

describe('memory.list', () => {
  let runtime: Runtime
  let memoryStorage: MemoryStorage

  beforeEach(() => {
    memoryStorage = createMockMemoryStorage()
    runtime = createMockRuntime(memoryStorage)
  })

  it('should list memory items with defaults', async () => {
    const items = [createMockMemoryItem(), createMockMemoryItem({ id: 'item-2', key: 'db.config', namespace: 'project' })]
    ;(memoryStorage.list as any).mockResolvedValue({ items, total: 2 })
    ;(memoryStorage.getStats as any).mockResolvedValue({
      totalItems: 2,
      byNamespace: { user: 1, project: 1 },
      bySensitivity: { internal: 2, public: 0, sensitive: 0 }
    })

    const result = await memoryList.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(2)
    expect(result.data!.total).toBe(2)
    expect(result.data!.limit).toBe(50)
    expect(result.data!.offset).toBe(0)
    expect(memoryStorage.list).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      limit: 50,
      offset: 0
    }))
  })

  it('should handle empty memory store', async () => {
    ;(memoryStorage.list as any).mockResolvedValue({ items: [], total: 0 })
    ;(memoryStorage.getStats as any).mockResolvedValue({
      totalItems: 0,
      byNamespace: {},
      bySensitivity: { public: 0, internal: 0, sensitive: 0 }
    })

    const result = await memoryList.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(0)
    expect(result.data!.total).toBe(0)
    expect(result.rendered).toContain('No items found')
  })

  it('should pass filters to storage', async () => {
    ;(memoryStorage.list as any).mockResolvedValue({ items: [], total: 0 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 0, byNamespace: {}, bySensitivity: {} })

    await memoryList.fetch(
      { namespace: 'user', tags: ['config'], status: 'deprecated' },
      runtime
    )

    expect(memoryStorage.list).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      tags: ['config'],
      status: 'deprecated'
    }))
  })

  it('should support pagination', async () => {
    ;(memoryStorage.list as any).mockResolvedValue({ items: [], total: 100 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 100, byNamespace: {}, bySensitivity: {} })

    await memoryList.fetch({ limit: 10, offset: 20 }, runtime)

    expect(memoryStorage.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 10,
      offset: 20
    }))
  })

  it('should return error when memory storage is not available', async () => {
    const runtimeNoMemory = createMockRuntime(undefined)

    const result = await memoryList.fetch({}, runtimeNoMemory)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Memory storage not available')
  })

  it('should mark coverage as incomplete when more items exist', async () => {
    const items = [createMockMemoryItem()]
    ;(memoryStorage.list as any).mockResolvedValue({ items, total: 100 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 100, byNamespace: {}, bySensitivity: {} })

    const result = await memoryList.fetch({ limit: 10 }, runtime)

    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.limitations).toBeDefined()
  })

  it('should include stats in rendered output', async () => {
    const items = [createMockMemoryItem()]
    ;(memoryStorage.list as any).mockResolvedValue({ items, total: 1 })
    ;(memoryStorage.getStats as any).mockResolvedValue({
      totalItems: 5,
      byNamespace: { user: 3, project: 2 },
      bySensitivity: { internal: 5 }
    })

    const result = await memoryList.fetch({}, runtime)

    expect(result.rendered).toContain('## Stats')
    expect(result.rendered).toContain('Total items')
  })

  it('should include next step suggestions when items exist', async () => {
    const items = [createMockMemoryItem()]
    ;(memoryStorage.list as any).mockResolvedValue({ items, total: 1 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 1, byNamespace: {}, bySensitivity: {} })

    const result = await memoryList.fetch({}, runtime)

    expect(result.next).toBeDefined()
    expect(result.next!.some(n => n.source === 'memory.get')).toBe(true)
    expect(result.next!.some(n => n.source === 'memory.search')).toBe(true)
  })

  it('should include kindEcho', async () => {
    ;(memoryStorage.list as any).mockResolvedValue({ items: [], total: 0 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 0, byNamespace: {}, bySensitivity: {} })

    const result = await memoryList.fetch({}, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('memory.list')
    expect(result.kindEcho!.kind).toBe('index')
  })

  it('should handle undefined params', async () => {
    ;(memoryStorage.list as any).mockResolvedValue({ items: [], total: 0 })
    ;(memoryStorage.getStats as any).mockResolvedValue({ totalItems: 0, byNamespace: {}, bySensitivity: {} })

    const result = await memoryList.fetch(undefined as any, runtime)

    expect(result.success).toBe(true)
    expect(memoryStorage.list).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      limit: 50,
      offset: 0
    }))
  })
})
