/**
 * /delete Command Handler
 *
 * Delete an entity (note or doc) by ID.
 */

import { readFileSync, unlinkSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

export interface DeleteResult {
  success: boolean
  entityType?: string
  title?: string
  error?: string
}

/**
 * Resolve entity directory paths, optionally prefixed with projectPath
 */
function resolveEntityDirs(projectPath?: string): string[] {
  const base = [PATHS.notes, PATHS.docs]
  return projectPath ? base.map(p => join(projectPath, p)) : base
}

/**
 * Find entity file by ID across all entity directories
 */
function findEntityFile(entityId: string, projectPath?: string): string | null {
  const dirs = resolveEntityDirs(projectPath)

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      if (file.includes(entityId)) {
        return join(dir, file)
      }
      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity
        if (entity.id === entityId || entity.id.startsWith(entityId)) {
          return filePath
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  return null
}

/** Get display title for an entity */
function getEntityTitle(entity: Entity): string {
  switch (entity.type) {
    case 'note': return entity.title
    case 'doc': return entity.title
    default: return '(unknown)'
  }
}

/**
 * Delete an entity by ID.
 */
export function deleteEntity(entityId: string, projectPath?: string): DeleteResult {
  if (!entityId) {
    return { success: false, error: 'Entity ID is required.' }
  }

  const filePath = findEntityFile(entityId, projectPath)
  if (!filePath) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const entity = JSON.parse(content) as Entity
    const title = getEntityTitle(entity)
    const entityType = entity.type

    unlinkSync(filePath)

    return { success: true, entityType, title }
  } catch (error) {
    return { success: false, error: `Failed to delete entity: ${error}` }
  }
}
