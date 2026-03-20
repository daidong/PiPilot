/**
 * Search wrapper over Memory V2 artifact search.
 */

import { artifactSearch } from './artifact.js'

export interface SearchResult {
  type: string
  id: string
  title: string
  match: string
}

export function searchEntities(projectPath: string, query: string): SearchResult[] {
  return artifactSearch(projectPath, query).map(hit => ({
    type: hit.type,
    id: hit.id.slice(0, 8),
    title: hit.title,
    match: hit.match
  }))
}
