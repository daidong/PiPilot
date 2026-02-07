import type { TaskAnchor } from '../types.js'
import {
  readKernelTaskAnchor,
  setKernelTaskAnchor,
  updateKernelTaskAnchor
} from '../memory-v2/kernel-task-anchor.js'

export interface TaskAnchorResult {
  success: boolean
  anchor?: TaskAnchor
  error?: string
}

export async function taskAnchorGet(projectPath: string, sessionId: string): Promise<TaskAnchorResult> {
  try {
    const anchor = await readKernelTaskAnchor(projectPath, sessionId)
    return { success: true, anchor }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function taskAnchorSet(
  projectPath: string,
  sessionId: string,
  anchor: Omit<TaskAnchor, 'updatedAt' | 'sessionId'>
): Promise<TaskAnchorResult> {
  try {
    const full = await setKernelTaskAnchor(projectPath, sessionId, anchor)
    return { success: true, anchor: full }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function taskAnchorUpdate(
  projectPath: string,
  sessionId: string,
  patch: Partial<Omit<TaskAnchor, 'updatedAt' | 'sessionId'>>
): Promise<TaskAnchorResult> {
  try {
    const updated = await updateKernelTaskAnchor(projectPath, sessionId, patch)
    return { success: true, anchor: updated }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
