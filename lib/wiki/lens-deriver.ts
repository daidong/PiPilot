/**
 * Lens Deriver — RFC-005 §6.2.1.
 *
 * Converts a project-scoped PaperArtifact into a ProjectLens and merges it
 * into an existing lens array, idempotent by project_path.
 */

import type { PaperArtifact } from '../types.js'
import type { ProjectLens } from './memory-schema.js'

/**
 * Derive a lens from a project artifact. Returns null if the artifact has
 * nothing useful to record (no subtopic, no relevance justification).
 */
export function deriveLensFromArtifact(
  artifact: PaperArtifact,
  projectPath: string,
  now: string = new Date().toISOString(),
): ProjectLens | null {
  const why = artifact.relevanceJustification?.trim()
  const sub = artifact.subTopic?.trim()

  // If both are empty, the lens would be content-free — skip it.
  // The project_path itself still appears in provenance_projects via a different path.
  if (!why && !sub) return null

  const lens: ProjectLens = {
    project_path: projectPath,
    added_at: now,
  }
  if (why) lens.why_it_mattered = why
  if (sub) lens.subtopic = sub
  return lens
}

/**
 * Merge a new lens into an existing array, idempotent by project_path.
 *
 * Rules (RFC-005 §6.2.1):
 *   - if project_path already has a lens, UPDATE it in place (overwrite content, preserve added_at? no — bump it)
 *   - if project_path is new, APPEND the new lens
 *
 * Rationale: re-running the scanner should not grow the array unboundedly.
 * Updating in place means the most recent scan wins (captures any edited
 * relevance justification).
 */
export function mergeLens(
  existing: ProjectLens[] | undefined,
  incoming: ProjectLens,
): ProjectLens[] {
  const arr = existing ? [...existing] : []
  const idx = arr.findIndex(l => l.project_path === incoming.project_path)
  if (idx >= 0) {
    arr[idx] = incoming
  } else {
    arr.push(incoming)
  }
  return arr
}

/**
 * Deterministically union `provenance_projects` with a new project path.
 * Preserves order; first seen wins.
 */
export function unionProvenanceProjects(
  existing: string[] | undefined,
  projectPath: string,
): string[] {
  const arr = existing ? [...existing] : []
  if (!arr.includes(projectPath)) arr.push(projectPath)
  return arr
}
