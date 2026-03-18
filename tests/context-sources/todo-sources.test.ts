/**
 * Tests for todo.list and todo.get context sources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { todoList } from '../../src/context-sources/todo-list.js'
import { todoGet } from '../../src/context-sources/todo-get.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { MemoryStorage, MemoryItem } from '../../src/types/memory.js'
import type { TodoItem } from '../../src/types/todo.js'

function createTodoItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'todo-001',
    title: 'Implement feature X',
    description: 'Build the new feature as specified in the RFC',
    status: 'pending',
    priority: 'high',
    tags: ['feature', 'sprint-1'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides
  }
}

function wrapAsMemoryItem(todo: TodoItem): MemoryItem {
  return {
    id: todo.id,
    namespace: 'todo',
    key: todo.id,
    value: todo,
    tags: todo.tags ?? [],
    sensitivity: 'internal',
    status: 'active',
    provenance: { traceId: 'trace-001', createdBy: 'user' },
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt
  }
}

function createMockMemoryStorage(todoItems: TodoItem[] = []): MemoryStorage {
  const memoryItems = todoItems.map(wrapAsMemoryItem)
  return {
    init: vi.fn(),
    close: vi.fn(),
    get: vi.fn((ns: string, key: string) => {
      const found = memoryItems.find(mi => mi.namespace === ns && mi.key === key)
      return Promise.resolve(found ?? null)
    }),
    put: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: memoryItems, total: memoryItems.length }),
    search: vi.fn().mockResolvedValue([]),
    has: vi.fn(),
    cleanExpired: vi.fn(),
    rebuildIndex: vi.fn(),
    getStats: vi.fn().mockResolvedValue({ totalItems: memoryItems.length, byNamespace: {}, bySensitivity: {} })
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

// ============ todo.list ============

describe('todo.list', () => {
  let runtime: Runtime
  let memoryStorage: MemoryStorage

  const sampleTodos: TodoItem[] = [
    createTodoItem({ id: 'todo-001', title: 'High priority task', priority: 'high', status: 'pending' }),
    createTodoItem({ id: 'todo-002', title: 'Low priority task', priority: 'low', status: 'pending' }),
    createTodoItem({ id: 'todo-003', title: 'Critical fix', priority: 'critical', status: 'in_progress' }),
    createTodoItem({ id: 'todo-004', title: 'Done task', priority: 'medium', status: 'done' }),
    createTodoItem({ id: 'todo-005', title: 'Blocked task', priority: 'medium', status: 'blocked', tags: ['blocked'] })
  ]

  beforeEach(() => {
    memoryStorage = createMockMemoryStorage(sampleTodos)
    runtime = createMockRuntime(memoryStorage)
  })

  it('should list all todo items', async () => {
    const result = await todoList.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(5)
    expect(result.data!.total).toBe(5)
  })

  it('should sort items by priority descending', async () => {
    const result = await todoList.fetch({}, runtime)

    const priorities = result.data!.items.map(i => i.priority)
    expect(priorities[0]).toBe('critical')
    expect(priorities[1]).toBe('high')
  })

  it('should filter by status', async () => {
    const result = await todoList.fetch({ status: 'pending' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items.every(i => i.status === 'pending')).toBe(true)
    expect(result.data!.items).toHaveLength(2)
  })

  it('should filter by priority', async () => {
    const result = await todoList.fetch({ priority: 'critical' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(1)
    expect(result.data!.items[0]!.title).toBe('Critical fix')
  })

  it('should filter by tags', async () => {
    const result = await todoList.fetch({ tags: ['blocked'] }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(1)
    expect(result.data!.items[0]!.title).toBe('Blocked task')
  })

  it('should filter by parentId', async () => {
    const todosWithParent = [
      ...sampleTodos,
      createTodoItem({ id: 'todo-006', title: 'Sub task', parentId: 'todo-001', priority: 'medium' })
    ]
    memoryStorage = createMockMemoryStorage(todosWithParent)
    runtime = createMockRuntime(memoryStorage)

    const result = await todoList.fetch({ parentId: 'todo-001' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(1)
    expect(result.data!.items[0]!.parentId).toBe('todo-001')
  })

  it('should support pagination', async () => {
    const result = await todoList.fetch({ limit: 2, offset: 0 }, runtime)

    expect(result.data!.items).toHaveLength(2)
  })

  it('should return empty list when no items match', async () => {
    memoryStorage = createMockMemoryStorage([])
    runtime = createMockRuntime(memoryStorage)

    const result = await todoList.fetch({}, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.items).toHaveLength(0)
    expect(result.rendered).toContain('No items found')
  })

  it('should return error when memory storage is not available', async () => {
    const runtimeNoMemory = createMockRuntime(undefined)

    const result = await todoList.fetch({}, runtimeNoMemory)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Memory storage not available')
  })

  it('should render markdown checklist', async () => {
    const result = await todoList.fetch({}, runtime)

    expect(result.rendered).toContain('# Todo List')
    expect(result.rendered).toContain('**Critical fix**')
    expect(result.rendered).toContain('[ ]')  // pending items
    expect(result.rendered).toContain('[x]')  // done items
  })

  it('should include kindEcho', async () => {
    const result = await todoList.fetch({}, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('todo.list')
    expect(result.kindEcho!.kind).toBe('index')
  })

  it('should mark coverage as incomplete when paginated', async () => {
    const result = await todoList.fetch({ limit: 2 }, runtime)

    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.limitations).toBeDefined()
  })
})

// ============ todo.get ============

describe('todo.get', () => {
  let runtime: Runtime
  let memoryStorage: MemoryStorage

  const sampleTodos: TodoItem[] = [
    createTodoItem({
      id: 'todo-001',
      title: 'Main task',
      description: 'This is the main task',
      priority: 'high',
      tags: ['feature']
    }),
    createTodoItem({
      id: 'todo-002',
      title: 'Sub task A',
      parentId: 'todo-001',
      priority: 'medium'
    }),
    createTodoItem({
      id: 'todo-003',
      title: 'Sub task B',
      parentId: 'todo-001',
      priority: 'low'
    })
  ]

  beforeEach(() => {
    memoryStorage = createMockMemoryStorage(sampleTodos)
    runtime = createMockRuntime(memoryStorage)
  })

  it('should get a specific todo item by id', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.found).toBe(true)
    expect(result.data!.item).toBeDefined()
    expect(result.data!.item!.id).toBe('todo-001')
    expect(result.data!.item!.title).toBe('Main task')
  })

  it('should include sub-tasks for parent items', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.data!.subTasks).toBeDefined()
    expect(result.data!.subTasks).toHaveLength(2)
    expect(result.data!.subTasks!.map(s => s.id).sort()).toEqual(['todo-002', 'todo-003'])
  })

  it('should return no sub-tasks when item has no children', async () => {
    const result = await todoGet.fetch({ id: 'todo-002' }, runtime)

    expect(result.success).toBe(true)
    expect(result.data!.subTasks).toBeUndefined()
  })

  it('should return error when todo item is not found', async () => {
    const result = await todoGet.fetch({ id: 'nonexistent' }, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Todo item not found')
    expect(result.error).toContain('nonexistent')
  })

  it('should return error when id is missing', async () => {
    const result = await todoGet.fetch({} as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "id"')
  })

  it('should return error when memory storage is not available', async () => {
    const runtimeNoMemory = createMockRuntime(undefined)

    const result = await todoGet.fetch({ id: 'todo-001' }, runtimeNoMemory)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Memory storage not available')
  })

  it('should render detailed markdown output', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.rendered).toContain('# Todo: Main task')
    expect(result.rendered).toContain('**ID:**')
    expect(result.rendered).toContain('**Status:**')
    expect(result.rendered).toContain('**Priority:**')
    expect(result.rendered).toContain('## Description')
    expect(result.rendered).toContain('## Sub-tasks')
  })

  it('should include tags in rendered output when present', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.rendered).toContain('**Tags:**')
    expect(result.rendered).toContain('feature')
  })

  it('should include kindEcho', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.kindEcho).toBeDefined()
    expect(result.kindEcho!.source).toBe('todo.get')
    expect(result.kindEcho!.kind).toBe('get')
    expect(result.kindEcho!.paramsUsed).toEqual({ id: 'todo-001' })
  })

  it('should set coverage.complete to true', async () => {
    const result = await todoGet.fetch({ id: 'todo-001' }, runtime)

    expect(result.coverage.complete).toBe(true)
  })

  it('should handle undefined params', async () => {
    const result = await todoGet.fetch(undefined as any, runtime)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Missing required field "id"')
  })
})
