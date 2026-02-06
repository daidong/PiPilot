/**
 * Delete wrapper over Memory V2 artifact delete.
 */

import { artifactDelete } from './artifact.js'

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
