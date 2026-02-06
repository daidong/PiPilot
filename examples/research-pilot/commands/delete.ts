/**
 * Delete artifact by ID.
 */

import { deleteArtifact } from '../memory-v2/store.js'

export interface DeleteResult {
  success: boolean
  entityType?: string
  title?: string
  error?: string
}

export function deleteEntity(entityId: string, projectPath: string): DeleteResult {
  if (!entityId) {
    return { success: false, error: 'Entity ID is required.' }
  }

  const deleted = deleteArtifact(projectPath, entityId)
  if (!deleted) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  return {
    success: true,
    entityType: deleted.artifact.type,
    title: deleted.artifact.title
  }
}
