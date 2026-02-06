/**
 * Legacy /select wrapper over Focus entries (session attention).
 */

import { artifactGet } from './artifact.js'
import { focusAdd, focusClear, focusList, focusRemove } from './focus.js'

export interface WorkingSetResult {
  success: boolean
  entityType?: string
  title?: string
  inWorkingSet?: boolean
  error?: string
}

export interface WorkingSetEntity {
  type: string
  id: string
  title: string
  summaryCard?: string
}

export function toggleWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  if (!projectPath) {
    return { success: false, error: 'Project path is required.' }
  }

  const found = artifactGet(projectPath, entityId)
  if (!found) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const current = focusList(projectPath, sessionId).entries
  const inFocus = current.some(entry => entry.refType === 'artifact' && (entry.refId === found.id || entry.refId.startsWith(entityId)))

  if (inFocus) {
    const removed = focusRemove(projectPath, sessionId, found.id)
    return {
      success: removed.success,
      entityType: found.type,
      title: found.title,
      inWorkingSet: false,
      error: removed.success ? undefined : 'Failed to remove from focus.'
    }
  }

  const added = focusAdd(projectPath, {
    sessionId,
    refType: 'artifact',
    refId: found.id,
    reason: 'selected for current context',
    source: 'manual',
    ttl: '2h'
  })

  return {
    success: added.success,
    entityType: found.type,
    title: found.title,
    inWorkingSet: true,
    error: added.error
  }
}

export function getWorkingSet(sessionId: string, projectPath?: string): WorkingSetEntity[] {
  if (!projectPath) return []

  const entries = focusList(projectPath, sessionId).entries
  const out: WorkingSetEntity[] = []
  for (const entry of entries) {
    if (entry.refType !== 'artifact') continue
    const artifact = artifactGet(projectPath, entry.refId)
    if (!artifact) continue
    out.push({
      type: artifact.type,
      id: artifact.id.slice(0, 8),
      title: artifact.title,
      summaryCard: artifact.summary
    })
  }
  return out
}

export function getWorkingSetIds(sessionId: string, projectPath?: string): string[] {
  if (!projectPath) return []
  return focusList(projectPath, sessionId).entries
    .filter(entry => entry.refType === 'artifact')
    .map(entry => entry.refId)
}

export function clearWorkingSet(sessionId: string, projectPath?: string): number {
  if (!projectPath) return 0
  const current = focusList(projectPath, sessionId).entries
  focusClear(projectPath, sessionId)
  return current.length
}

export function clearAllWorkingSets(): void {
  // No-op in V2. Focus is persisted per session file.
}

export function isInWorkingSet(entityId: string, sessionId: string, projectPath?: string): boolean {
  if (!projectPath) return false
  const entries = focusList(projectPath, sessionId).entries
  return entries.some(entry => entry.refType === 'artifact' && (entry.refId === entityId || entry.refId.startsWith(entityId)))
}

export const toggleSelect = (entityId: string, projectPath?: string, sessionId: string = 'default') =>
  toggleWorkingSet(entityId, sessionId, projectPath)
export const getSelected = (projectPath?: string, sessionId: string = 'default') =>
  getWorkingSet(sessionId, projectPath)
export const clearSelections = (sessionId: string = 'default', projectPath?: string) =>
  clearWorkingSet(sessionId, projectPath)
export type SelectResult = WorkingSetResult
export type SelectedEntity = WorkingSetEntity
