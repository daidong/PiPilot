/**
 * Search Command - Search across all entities and return structured results.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { PATHS, Entity } from '../types.js'

export interface SearchResult {
  type: string
  id: string
  title: string
  match: string
}

/** Get display title for an entity */
function getEntityTitle(entity: Entity): string {
  switch (entity.type) {
    case 'note':
      return entity.title
    case 'doc':
      return entity.title
    default:
      return '(unknown)'
  }
}

/** Search across all entities, returning structured results */
export function searchEntities(projectPath: string, query: string): SearchResult[] {
  const queryLower = query.toLowerCase()
  const results: SearchResult[] = []

  const dirs = [
    { path: PATHS.notes, type: 'note' },
    { path: PATHS.docs, type: 'doc' }
  ]

  for (const { path, type } of dirs) {
    const dir = join(projectPath, path)
    if (!existsSync(dir)) continue

    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const entity = JSON.parse(content) as Entity

        let match: string | null = null

        if (entity.type === 'note') {
          if (entity.title.toLowerCase().includes(queryLower)) {
            match = `title: ${entity.title}`
          } else if (entity.content.toLowerCase().includes(queryLower)) {
            match = `content: ...${entity.content.toLowerCase().indexOf(queryLower)}...`
          } else if (entity.tags.some(t => t.toLowerCase().includes(queryLower))) {
            match = `tag: ${entity.tags.find(t => t.toLowerCase().includes(queryLower))}`
          }
        } else if (entity.type === 'doc') {
          if (entity.title.toLowerCase().includes(queryLower)) {
            match = `title: ${entity.title}`
          } else if (entity.description?.toLowerCase().includes(queryLower)) {
            match = `description: ...`
          }
        }

        if (match) {
          results.push({
            type: entity.type,
            id: entity.id.slice(0, 8),
            title: getEntityTitle(entity),
            match
          })
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  return results
}
