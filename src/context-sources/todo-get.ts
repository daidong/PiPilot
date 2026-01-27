/**
 * todo.get - Context source for getting a single todo item with details
 */

import { defineContextSource, createSuccessResult, createErrorResult } from '../factories/define-context-source.js'
import type { ContextSource, ContextResult } from '../types/context.js'
import type { TodoItem } from '../types/todo.js'

export interface TodoGetParams {
  /** ID of the todo item */
  id: string
}

export interface TodoGetData {
  item: TodoItem | null
  found: boolean
  subTasks?: TodoItem[]
}

export const todoGet: ContextSource<TodoGetParams, TodoGetData> = defineContextSource({
  id: 'todo.get',
  kind: 'get',
  description: 'Get a single todo item by ID with full details and sub-tasks.',
  shortDescription: 'Get todo item by ID',
  resourceTypes: ['todo'],
  params: [
    { name: 'id', type: 'string', required: true, description: 'Todo item ID' }
  ],
  examples: [
    { description: 'Get a todo item', params: { id: 'todo-xxx' }, resultSummary: 'Todo item details' }
  ],
  costTier: 'cheap',
  cache: {
    ttlMs: 30 * 1000,
    invalidateOn: ['memory:write']
  },
  render: {
    maxTokens: 1000,
    truncateStrategy: 'tail'
  },

  fetch: async (params, runtime): Promise<ContextResult<TodoGetData>> => {
    const startTime = Date.now()

    if (!params?.id) {
      return createErrorResult('Missing required field "id"', {
        durationMs: Date.now() - startTime,
        suggestions: ['Provide id: ctx.get("todo.get", { id: "todo-xxx" })']
      })
    }

    const memoryStorage = runtime.memoryStorage
    if (!memoryStorage) {
      return createErrorResult('Memory storage not available. Make sure kv-memory pack is loaded.', {
        durationMs: Date.now() - startTime
      })
    }

    const memItem = await memoryStorage.get('todo', params.id)
    if (!memItem) {
      return createErrorResult(`Todo item not found: ${params.id}`, {
        durationMs: Date.now() - startTime,
        suggestions: ['Use ctx.get("todo.list") to see available items']
      })
    }

    const item = memItem.value as TodoItem

    // Find sub-tasks
    const allResult = await memoryStorage.list({ namespace: 'todo', status: 'all' })
    const subTasks = allResult.items
      .map(mi => mi.value as TodoItem)
      .filter(t => t.parentId === item.id)

    // Render markdown
    const lines: string[] = [
      `# Todo: ${item.title}`,
      '',
      `- **ID:** \`${item.id}\``,
      `- **Status:** ${item.status}`,
      `- **Priority:** ${item.priority}`,
      `- **Created:** ${item.createdAt}`,
      `- **Updated:** ${item.updatedAt}`
    ]

    if (item.completedAt) {
      lines.push(`- **Completed:** ${item.completedAt}`)
    }
    if (item.parentId) {
      lines.push(`- **Parent:** \`${item.parentId}\``)
    }
    if (item.blockedBy?.length) {
      lines.push(`- **Blocked by:** ${item.blockedBy.map(id => `\`${id}\``).join(', ')}`)
    }
    if (item.tags?.length) {
      lines.push(`- **Tags:** ${item.tags.join(', ')}`)
    }

    if (item.description) {
      lines.push('', '## Description', '', item.description)
    }

    if (subTasks.length > 0) {
      lines.push('', '## Sub-tasks', '')
      for (const sub of subTasks) {
        const icon = sub.status === 'done' ? '[x]' : '[ ]'
        lines.push(`- ${icon} **${sub.title}** (${sub.status}) — \`${sub.id}\``)
      }
    }

    return createSuccessResult(
      { item, found: true, subTasks: subTasks.length > 0 ? subTasks : undefined },
      lines.join('\n'),
      {
        provenance: {
          operations: [],
          durationMs: Date.now() - startTime
        },
        coverage: { complete: true },
        kindEcho: {
          source: 'todo.get',
          kind: 'get',
          paramsUsed: { id: params.id }
        }
      }
    )
  }
})
