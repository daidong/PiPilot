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

const caches = new Map<string, EntityCache>()

/**
 * Get cached entity listings for a project.
 * Rebuilds on first call or after invalidation.
 * Each project path gets its own independent cache.
 */
export function getEntityCache(projectPath: string): EntityCache {
  let c = caches.get(projectPath)
  if (c) return c
  c = {
    notes: listNotes(projectPath),
    papers: listLiterature(projectPath),
    data: listData(projectPath)
  }
  caches.set(projectPath, c)
  return c
}

/** Force the next getEntityCache call to rebuild. */
export function invalidateEntityCache(projectPath?: string): void {
  if (projectPath) {
    caches.delete(projectPath)
  } else {
    caches.clear()
  }
}
