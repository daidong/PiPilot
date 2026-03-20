/**
 * Delete wrapper over Memory V2 artifact delete.
 */

import { artifactDelete } from './artifact.js'
import { AGENT_MD_ID } from '../types.js'

export interface DeleteResult {
  success: boolean
  entityType?: string
  title?: string
  error?: string
}

export function deleteEntity(entityId: string, projectPath?: string): DeleteResult {
  if (!entityId) {
    return { success: false, error: 'Entity ID is required.' }
  }
  if (!projectPath) {
    return { success: false, error: 'Project path is required.' }
  }

  if (entityId === AGENT_MD_ID) {
    return { success: false, error: 'agent.md cannot be deleted.' }
  }

  const deleted = artifactDelete(projectPath, entityId)
  if (!deleted.success || !deleted.artifact) {
    return { success: false, error: deleted.error ?? `Entity not found: ${entityId}` }
  }

  return {
    success: true,
    entityType: deleted.artifact.type,
    title: deleted.artifact.title
  }
}
