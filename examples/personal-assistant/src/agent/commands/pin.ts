/**
 * /pin Command Handler
 *
 * Toggle pinned status for an entity.
 * Pinned entities are always included in context (pinned phase).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

export interface PinResult {
  success: boolean
  entityType?: string
  title?: string
  pinned?: boolean
  error?: string
}

export interface PinnedEntity {
  type: string
  id: string
  title: string
}

/**
 * Resolve entity directory paths, optionally prefixed with projectPath
 */
function resolveEntityDirs(projectPath?: string): string[] {
  const base = [PATHS.notes, PATHS.todos, PATHS.docs]
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
        // Skip files that can't be parsed
      }
    }
  }

  return null
}

/** Get display title for an entity */
function getEntityTitle(entity: Entity): string {
  switch (entity.type) {
    case 'note': return entity.title
    case 'todo': return entity.title
    case 'doc': return entity.title
    default: return '(unknown)'
  }
}

/** Toggle pinned status for an entity by ID */
export function togglePin(entityId: string, projectPath?: string): PinResult {
  const filePath = findEntityFile(entityId, projectPath)
  if (!filePath) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const entity = JSON.parse(content) as Entity
    entity.pinned = !entity.pinned
    entity.updatedAt = new Date().toISOString()
    writeFileSync(filePath, JSON.stringify(entity, null, 2))

    return {
      success: true,
      entityType: entity.type,
      title: getEntityTitle(entity),
      pinned: entity.pinned
    }
  } catch (error) {
    return { success: false, error: `Failed to update entity: ${error}` }
  }
}

/** List all pinned entities */
export function getPinned(projectPath?: string): PinnedEntity[] {
  const dirs = resolveEntityDirs(projectPath)
  const pinned: PinnedEntity[] = []

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity
        if (entity.pinned) {
          pinned.push({
            type: entity.type,
            id: entity.id.slice(0, 8),
            title: getEntityTitle(entity)
          })
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  return pinned
}
