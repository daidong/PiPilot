/**
 * Legacy /pin wrapper over Focus entries.
 * In Memory V2, this maps to long-lived manual focus (ttl=today).
 */

import { artifactGet } from './artifact.js'
import { focusAdd, focusList, focusRemove } from './focus.js'

export interface ProjectCardResult {
  success: boolean
  id?: string
  entityType?: string
  title?: string
  projectCard?: boolean
  error?: string
}

export interface ProjectCardEntity {
  type: string
  id: string
  title: string
  summaryCard?: string
}

export function toggleProjectCard(entityId: string, projectPath?: string, sessionId: string = 'default'): ProjectCardResult {
  if (!projectPath) {
    return { success: false, error: 'Project path is required.' }
  }

  const found = artifactGet(projectPath, entityId)
  if (!found) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const entries = focusList(projectPath, sessionId).entries
  const existing = entries.find(entry =>
    entry.refType === 'artifact' &&
    entry.refId === found.id &&
    entry.source === 'manual' &&
    (entry.ttl === 'today' || entry.reason.includes('project-card'))
  )

  if (existing) {
    const removed = focusRemove(projectPath, sessionId, existing.id)
    return {
      success: removed.success,
      id: found.id,
      entityType: found.type,
      title: found.title,
      projectCard: false,
      error: removed.success ? undefined : 'Failed to remove project-card focus.'
    }
  }

  const added = focusAdd(projectPath, {
    sessionId,
    refType: 'artifact',
    refId: found.id,
    reason: 'project-card legacy alias',
    source: 'manual',
    ttl: 'today'
  })

  return {
    success: added.success,
    id: found.id,
    entityType: found.type,
    title: found.title,
    projectCard: true,
    error: added.error
  }
}

export function getProjectCards(projectPath?: string, sessionId: string = 'default'): ProjectCardEntity[] {
  if (!projectPath) return []

  return focusList(projectPath, sessionId).entries
    .filter(entry => entry.refType === 'artifact' && entry.source === 'manual' && (entry.ttl === 'today' || entry.reason.includes('project-card')))
    .map(entry => {
      const artifact = artifactGet(projectPath, entry.refId)
      if (!artifact) {
        return {
          type: 'artifact',
          id: entry.refId.slice(0, 8),
          title: entry.refId,
          summaryCard: undefined
        }
      }
      return {
        type: artifact.type,
        id: artifact.id.slice(0, 8),
        title: artifact.title,
        summaryCard: artifact.summary
      }
    })
}

export const togglePin = toggleProjectCard
export const getPinned = getProjectCards
export type PinResult = ProjectCardResult
export type PinnedEntity = ProjectCardEntity
