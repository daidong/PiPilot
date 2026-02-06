import type { TaskAnchor } from '../types.js'
import { readTaskAnchor, updateTaskAnchor, writeTaskAnchor } from '../memory-v2/store.js'

export interface TaskAnchorResult {
  success: boolean
  anchor?: TaskAnchor
  error?: string
}

export function taskAnchorGet(projectPath: string): TaskAnchorResult {
  try {
    return { success: true, anchor: readTaskAnchor(projectPath) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function taskAnchorSet(projectPath: string, anchor: Omit<TaskAnchor, 'updatedAt'>): TaskAnchorResult {
  try {
    const full = writeTaskAnchor(projectPath, {
      ...anchor,
      updatedAt: new Date().toISOString()
    })
    return { success: true, anchor: full }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function taskAnchorUpdate(
  projectPath: string,
  patch: Partial<Omit<TaskAnchor, 'updatedAt'>>
): TaskAnchorResult {
  try {
    const updated = updateTaskAnchor(projectPath, patch)
    return { success: true, anchor: updated }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
