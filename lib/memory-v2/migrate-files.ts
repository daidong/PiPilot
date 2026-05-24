/**
 * One-time migration from legacy `.research-pilot/artifacts/<type>/<uuid>.json`
 * to the files-as-carrier model (RFC-014 §8). Idempotent, gated by a marker
 * file. Legacy JSON is backed up to `.research-pilot/artifacts-legacy/` before
 * conversion (reversible) — the new files become the source of truth.
 *
 * Not required for reads: the indexer lazily ingests legacy JSON until this
 * runs. Running it makes the workspace files canonical and removes the split
 * between new-format and legacy artifacts.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS, type Artifact, type ArtifactType } from '../types.js'
import { readArtifactFromFile } from './artifact-files.js'
import { writeArtifactToFile } from './artifact-writer.js'
import { rebuildIndex } from './indexer.js'

const MARKER_REL = join(PATHS.root, '.artifact-model')
const ARCHIVE_REL = join(PATHS.root, 'artifacts-legacy')

// web-content is intentionally NOT migrated: it stays as local JSON inside
// `.research-pilot/artifacts/web-content/` (RFC-013 decision — not shared,
// exempt from files-as-carrier). The indexer still reads it via the legacy scan.
const LEGACY_DIRS: Array<{ type: ArtifactType; rel: string }> = [
  { type: 'note', rel: PATHS.notes },
  { type: 'paper', rel: PATHS.papers },
  { type: 'data', rel: PATHS.data },
  { type: 'tool-output', rel: PATHS.toolOutputs }
]

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** True once the files-as-carrier migration has completed for this project. */
export function isFilesModelMigrated(projectPath: string): boolean {
  return existsSync(join(projectPath, MARKER_REL))
}

export interface MigrationResult {
  migrated: number
  skipped: boolean
}

/**
 * Convert all legacy artifact JSON to workspace files. Safe to call repeatedly;
 * a no-op once the marker is set.
 */
export function migrateToFilesAsCarrier(projectPath: string): MigrationResult {
  if (isFilesModelMigrated(projectPath)) return { migrated: 0, skipped: true }

  const artifacts: Artifact[] = []

  for (const { rel } of LEGACY_DIRS) {
    const dir = join(projectPath, rel)
    if (!existsSync(dir)) continue
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith('.json')) continue
      const src = join(dir, file)
      // Back up before conversion (writeArtifactToFile deletes the original).
      try {
        const archiveDir = join(projectPath, ARCHIVE_REL, rel.replace(`${PATHS.artifactsRoot}/`, ''))
        mkdirSync(archiveDir, { recursive: true })
        copyFileSync(src, join(archiveDir, file))
      } catch {
        // backup is best-effort; continue
      }
      const artifact = readArtifactFromFile(src)
      if (!artifact) continue
      artifacts.push(artifact)
    }
  }

  for (const a of artifacts) writeArtifactToFile(projectPath, a)

  rebuildIndex(projectPath)
  try {
    mkdirSync(join(projectPath, PATHS.root), { recursive: true })
    writeFileSync(join(projectPath, MARKER_REL), '2', 'utf-8')
  } catch {
    // If the marker can't be written, migration will harmlessly retry next time.
  }

  return { migrated: artifacts.length, skipped: false }
}
