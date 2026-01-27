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

/** Toggle selection for an entity by ID */
export function toggleSelect(entityId: string): SelectResult {
  const filePath = findEntityFile(entityId)
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
export function getSelected(): SelectedEntity[] {
  const dirs = [PATHS.notes, PATHS.literature, PATHS.data]
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
export function clearSelections(): number {
  const dirs = [PATHS.notes, PATHS.literature, PATHS.data]
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

/**
 * Handle /select command (legacy readline mode)
 */
export async function handleSelect(args: string[]): Promise<void> {
  if (args.includes('--list')) {
    const selected = getSelected()
    if (selected.length === 0) {
      console.log('No entities selected for AI context.')
      console.log('Use /select <id> to select entities.')
      return
    }
    console.log('Selected entities for AI context:')
    console.log('')
    for (const item of selected) {
      console.log(`  [${item.type}] ${item.id}... - ${item.title}`)
    }
    console.log('')
    console.log(`Total: ${selected.length} selected`)
    return
  }

  if (args.includes('--clear')) {
    const count = clearSelections()
    console.log(`✓ Cleared ${count} selection(s)`)
    return
  }

  const entityId = args[0]
  if (!entityId) {
    console.log('Usage: /select <id> | /select --list | /select --clear')
    return
  }

  const result = toggleSelect(entityId)
  if (result.success) {
    const status = result.selected ? 'selected for AI context' : 'removed from AI context'
    console.log(`✓ ${result.entityType} "${result.title}" ${status}`)
  } else {
    console.log(result.error)
  }
}
