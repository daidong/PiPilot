/**
 * List Todos Command - Return structured data for todos.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Todo, type Provenance } from '../types.js'

export interface TodoListItem {
  id: string
  title: string
  content: string
  status: 'pending' | 'completed'
  completedAt?: string
  tags: string[]
  projectCard: boolean
  pinned: boolean
  selectedForAI: boolean
  provenance?: Provenance
  createdAt: string
  updatedAt: string
}

/** List all todos, returning structured data */
export function listTodos(projectPath: string): TodoListItem[] {
  const todosDir = join(projectPath, PATHS.todos)
  if (!existsSync(todosDir)) return []

  const files = readdirSync(todosDir).filter(f => f.endsWith('.json'))
  const items: TodoListItem[] = []

  for (const file of files) {
    try {
      const content = readFileSync(join(todosDir, file), 'utf-8')
      const todo = JSON.parse(content) as Todo
      items.push({
        id: todo.id,
        title: todo.title,
        content: todo.content,
        status: todo.status,
        completedAt: todo.completedAt,
        tags: todo.tags,
        projectCard: todo.projectCard ?? todo.pinned ?? false,
        pinned: todo.projectCard ?? todo.pinned ?? false,
        selectedForAI: todo.selectedForAI ?? false,
        provenance: todo.provenance,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt
      })
    } catch {
      // Skip invalid files
    }
  }

  // Sort: pending first, then by createdAt descending
  return items.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'pending' ? -1 : 1
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}
