/**
 * todo-remove - Tool for removing a todo item
 */

import { defineTool } from '../factories/define-tool.js'
import type { Tool } from '../types/tool.js'

export interface TodoRemoveInput {
  /** ID of the todo item to remove */
  id: string
}

export interface TodoRemoveOutput {
  success: boolean
  error?: string
}

export const todoRemove: Tool<TodoRemoveInput, TodoRemoveOutput> = defineTool({
  name: 'todo-remove',
  description: `Remove a todo item permanently.

## Example
{ "id": "todo-xxx" }`,
  parameters: {
    id: {
      type: 'string',
      description: 'ID of the todo item to remove',
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

      const deleted = await memoryStorage.delete('todo', input.id, 'Todo item removed')
      if (!deleted) {
        return {
          success: false,
          error: `Todo item not found: ${input.id}`
        }
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
})
