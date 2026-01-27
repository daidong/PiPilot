/**
 * todo.list - Context source for listing todo items with filtering
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { TodoItem, TodoStatus, TodoPriority } from '../types/todo.js'

export interface TodoListParams {
  /** Filter by status */
  status?: TodoStatus
  /** Filter by priority */
  priority?: TodoPriority
  /** Filter by parent ID (get sub-tasks) */
  parentId?: string
  /** Filter by tags (items must have at least one matching tag) */
  tags?: string[]
  /** Max items to return (default: 50) */
  limit?: number
  /** Offset for pagination */
  offset?: number
}

export interface TodoListData {
  items: TodoItem[]
  total: number
  filtered: number
}

const PRIORITY_ORDER: Record<TodoPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
}

function statusIcon(status: TodoStatus): string {
  switch (status) {
    case 'done': return '[x]'
    case 'in_progress': return '[~]'
    case 'blocked': return '[!]'
    default: return '[ ]'
  }
}

export const todoList: ContextSource<TodoListParams, TodoListData> = defineContextSource({
  id: 'todo.list',
  kind: 'index',
  description: 'List todo items with optional filtering by status, priority, parentId, and tags. Returns a markdown checklist sorted by priority.',
  shortDescription: 'List todo items',
  resourceTypes: ['todo'],
  params: [
    { name: 'status', type: 'string', required: false, description: 'Filter by status: pending, in_progress, done, blocked' },
    { name: 'priority', type: 'string', required: false, description: 'Filter by priority: low, medium, high, critical' },
    { name: 'parentId', type: 'string', required: false, description: 'Filter by parent task ID' },
    { name: 'tags', type: 'array', required: false, description: 'Filter by tags' },
    { name: 'limit', type: 'number', required: false, default: 50, description: 'Max items to return' },
    { name: 'offset', type: 'number', required: false, default: 0, description: 'Offset for pagination' }
  ],
  examples: [
    { description: 'List all todos', params: {}, resultSummary: 'All todo items' },
    { description: 'List pending items', params: { status: 'pending' }, resultSummary: 'Pending todo items' },
    { description: 'List high priority', params: { priority: 'high' }, resultSummary: 'High priority items' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 30 * 1000,
    invalidateOn: ['memory:write']
  },
  render: {
    maxTokens: 2000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<TodoListData>> => {
    const startTime = Date.now()

    const memoryStorage = runtime.memoryStorage
    if (!memoryStorage) {
      return createErrorResult('Memory storage not available. Make sure kv-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    // List all items in the todo namespace
    const result = await memoryStorage.list({ namespace: 'todo', status: 'all' })
    let allItems: TodoItem[] = result.items.map(mi => mi.value as TodoItem)

    // Apply filters
    if (params?.status) {
      allItems = allItems.filter(i => i.status === params.status)
    }
    if (params?.priority) {
      allItems = allItems.filter(i => i.priority === params.priority)
    }
    if (params?.parentId) {
      allItems = allItems.filter(i => i.parentId === params.parentId)
    }
    if (params?.tags && params.tags.length > 0) {
      const filterTags = new Set(params.tags)
      allItems = allItems.filter(i => i.tags?.some(t => filterTags.has(t)))
    }

    // Sort: priority desc, then createdAt asc
    allItems.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 0
      const pb = PRIORITY_ORDER[b.priority] ?? 0
      if (pa !== pb) return pb - pa
      return a.createdAt.localeCompare(b.createdAt)
    })

    const total = allItems.length
    const limit = params?.limit ?? 50
    const offset = params?.offset ?? 0
    const paged = allItems.slice(offset, offset + limit)

    // Render markdown
    const lines: string[] = ['# Todo List', '']

    if (paged.length === 0) {
      lines.push('No items found.')
    } else {
      for (const item of paged) {
        const icon = statusIcon(item.status)
        const pri = item.priority !== 'medium' ? ` (${item.priority})` : ''
        const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : ''
        lines.push(`- ${icon} **${item.title}**${pri}${tags} — \`${item.id}\``)
        if (item.description) {
          lines.push(`  ${item.description}`)
        }
      }
    }

    if (total > offset + limit) {
      lines.push('')
      lines.push(`*Showing ${offset + 1}-${offset + paged.length} of ${total} items*`)
    }

    return createSuccessResult(
      { items: paged, total: result.total, filtered: total },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: {
          complete: total <= offset + limit,
          limitations: total > offset + limit ? [`${total - offset - limit} more items not shown`] : undefined
        },
        kindEcho: {
          source: 'todo.list',
          kind: 'index',
          paramsUsed: (params ?? {}) as Record<string, unknown>
        }
      }
    )
  }
})
