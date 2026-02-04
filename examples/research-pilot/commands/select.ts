/**
 * /workingset Command Handler (RFC-009)
 *
 * Manage WorkingSet - session-scoped entity selection for context assembly.
 * WorkingSet is runtime-only and NOT persisted to disk.
 *
 * This replaces the old /select command that persisted selectedForAI to entities.
 * Selection is now managed in-memory per session via WorkingSet.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

// In-memory WorkingSet storage (session-scoped)
const sessionWorkingSets = new Map<string, Set<string>>()

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
}

/**
 * Get or create WorkingSet for a session
 */
function getSessionWorkingSet(sessionId: string): Set<string> {
  if (!sessionWorkingSets.has(sessionId)) {
    sessionWorkingSets.set(sessionId, new Set())
  }
  return sessionWorkingSets.get(sessionId)!
}

/**
 * Resolve entity directory paths, optionally prefixed with projectPath
 */
function resolveEntityDirs(projectPath?: string): string[] {
  const base = [PATHS.notes, PATHS.literature, PATHS.data]
  return projectPath ? base.map(p => join(projectPath, p)) : base
}

/**
 * Find entity by ID across all entity directories
 */
function findEntity(entityId: string, projectPath?: string): { entity: Entity; filePath: string } | null {
  const dirs = resolveEntityDirs(projectPath)

  for (const dir of dirs) {
    if (!existsSync(dir)) continue

    const files = readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        const entity = JSON.parse(content) as Entity

        if (entity.id === entityId || entity.id.startsWith(entityId) || file.includes(entityId)) {
          return { entity, filePath }
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
    case 'literature': return entity.title
    case 'data': return entity.name
    default: return '(unknown)'
  }
}

/**
 * Add entity to WorkingSet for current session
 *
 * @param entityId - Entity ID (full or partial)
 * @param sessionId - Current session ID
 * @param projectPath - Optional project path
 */
export function addToWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const result = findEntity(entityId, projectPath)
  if (!result) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const { entity } = result
  const workingSet = getSessionWorkingSet(sessionId)
  workingSet.add(entity.id)

  return {
    success: true,
    entityType: entity.type,
    title: getEntityTitle(entity),
    inWorkingSet: true
  }
}

/**
 * Remove entity from WorkingSet for current session
 *
 * @param entityId - Entity ID (full or partial)
 * @param sessionId - Current session ID
 * @param projectPath - Optional project path
 */
export function removeFromWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const result = findEntity(entityId, projectPath)
  if (!result) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const { entity } = result
  const workingSet = getSessionWorkingSet(sessionId)
  workingSet.delete(entity.id)

  return {
    success: true,
    entityType: entity.type,
    title: getEntityTitle(entity),
    inWorkingSet: false
  }
}

/**
 * Toggle entity in WorkingSet for current session
 *
 * @param entityId - Entity ID (full or partial)
 * @param sessionId - Current session ID
 * @param projectPath - Optional project path
 */
export function toggleWorkingSet(
  entityId: string,
  sessionId: string,
  projectPath?: string
): WorkingSetResult {
  const result = findEntity(entityId, projectPath)
  if (!result) {
    return { success: false, error: `Entity not found: ${entityId}` }
  }

  const { entity } = result
  const workingSet = getSessionWorkingSet(sessionId)

  if (workingSet.has(entity.id)) {
    workingSet.delete(entity.id)
    return {
      success: true,
      entityType: entity.type,
      title: getEntityTitle(entity),
      inWorkingSet: false
    }
  } else {
    workingSet.add(entity.id)
    return {
      success: true,
      entityType: entity.type,
      title: getEntityTitle(entity),
      inWorkingSet: true
    }
  }
}

/**
 * Get all entities in WorkingSet for current session
 *
 * @param sessionId - Current session ID
 * @param projectPath - Optional project path
 */
export function getWorkingSet(sessionId: string, projectPath?: string): WorkingSetEntity[] {
  const workingSet = getSessionWorkingSet(sessionId)
  const entities: WorkingSetEntity[] = []

  for (const entityId of workingSet) {
    const result = findEntity(entityId, projectPath)
    if (result) {
      entities.push({
        type: result.entity.type,
        id: result.entity.id.slice(0, 8),
        title: getEntityTitle(result.entity),
        summaryCard: result.entity.summaryCard
      })
    }
  }

  return entities
}

/**
 * Get WorkingSet entity IDs for current session
 *
 * @param sessionId - Current session ID
 */
export function getWorkingSetIds(sessionId: string): string[] {
  const workingSet = getSessionWorkingSet(sessionId)
  return Array.from(workingSet)
}

/**
 * Clear WorkingSet for current session
 *
 * @param sessionId - Current session ID
 */
export function clearWorkingSet(sessionId: string): number {
  const workingSet = getSessionWorkingSet(sessionId)
  const count = workingSet.size
  workingSet.clear()
  return count
}

/**
 * Clear all session WorkingSets (e.g., on app restart)
 */
export function clearAllWorkingSets(): void {
  sessionWorkingSets.clear()
}

/**
 * Check if entity is in WorkingSet for current session
 *
 * @param entityId - Entity ID
 * @param sessionId - Current session ID
 */
export function isInWorkingSet(entityId: string, sessionId: string): boolean {
  const workingSet = getSessionWorkingSet(sessionId)
  return workingSet.has(entityId)
}

// Legacy aliases for backward compatibility
export const toggleSelect = (entityId: string, projectPath?: string, sessionId: string = 'default') =>
  toggleWorkingSet(entityId, sessionId, projectPath)
export const getSelected = (projectPath?: string, sessionId: string = 'default') =>
  getWorkingSet(sessionId, projectPath)
export const clearSelections = (sessionId: string = 'default') =>
  clearWorkingSet(sessionId)
export type SelectResult = WorkingSetResult
export type SelectedEntity = WorkingSetEntity
