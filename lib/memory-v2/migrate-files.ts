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

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS, type Artifact, type ArtifactType } from '../types.js'
import { readArtifactFromFile } from './artifact-files.js'
import { writeArtifactToFile, primaryFileRel, legacyMdFileRel } from './artifact-writer.js'
import { rebuildIndex, scanWorkspaceArtifacts } from './indexer.js'

const MARKER_REL = join(PATHS.root, '.artifact-model')
const ARCHIVE_REL = join(PATHS.root, 'artifacts-legacy')
// Separate marker for the one-time note/tool-output filename convergence
// (id-named `.md` → `<title-slug>-<frag>.md`). Distinct from the files-model
// marker so it runs once even on workspaces already migrated to files.
const MD_FILENAME_MARKER_REL = join(PATHS.root, '.note-filenames')

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

/** True once the one-time filename convergence has run for this project. */
export function isNoteFilenamesConverged(projectPath: string): boolean {
  return existsSync(join(projectPath, MD_FILENAME_MARKER_REL))
}

/**
 * One-time convergence of legacy id-named note/tool-output files
 * (`rp-artifacts/notes/[<actor>/]<id>.md`) to the title-based scheme
 * (`<title-slug>-<frag>.md`). The file's content is unchanged — only its name.
 *
 * Safe to call on every project open: gated by a marker, and idempotent anyway
 * (a file already at the new path has no legacy `<id>.md` sibling to rename).
 * Returns the number of files renamed. Caller should rebuildIndex afterward so
 * any cached shard paths are refreshed (the index keys on rp.id, so entries
 * survive the rename regardless).
 */
export function convergeManagedMdFilenames(projectPath: string): number {
  if (isNoteFilenamesConverged(projectPath)) return 0

  let scanned: Artifact[]
  try {
    scanned = scanWorkspaceArtifacts(projectPath)
  } catch {
    return 0   // can't scan → leave the marker unset so it retries next open
  }

  let renamed = 0
  for (const a of scanned) {
    if (a.type !== 'note' && a.type !== 'tool-output') continue
    const legacyRel = legacyMdFileRel(a)
    if (!legacyRel) continue
    const newRel = primaryFileRel(a)
    if (legacyRel === newRel) continue                 // already title-named
    const legacyAbs = join(projectPath, legacyRel)
    if (!existsSync(legacyAbs)) continue               // nothing legacy to move
    try {
      // Write the new-named file from the artifact, then drop the old one only
      // after the new file is confirmed on disk (never lose content).
      writeArtifactToFile(projectPath, a)
      if (existsSync(join(projectPath, newRel))) {
        rmSync(legacyAbs, { force: true })
        renamed++
      }
    } catch {
      // best-effort per file; a failure here just leaves the legacy file in place
    }
  }

  try {
    mkdirSync(join(projectPath, PATHS.root), { recursive: true })
    writeFileSync(join(projectPath, MD_FILENAME_MARKER_REL), '1', 'utf-8')
  } catch {
    // marker write failed → harmlessly retries next open
  }
  return renamed
}
