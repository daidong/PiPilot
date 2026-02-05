/**
 * /project Command Handler (RFC-009)
 *
 * Toggle Project Card status for an entity.
 * Project Cards represent core decisions and constraints for long-term memory.
 *
 * Renamed from /pin to /project to reflect new semantics.
 * Legacy /pin command is aliased for backward compatibility.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

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

/**
 * Toggle Project Card status for an entity by ID
 *
 * @param entityId - Entity ID (full or partial)
 * @param projectPath - Optional project path
 */
export function toggleProjectCard(entityId: string, projectPath?: string): ProjectCardResult {
  const filePath = findEntityFile(entityId, projectPath)
  if (!filePath) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const entity = JSON.parse(content) as Entity

    // Toggle projectCard status (manual override)
    entity.projectCard = !entity.projectCard
    entity.projectCardSource = 'manual'
    entity.updatedAt = new Date().toISOString()

    // Migrate legacy field if present
    if ('pinned' in entity) {
      delete (entity as Record<string, unknown>).pinned
    }

    writeFileSync(filePath, JSON.stringify(entity, null, 2))

    return {
      success: true,
      id: entity.id,
      entityType: entity.type,
      title: getEntityTitle(entity),
      projectCard: entity.projectCard
    }
  } catch (error) {
    return { success: false, error: `Failed to update entity: ${error}` }
  }
}

/**
 * List all Project Card entities
 *
 * @param projectPath - Optional project path
 */
export function getProjectCards(projectPath?: string): ProjectCardEntity[] {
  const dirs = resolveEntityDirs(projectPath)
  const projectCards: ProjectCardEntity[] = []

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity

        // Check for projectCard or legacy pinned
        const isProjectCard = entity.projectCard || (entity as Record<string, unknown>).pinned === true

        if (isProjectCard) {
          projectCards.push({
            type: entity.type,
            id: entity.id.slice(0, 8),
            title: getEntityTitle(entity),
            summaryCard: entity.summaryCard
          })
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  return projectCards
}

// Legacy aliases for backward compatibility
export const togglePin = toggleProjectCard
export const getPinned = getProjectCards
export type PinResult = ProjectCardResult
export type PinnedEntity = ProjectCardEntity
