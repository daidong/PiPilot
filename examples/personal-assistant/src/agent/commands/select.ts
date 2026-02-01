/**
 * /select Command Handler
 *
 * Toggle context selection for an entity.
 * Selected entities are included in the 'selected' phase of context assembly.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

export interface SelectResult {
  success: boolean
  entityType?: string
  title?: string
  selected?: boolean
  error?: string
}

export interface SelectedEntity {
  type: string
  id: string
  title: string
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
    case 'doc': return entity.title
    default: return '(unknown)'
  }
}

/** Toggle selection for an entity by ID */
export function toggleSelect(entityId: string, projectPath?: string): SelectResult {
  const filePath = findEntityFile(entityId, projectPath)
  if (!filePath) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const entity = JSON.parse(content) as Entity
    entity.selectedForAI = !entity.selectedForAI
    entity.updatedAt = new Date().toISOString()
    writeFileSync(filePath, JSON.stringify(entity, null, 2))

    return {
      success: true,
      entityType: entity.type,
      title: getEntityTitle(entity),
      selected: entity.selectedForAI
    }
  } catch (error) {
    return { success: false, error: `Failed to update entity: ${error}` }
  }
}

/** List all selected entities */
export function getSelected(projectPath?: string): SelectedEntity[] {
  const dirs = resolveEntityDirs(projectPath)
  const selected: SelectedEntity[] = []

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity
        if (entity.selectedForAI) {
          selected.push({
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

  return selected
}

/** Clear all selections, returns count cleared */
export function clearSelections(projectPath?: string): number {
  const dirs = resolveEntityDirs(projectPath)
  let count = 0

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity
        if (entity.selectedForAI) {
          entity.selectedForAI = false
          entity.updatedAt = new Date().toISOString()
          writeFileSync(filePath, JSON.stringify(entity, null, 2))
          count++
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  return count
}
