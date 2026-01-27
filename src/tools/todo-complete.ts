/**
 * todo-complete - Convenience tool to mark a todo as done
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'
import type { TodoItem } from '../types/todo.js'

export interface TodoCompleteInput {
  /** ID of the todo item to complete */
  id: string
}

export interface TodoCompleteOutput {
  success: boolean
  item?: TodoItem
  error?: string
}

export const todoComplete: Tool<TodoCompleteInput, TodoCompleteOutput> = defineTool({
  name: 'todo-complete',
  description: `Mark a todo item as done. Shortcut for todo-update with status "done".

## Example
{ "id": "todo-xxx" }`,
  parameters: {
    id: {
      type: 'string',
      description: 'ID of the todo item to complete',
      required: true
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
        status: 'done',
        completedAt: now,
        updatedAt: now
      }

      await memoryStorage.update('todo', input.id, {
        value: updatedItem,
        valueText: `Todo: ${updatedItem.title} [done]`,
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
