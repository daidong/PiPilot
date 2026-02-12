import { type Artifact, type ArtifactType, type CLIContext, AGENT_MD_ID, AGENT_MD_MAX_CHARS } from '../types.js'
import {
  createArtifact,
  deleteArtifact,
  findArtifactById,
  listArtifacts,
  searchArtifacts,
  updateArtifact,
  type CreateArtifactInput,
  type UpdateArtifactInput
} from '../memory-v2/store.js'

export interface ArtifactCreateResult {
  success: boolean
  artifact?: Artifact
  filePath?: string
  error?: string
}

export interface ArtifactUpdateResult {
  success: boolean
  artifact?: Artifact
  filePath?: string
  error?: string
}

export interface ArtifactDeleteResult {
  success: boolean
  artifact?: Artifact
  error?: string
}

export interface ArtifactSearchResult {
  id: string
  type: ArtifactType
  title: string
  score: number
  match: string
}

export function artifactCreate(input: CreateArtifactInput, context: CLIContext): ArtifactCreateResult {
  try {
    const { artifact, filePath } = createArtifact(input, context)
    return { success: true, artifact, filePath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function artifactUpdate(projectPath: string, artifactId: string, patch: UpdateArtifactInput): ArtifactUpdateResult {
  if (artifactId === AGENT_MD_ID && patch.content && patch.content.length > AGENT_MD_MAX_CHARS) {
    return { success: false, error: `agent.md cannot exceed ${AGENT_MD_MAX_CHARS} characters.` }
  }
  try {
    const updated = updateArtifact(projectPath, artifactId, patch)
    if (!updated) {
      return { success: false, error: `Artifact not found: ${artifactId}` }
    }
    return { success: true, artifact: updated.artifact, filePath: updated.filePath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function artifactGet(projectPath: string, artifactId: string): Artifact | null {
  return findArtifactById(projectPath, artifactId)?.artifact ?? null
}

export function artifactList(projectPath: string, types?: ArtifactType[]): Artifact[] {
  return listArtifacts(projectPath, types)
}

export function artifactSearch(projectPath: string, query: string, types?: ArtifactType[]): ArtifactSearchResult[] {
  return searchArtifacts(projectPath, query, types).map(hit => ({
    id: hit.artifact.id,
    type: hit.artifact.type,
    title: hit.artifact.title,
    score: hit.score,
    match: hit.match
  }))
}

export function artifactDelete(projectPath: string, artifactId: string): ArtifactDeleteResult {
  if (artifactId === AGENT_MD_ID) {
    return { success: false, error: 'agent.md cannot be deleted.' }
  }
  try {
    const deleted = deleteArtifact(projectPath, artifactId)
    if (!deleted) {
      return { success: false, error: `Artifact not found: ${artifactId}` }
    }
    return { success: true, artifact: deleted.artifact }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
