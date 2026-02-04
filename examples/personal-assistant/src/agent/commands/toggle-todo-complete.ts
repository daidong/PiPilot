/**
 * Toggle Todo Complete Command
 *
 * Toggles a todo's status between 'pending' and 'completed'.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Todo } from '../types.js'

export interface ToggleTodoCompleteResult {
  success: boolean
  todo?: {
    id: string
    title: string
    status: 'pending' | 'completed'
    completedAt?: string
  }
  error?: string
}

/**
 * Toggle a todo's completion status.
 * @param id The todo ID (full UUID or prefix)
 * @param projectPath The project root path
 */
export function toggleTodoComplete(id: string, projectPath: string): ToggleTodoCompleteResult {
  const todosDir = join(projectPath, PATHS.todos)
  if (!existsSync(todosDir)) {
    return { success: false, error: 'Todos directory not found' }
  }

  const files = readdirSync(todosDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const filePath = join(todosDir, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const todo = JSON.parse(content) as Todo

      // Match by full ID or prefix
      if (todo.id === id || todo.id.startsWith(id)) {
        // Toggle status
        const newStatus = todo.status === 'pending' ? 'completed' : 'pending'
        todo.status = newStatus
        todo.updatedAt = new Date().toISOString()

        // Set or clear completedAt
        if (newStatus === 'completed') {
          todo.completedAt = new Date().toISOString()
        } else {
          delete todo.completedAt
        }

        writeFileSync(filePath, JSON.stringify(todo, null, 2))

        return {
          success: true,
          todo: {
            id: todo.id,
            title: todo.title,
            status: todo.status,
            completedAt: todo.completedAt
          }
        }
      }
    } catch {
      // Skip invalid files
    }
  }

  return { success: false, error: `Todo not found: ${id}` }
}
