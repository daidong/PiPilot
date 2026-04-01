/**
 * Entity Index
 *
 * Caches entity listings (notes, papers, data) in memory to avoid
 * re-scanning JSON files on every mention autocomplete request.
 * Call invalidateEntityCache() after artifact-create / artifact-update.
 */

import { listNotes, listLiterature, listData } from '../commands/index.js'

export interface EntityCache {
  notes: ReturnType<typeof listNotes>
  papers: ReturnType<typeof listLiterature>
  data: ReturnType<typeof listData>
}

let cache: EntityCache | null = null
let cachePath = ''

/**
 * Get cached entity listings for a project.
 * Rebuilds on first call or after invalidation.
 */
export function getEntityCache(projectPath: string): EntityCache {
  if (cache && cachePath === projectPath) return cache
  cache = {
    notes: listNotes(projectPath),
    papers: listLiterature(projectPath),
    data: listData(projectPath)
  }
  cachePath = projectPath
  return cache
}

/** Force the next getEntityCache call to rebuild. */
export function invalidateEntityCache(): void {
  cache = null
}
