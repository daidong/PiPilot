/**
 * todo-add - Tool for creating a new todo item
 *
 * Stores todo items in the kv-memory storage under the "todo" namespace.
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { TodoItem, TodoPriority } from '../types/todo.js'

export interface TodoAddInput {
  /** Short description of the task */
  title: string
  /** Detailed description */
  description?: string
  /** Priority level (low, medium, high, critical). Default: medium */
  priority?: TodoPriority
  /** Parent task ID for sub-tasks */
  parentId?: string
  /** Tags for categorization */
  tags?: string[]
}

export interface TodoAddOutput {
  success: boolean
  item?: TodoItem
  id?: string
  error?: string
}

function generateTodoId(): string {
  return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export const todoAdd: Tool<TodoAddInput, TodoAddOutput> = defineTool({
  name: 'todo-add',
  description: `Create a new todo item. Starts as "pending". Use parentId for sub-tasks.`,
  parameters: {
    title: {
      type: 'string',
      description: 'Short description of the task',
      required: true
    },
    description: {
      type: 'string',
      description: 'Detailed description of what needs to be done',
      required: false
    },
    priority: {
      type: 'string',
      description: 'Priority: low, medium (default), high, critical',
      required: false
    },
    parentId: {
      type: 'string',
      description: 'Parent task ID for creating sub-tasks',
      required: false
    },
    tags: {
      type: 'array',
      description: 'Tags for categorization',
      required: false
    }
  },
  activity: {
    formatCall: (a) => {
      const title = (a.title as string) || ''
      return { label: title ? `Task add: ${title.slice(0, 40)}` : 'Task add', icon: 'task' }
    },
    formatResult: (r) => {
      const item = (r.data as any)?.item ?? (r as any).item ?? r
      const subject = (item?.title as string) || (item?.subject as string) || ''
      return { label: subject ? `Task added: ${subject.slice(0, 35)}` : 'Task added', icon: 'task' }
    }
  },
  execute: async (input, { runtime }) => {
    try {
      const memoryStorage = runtime.memoryStorage
      if (!memoryStorage) {
        return {
          success: false,
          error: 'Memory storage not available. Make sure kv-memory pack is loaded.'
        }
      }

      const id = generateTodoId()
      const now = new Date().toISOString()

      const item: TodoItem = {
        id,
        title: input.title,
        description: input.description,
        status: 'pending',
        priority: input.priority ?? 'medium',
        parentId: input.parentId,
        tags: input.tags,
        createdAt: now,
        updatedAt: now
      }

      await memoryStorage.put({
        namespace: 'todo',
        key: id,
        value: item,
        valueText: `Todo: ${input.title}`,
        tags: input.tags ?? [],
        sensitivity: 'internal',
        provenance: { createdBy: 'model' }
      })

      return { success: true, item, id }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
