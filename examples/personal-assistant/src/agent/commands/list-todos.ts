/**
 * Legacy todo list wrapper over Memory V2 artifacts.
 */

import { artifactList } from './artifact.js'
import type { Provenance } from '../types.js'

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

export function listTodos(projectPath: string): TodoListItem[] {
  const items = artifactList(projectPath, ['todo'])
    .filter(item => item.type === 'todo')
    .map(todo => ({
      id: todo.id,
      title: todo.title,
      content: todo.content,
      status: todo.status,
      completedAt: todo.completedAt,
      tags: todo.tags,
      projectCard: false,
      pinned: false,
      selectedForAI: false,
      provenance: todo.provenance,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt
    }))

  return items.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}
