/**
 * Artifact search helpers.
 */

import { type ArtifactType } from '../types.js'
import { searchArtifacts } from '../memory-v2/store.js'

export interface SearchResult {
  type: ArtifactType
  id: string
  title: string
  match: string
  score: number
}

export function searchEntities(projectPath: string, query: string, types?: ArtifactType[]): SearchResult[] {
  return searchArtifacts(projectPath, query, types).map(hit => ({
    type: hit.artifact.type,
    id: hit.artifact.id.slice(0, 8),
    title: hit.artifact.title,
    match: hit.match,
    score: hit.score
  }))
}
