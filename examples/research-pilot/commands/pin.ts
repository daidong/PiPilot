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
 * Find entity file by ID across all entity directories
 */
function findEntityFile(entityId: string): string | null {
  const dirs = [PATHS.notes, PATHS.literature, PATHS.data]

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
    case 'literature': return entity.title
    case 'data': return entity.name
    default: return '(unknown)'
  }
}

/** Toggle pinned status for an entity by ID */
export function togglePin(entityId: string): PinResult {
  const filePath = findEntityFile(entityId)
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
export function getPinned(): PinnedEntity[] {
  const dirs = [PATHS.notes, PATHS.literature, PATHS.data]
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

/**
 * Handle /pin command (legacy readline mode)
 */
export async function handlePin(args: string[]): Promise<void> {
  if (args.includes('--list')) {
    const pinned = getPinned()
    if (pinned.length === 0) {
      console.log('No entities pinned.')
      console.log('Use /pin <id> to pin entities (always included in context).')
      return
    }
    console.log('Pinned entities (always in context):')
    console.log('')
    for (const item of pinned) {
      console.log(`  [${item.type}] ${item.id}... - ${item.title}`)
    }
    console.log('')
    console.log(`Total: ${pinned.length} pinned`)
    return
  }

  const entityId = args[0]
  if (!entityId) {
    console.log('Usage: /pin <id> | /pin --list')
    return
  }

  const result = togglePin(entityId)
  if (result.success) {
    const status = result.pinned ? 'pinned (always in context)' : 'unpinned'
    console.log(`✓ ${result.entityType} "${result.title}" ${status}`)
  } else {
    console.log(result.error)
  }
}
