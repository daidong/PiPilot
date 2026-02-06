/**
 * Deprecated compatibility wrapper.
 *
 * RFC-012 replaces ProjectCard pinning with fact.promote/fact.demote.
 * This file keeps old callers functioning by toggling a legacy marker field.
 */

import { findArtifactById, listArtifacts, updateArtifact } from '../memory-v2/store.js'

export interface ProjectCardResult {
  success: boolean
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

export function toggleProjectCard(entityId: string, projectPath?: string): ProjectCardResult {
  const root = projectPath ?? process.cwd()
  const found = findArtifactById(root, entityId)
  if (!found) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const next = !(found.artifact.projectCard ?? false)
  const updated = updateArtifact(root, found.artifact.id, {
    // Compatibility marker for older clients.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...( { projectCard: next, projectCardSource: 'manual', pinned: next } as any )
  })

  if (!updated) {
    return { success: false, error: `Failed to update entity: ${entityId}` }
  }

  return {
    success: true,
    entityType: updated.artifact.type,
    title: updated.artifact.title,
    projectCard: next
  }
}

export function getProjectCards(projectPath?: string): ProjectCardEntity[] {
  const root = projectPath ?? process.cwd()
  return listArtifacts(root)
    .filter(item => item.projectCard === true || item.pinned === true)
    .map(item => ({
      type: item.type,
      id: item.id.slice(0, 8),
      title: item.title,
      summaryCard: item.summary
    }))
}

// Legacy aliases
export const togglePin = toggleProjectCard
export const getPinned = getProjectCards
export type PinResult = ProjectCardResult
export type PinnedEntity = ProjectCardEntity
