/**
 * Toggle todo completion wrapper over Memory V2 artifact update.
 */

import { artifactGet, artifactUpdate } from './artifact.js'

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

export function toggleTodoComplete(id: string, projectPath: string): ToggleTodoCompleteResult {
  const found = artifactGet(projectPath, id)
  if (!found || found.type !== 'todo') {
    return { success: false, error: `Todo not found: ${id}` }
  }

  const nextStatus = found.status === 'pending' ? 'completed' : 'pending'
  const updated = artifactUpdate(projectPath, id, {
    status: nextStatus,
    completedAt: nextStatus === 'completed' ? new Date().toISOString() : undefined
  })

  if (!updated.success || !updated.artifact || updated.artifact.type !== 'todo') {
    return { success: false, error: updated.error ?? 'Failed to update todo.' }
  }

  return {
    success: true,
    todo: {
      id: updated.artifact.id,
      title: updated.artifact.title,
      status: updated.artifact.status,
      completedAt: updated.artifact.completedAt
    }
  }
}
