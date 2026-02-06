/**
 * Focus command compatibility layer.
 *
 * RFC-012 replaces WorkingSet with Focus (session-scoped, TTL-based).
 */

import { addFocusEntry, clearFocusEntries, findArtifactById, listFocusEntries, removeFocusEntry } from '../memory-v2/store.js'

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
  reason?: string
  score?: number
  expiresAt?: string
}

function baseProjectPath(projectPath?: string): string {
  return projectPath ?? process.cwd()
}

export function addToWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const root = baseProjectPath(projectPath)
  const found = findArtifactById(root, entityId)
  if (!found) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const result = addFocusEntry(root, {
    sessionId,
    refType: 'artifact',
    refId: found.artifact.id,
    reason: 'manually selected for current work',
    score: 1,
    source: 'manual',
    ttl: '2h'
  })

  if (!result.ok) {
    return { success: false, error: result.reason ?? 'Unable to add focus entry.' }
  }

  return {
    success: true,
    entityType: found.artifact.type,
    title: found.artifact.title,
    inWorkingSet: true
  }
}

export function removeFromWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const root = baseProjectPath(projectPath)
  const removed = removeFocusEntry(root, sessionId, entityId)
  if (!removed) {
    return { success: false, error: `Entity not found in focus: ${entityId}` }
  }

  const found = findArtifactById(root, entityId)
  return {
    success: true,
    entityType: found?.artifact.type,
    title: found?.artifact.title,
    inWorkingSet: false
  }
}

export function toggleWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const root = baseProjectPath(projectPath)
  if (isInWorkingSet(entityId, sessionId, root)) {
    return removeFromWorkingSet(entityId, sessionId, root)
  }
  return addToWorkingSet(entityId, sessionId, root)
}

export function getWorkingSet(sessionId: string, projectPath?: string): WorkingSetEntity[] {
  const root = baseProjectPath(projectPath)
  const entries = listFocusEntries(root, sessionId)

  return entries.map(entry => {
    if (entry.refType === 'artifact') {
      const found = findArtifactById(root, entry.refId)
      return {
        type: found?.artifact.type ?? 'artifact',
        id: entry.refId.slice(0, 8),
        title: found?.artifact.title ?? entry.refId,
        summaryCard: found?.artifact.summary,
        reason: entry.reason,
        score: entry.score,
        expiresAt: entry.expiresAt
      }
    }

    return {
      type: entry.refType,
      id: entry.refId.slice(0, 8),
      title: entry.refId,
      reason: entry.reason,
      score: entry.score,
      expiresAt: entry.expiresAt
    }
  })
}

export function getWorkingSetIds(sessionId: string, projectPath?: string): string[] {
  const root = baseProjectPath(projectPath)
  return listFocusEntries(root, sessionId)
    .filter(entry => entry.refType === 'artifact')
    .map(entry => entry.refId)
}

export function clearWorkingSet(sessionId: string, projectPath?: string): number {
  const root = baseProjectPath(projectPath)
  return clearFocusEntries(root, sessionId)
}

export function clearAllWorkingSets(): void {
  // No-op by design in RFC-012. Focus is persisted per session file.
}

export function isInWorkingSet(entityId: string, sessionId: string, projectPath?: string): boolean {
  const root = baseProjectPath(projectPath)
  const entries = listFocusEntries(root, sessionId)

  return entries.some(entry => entry.refType === 'artifact' && (
    entry.refId === entityId ||
    entry.refId.startsWith(entityId)
  ))
}

// Legacy aliases
export const toggleSelect = (entityId: string, projectPath?: string, sessionId: string = 'default') =>
  toggleWorkingSet(entityId, sessionId, projectPath)
export const getSelected = (projectPath?: string, sessionId: string = 'default') =>
  getWorkingSet(sessionId, projectPath)
export const clearSelections = (sessionId: string = 'default', projectPath?: string) =>
  clearWorkingSet(sessionId, projectPath)
export type SelectResult = WorkingSetResult
export type SelectedEntity = WorkingSetEntity
