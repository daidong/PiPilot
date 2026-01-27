/**
 * Tests for Todo Pack - tools and context sources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { todoAdd } from '../../src/tools/todo-add.js'
import { todoUpdate } from '../../src/tools/todo-update.js'
import { todoComplete } from '../../src/tools/todo-complete.js'
import { todoRemove } from '../../src/tools/todo-remove.js'
import { todoList } from '../../src/context-sources/todo-list.js'
import { todoGet } from '../../src/context-sources/todo-get.js'
import type { TodoItem } from '../../src/types/todo.js'
import type { MemoryStorage, MemoryItem, MemoryListOptions } from '../../src/types/memory.js'

// Helper to create a mock memory storage
function createMockStorage() {
  const store = new Map<string, MemoryItem>()

  const storage: MemoryStorage = {
    init: vi.fn(),
    close: vi.fn(),
    get: vi.fn(async (_ns: string, key: string) => {
      return store.get(`todo:${key}`) ?? null
    }),
    put: vi.fn(async (opts) => {
      const item: MemoryItem = {
        id: `mem-${Date.now()}`,
        namespace: opts.namespace,
        key: opts.key,
        value: opts.value,
        valueText: opts.valueText,
        tags: opts.tags ?? [],
        sensitivity: opts.sensitivity ?? 'internal',
        status: 'active',
        provenance: {
          traceId: 'test-trace',
          createdBy: opts.provenance?.createdBy ?? 'model'
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      store.set(`${opts.namespace}:${opts.key}`, item)
      return item
    }),
    update: vi.fn(async (_ns: string, key: string, opts) => {
      const existing = store.get(`todo:${key}`)
      if (!existing) return null
      const updated = {
        ...existing,
        value: opts.value ?? existing.value,
        valueText: opts.valueText ?? existing.valueText,
        tags: opts.tags ?? existing.tags,
        updatedAt: new Date().toISOString()
      }
      store.set(`todo:${key}`, updated)
      return updated
    }),
    delete: vi.fn(async (_ns: string, key: string) => {
      const fullKey = `todo:${key}`
      if (!store.has(fullKey)) return false
      store.delete(fullKey)
      return true
    }),
    list: vi.fn(async (_opts?: MemoryListOptions) => {
      const items = Array.from(store.values()).filter(i => {
        if (_opts?.namespace && i.namespace !== _opts.namespace) return false
        return true
      })
      return { items, total: items.length }
    }),
    search: vi.fn(async () => []),
    has: vi.fn(async (_ns: string, key: string) => store.has(`todo:${key}`)),
    cleanExpired: vi.fn(async () => 0),
    rebuildIndex: vi.fn(),
    getStats: vi.fn(async () => ({ totalItems: store.size, byNamespace: {}, bySensitivity: { public: 0, internal: 0, sensitive: 0 } }))
  }

  return { storage, store }
}

function createToolContext(memoryStorage: MemoryStorage | undefined) {
  return {
    runtime: {
      projectPath: '/tmp/test',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 0,
      io: {} as any,
      eventBus: {} as any,
      trace: {} as any,
      tokenBudget: {} as any,
      toolRegistry: {} as any,
      policyEngine: {} as any,
      contextManager: {} as any,
      sessionState: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn() },
      memoryStorage
    } as any,
    toolName: 'test',
    callId: 'test-call'
  }
}

describe('Todo Tools', () => {
  let mockStorage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    mockStorage = createMockStorage()
  })

  describe('todo-add', () => {
    it('should create a new todo item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const result = await todoAdd.execute({ title: 'Test task' }, ctx)

      expect(result.success).toBe(true)
      expect(result.item).toBeDefined()
      expect(result.item!.title).toBe('Test task')
      expect(result.item!.status).toBe('pending')
      expect(result.item!.priority).toBe('medium')
      expect(result.id).toBeDefined()
    })

    it('should create with all options', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const result = await todoAdd.execute({
        title: 'Detailed task',
        description: 'Some details',
        priority: 'high',
        tags: ['backend', 'urgent'],
        parentId: 'parent-123'
      }, ctx)

      expect(result.success).toBe(true)
      expect(result.item!.priority).toBe('high')
      expect(result.item!.tags).toEqual(['backend', 'urgent'])
      expect(result.item!.parentId).toBe('parent-123')
      expect(result.item!.description).toBe('Some details')
    })

    it('should fail without memory storage', async () => {
      const ctx = createToolContext(undefined)
      const result = await todoAdd.execute({ title: 'Test' }, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Memory storage not available')
    })
  })

  describe('todo-update', () => {
    it('should update an existing todo item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const addResult = await todoAdd.execute({ title: 'Original' }, ctx)
      const id = addResult.id!

      const updateResult = await todoUpdate.execute({
        id,
        title: 'Updated',
        priority: 'high'
      }, ctx)

      expect(updateResult.success).toBe(true)
      expect(updateResult.item!.title).toBe('Updated')
      expect(updateResult.item!.priority).toBe('high')
    })

    it('should set completedAt when status changes to done', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const addResult = await todoAdd.execute({ title: 'Task' }, ctx)
      const id = addResult.id!

      const updateResult = await todoUpdate.execute({
        id,
        status: 'done'
      }, ctx)

      expect(updateResult.success).toBe(true)
      expect(updateResult.item!.status).toBe('done')
      expect(updateResult.item!.completedAt).toBeDefined()
    })

    it('should fail for non-existent item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const result = await todoUpdate.execute({
        id: 'non-existent',
        title: 'Nope'
      }, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  describe('todo-complete', () => {
    it('should mark a todo as done', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const addResult = await todoAdd.execute({ title: 'Complete me' }, ctx)
      const id = addResult.id!

      const completeResult = await todoComplete.execute({ id }, ctx)

      expect(completeResult.success).toBe(true)
      expect(completeResult.item!.status).toBe('done')
      expect(completeResult.item!.completedAt).toBeDefined()
    })

    it('should fail for non-existent item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const result = await todoComplete.execute({ id: 'nope' }, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  describe('todo-remove', () => {
    it('should remove a todo item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const addResult = await todoAdd.execute({ title: 'Remove me' }, ctx)
      const id = addResult.id!

      const removeResult = await todoRemove.execute({ id }, ctx)
      expect(removeResult.success).toBe(true)
    })

    it('should fail for non-existent item', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const result = await todoRemove.execute({ id: 'nope' }, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })
})

describe('Todo Context Sources', () => {
  let mockStorage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    mockStorage = createMockStorage()
  })

  function createRuntime(memoryStorage?: MemoryStorage) {
    return {
      projectPath: '/tmp/test',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 0,
      memoryStorage
    } as any
  }

  async function addItem(title: string, priority: string = 'medium', parentId?: string, tags?: string[]) {
    const ctx = createToolContext(mockStorage.storage)
    return todoAdd.execute({ title, priority: priority as any, parentId, tags }, ctx)
  }

  describe('todo.list', () => {
    it('should list all todos', async () => {
      await addItem('Task A', 'high')
      await addItem('Task B', 'low')

      const runtime = createRuntime(mockStorage.storage)
      const result = await todoList.fetch({}, runtime)

      expect(result.success).toBe(true)
      expect(result.data!.items.length).toBe(2)
      // High priority should come first
      expect((result.data!.items[0] as TodoItem).priority).toBe('high')
    })

    it('should filter by status', async () => {
      const ctx = createToolContext(mockStorage.storage)
      const addResult = await addItem('Task A')
      await todoComplete.execute({ id: addResult.id! }, ctx)
      await addItem('Task B')

      const runtime = createRuntime(mockStorage.storage)
      const result = await todoList.fetch({ status: 'pending' }, runtime)

      expect(result.success).toBe(true)
      expect(result.data!.items.length).toBe(1)
      expect((result.data!.items[0] as TodoItem).title).toBe('Task B')
    })

    it('should return empty when no items', async () => {
      const runtime = createRuntime(mockStorage.storage)
      const result = await todoList.fetch({}, runtime)

      expect(result.success).toBe(true)
      expect(result.data!.items.length).toBe(0)
      expect(result.rendered).toContain('No items found')
    })

    it('should fail without memory storage', async () => {
      const runtime = createRuntime(undefined)
      const result = await todoList.fetch({}, runtime)

      expect(result.success).toBe(false)
    })
  })

  describe('todo.get', () => {
    it('should get a single todo item', async () => {
      const addResult = await addItem('My task', 'high')
      const runtime = createRuntime(mockStorage.storage)
      const result = await todoGet.fetch({ id: addResult.id! }, runtime)

      expect(result.success).toBe(true)
      expect(result.data!.found).toBe(true)
      expect(result.data!.item!.title).toBe('My task')
    })

    it('should include sub-tasks', async () => {
      const parent = await addItem('Parent task')
      await addItem('Child task', 'medium', parent.id!)

      const runtime = createRuntime(mockStorage.storage)
      const result = await todoGet.fetch({ id: parent.id! }, runtime)

      expect(result.success).toBe(true)
      expect(result.data!.subTasks).toBeDefined()
      expect(result.data!.subTasks!.length).toBe(1)
      expect(result.data!.subTasks![0].title).toBe('Child task')
    })

    it('should fail for non-existent item', async () => {
      const runtime = createRuntime(mockStorage.storage)
      const result = await todoGet.fetch({ id: 'nope' }, runtime)

      expect(result.success).toBe(false)
    })

    it('should fail without id', async () => {
      const runtime = createRuntime(mockStorage.storage)
      const result = await todoGet.fetch({} as any, runtime)

      expect(result.success).toBe(false)
    })
  })
})
