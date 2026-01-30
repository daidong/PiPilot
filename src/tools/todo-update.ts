/**
 * todo-update - Tool for updating an existing todo item
 *
 * Updates fields on a todo item stored in kv-memory.
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { TodoItem, TodoStatus, TodoPriority } from '../types/todo.js'

export interface TodoUpdateInput {
  /** ID of the todo item to update */
  id: string
  /** New title */
  title?: string
  /** New description */
  description?: string
  /** New status (pending, in_progress, done, blocked) */
  status?: TodoStatus
  /** New priority (low, medium, high, critical) */
  priority?: TodoPriority
  /** IDs of blocking tasks */
  blockedBy?: string[]
  /** New tags */
  tags?: string[]
}

export interface TodoUpdateOutput {
  success: boolean
  item?: TodoItem

  error?: string
}

export const todoUpdate: Tool<TodoUpdateInput, TodoUpdateOutput> = defineTool({
  name: 'todo-update',
  description: `Update an existing todo item by ID. Setting status "done" auto-sets completedAt. Use blockedBy for dependencies.`,
  parameters: {
    id: {
      type: 'string',
      description: 'ID of the todo item to update',
      required: true
    },
    title: {
      type: 'string',
      description: 'New title',
      required: false
    },
    description: {
      type: 'string',
      description: 'New description',
      required: false
    },
    status: {
      type: 'string',
      description: 'New status: pending, in_progress, done, blocked',
      required: false
    },
    priority: {
      type: 'string',
      description: 'New priority: low, medium, high, critical',
      required: false
    },
    blockedBy: {
      type: 'array',
      description: 'IDs of tasks that block this one',
      required: false
    },
    tags: {
      type: 'array',
      description: 'New tags (replaces existing)',
      required: false
    }
  },
  activity: {
    formatCall: (a) => {
      const id = (a.id as string) || ''
      const title = (a.title as string) || ''
      return { label: title ? `Task update: ${title.slice(0, 40)}` : `Task update: ${id.slice(0, 20)}`, icon: 'task' }
    },
    formatResult: (r) => {
      const item = (r.data as any)?.item ?? (r as any).item ?? r
      const subject = (item?.title as string) || (item?.subject as string) || ''
      return { label: subject ? `Task updated: ${subject.slice(0, 35)}` : 'Task updated', icon: 'task' }
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

      const existing = await memoryStorage.get('todo', input.id)
      if (!existing) {
        return {
          success: false,
          error: `Todo item not found: ${input.id}`
        }
      }

      const oldItem = existing.value as TodoItem
      const now = new Date().toISOString()

      const updatedItem: TodoItem = {
        ...oldItem,
        title: input.title ?? oldItem.title,
        description: input.description ?? oldItem.description,
        status: input.status ?? oldItem.status,
        priority: input.priority ?? oldItem.priority,
        blockedBy: input.blockedBy ?? oldItem.blockedBy,
        tags: input.tags ?? oldItem.tags,
        updatedAt: now
      }

      // Auto-set completedAt when status changes to done
      if (input.status === 'done' && oldItem.status !== 'done') {
        updatedItem.completedAt = now
      }

      await memoryStorage.update('todo', input.id, {
        value: updatedItem,
        valueText: `Todo: ${updatedItem.title} [${updatedItem.status}]`,
        tags: updatedItem.tags ?? []
      })

      return { success: true, item: updatedItem }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
