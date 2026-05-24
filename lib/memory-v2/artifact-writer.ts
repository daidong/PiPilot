/**
 * Write/remove artifact FILES (RFC-014 §6 write path).
 *
 * Canonical locations (workspace root, type-named dirs per §4.1):
 *   - note / web-content / tool-output → `<type-dir>/<id>.md`
 *   - data                            → `<datafile>.rp.yaml` sidecar (next to the data file)
 *   - paper                           → `papers/<citeKey>.bib` + `papers/<citeKey>.rp.yaml`
 *                                       (one file per paper — RFC-014 §4.3)
 *
 * Each write also removes any leftover legacy `.research-pilot/artifacts/<type>/<id>.json`
 * for the same id, so the file becomes the single source of truth (migrate-on-write).
 *
 * No dependency on store.ts / indexer.ts (store imports this) — only artifact-files
 * (leaf) + fs + yaml.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { stringify as stringifyYaml } from 'yaml'
import { PATHS, type Artifact, type ArtifactType, type PaperArtifact } from '../types.js'
import {
  markdownArtifactToText,
  dataArtifactToSidecar,
  paperToBibEntry,
  paperToSidecarEntry,
  PAPER_BIB_EXT,
  RP_SIDECAR_SUFFIX
} from './artifact-files.js'

// note + tool-output → shared Markdown files at the workspace root.
// web-content is deliberately EXCLUDED: it stays local JSON inside .research-pilot
// (RFC-013 decision — not shared; exempt from files-as-carrier).
const MD_TYPE_DIR: Record<'note' | 'tool-output', string> = {
  note: 'notes',
  'tool-output': 'tool-output'
}
const PAPER_DIR = 'papers'

/** Filesystem-safe filename stem for a paper, derived from its citeKey. */
function paperSlug(citeKey: string): string {
  const s = (citeKey ?? '').trim().replace(/[/\\:*?"<>|\s]+/g, '_')
  return s || 'paper'
}

function legacyJsonRel(type: ArtifactType, id: string): string {
  const dir =
    type === 'note' ? PATHS.notes
    : type === 'paper' ? PATHS.papers
    : type === 'data' ? PATHS.data
    : type === 'web-content' ? PATHS.webContent
    : PATHS.toolOutputs
  return join(dir, `${id}.json`)
}

function removeLegacyJson(projectPath: string, artifact: Artifact): void {
  try {
    const p = join(projectPath, legacyJsonRel(artifact.type, artifact.id))
    if (existsSync(p)) rmSync(p, { force: true })
  } catch {
    // best-effort
  }
}

/** Workspace-relative path of an artifact's primary backing file. */
export function primaryFileRel(artifact: Artifact): string {
  switch (artifact.type) {
    case 'note':
    case 'tool-output':
      return `${MD_TYPE_DIR[artifact.type]}/${artifact.id}.md`
    case 'web-content':
      return join(PATHS.webContent, `${artifact.id}.json`)
    case 'data':
      return `${artifact.filePath}${RP_SIDECAR_SUFFIX}`
    case 'paper':
      return `${PAPER_DIR}/${paperSlug(artifact.citeKey)}${PAPER_BIB_EXT}`
  }
}

function paperSidecarRel(paper: PaperArtifact): string {
  return `${PAPER_DIR}/${paperSlug(paper.citeKey)}${RP_SIDECAR_SUFFIX}`
}

/** Write an artifact's file(s). Returns the workspace-relative primary path. */
export function writeArtifactToFile(projectPath: string, artifact: Artifact): string {
  if (artifact.type === 'note' || artifact.type === 'tool-output') {
    const rel = primaryFileRel(artifact)
    const abs = join(projectPath, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, markdownArtifactToText(artifact), 'utf-8')
    removeLegacyJson(projectPath, artifact)
    return rel
  }
  if (artifact.type === 'web-content') {
    // Local-only JSON inside .research-pilot (RFC-013: web-content is not shared).
    // This path IS its canonical home, so we do NOT remove it as "legacy".
    const rel = primaryFileRel(artifact)
    const abs = join(projectPath, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(artifact, null, 2), 'utf-8')
    return rel
  }
  if (artifact.type === 'data') {
    const rel = primaryFileRel(artifact)
    const abs = join(projectPath, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, stringifyYaml(dataArtifactToSidecar(artifact)), 'utf-8')
    removeLegacyJson(projectPath, artifact)
    return rel
  }
  // paper → one .bib + one flat .rp.yaml sidecar
  const paper = artifact as PaperArtifact
  const bibRel = primaryFileRel(paper)
  const bibAbs = join(projectPath, bibRel)
  mkdirSync(dirname(bibAbs), { recursive: true })
  writeFileSync(bibAbs, paperToBibEntry(paper) + '\n', 'utf-8')
  writeFileSync(join(projectPath, paperSidecarRel(paper)), stringifyYaml(paperToSidecarEntry(paper)), 'utf-8')
  removeLegacyJson(projectPath, paper)
  return bibRel
}

/** Remove an artifact's file(s) (+ any legacy JSON). Leaves user data files intact. */
export function removeArtifactFile(projectPath: string, artifact: Artifact): void {
  try {
    if (artifact.type === 'paper') {
      for (const rel of [primaryFileRel(artifact), paperSidecarRel(artifact as PaperArtifact)]) {
        const abs = join(projectPath, rel)
        if (existsSync(abs)) rmSync(abs, { force: true })
      }
    } else {
      // note/web/tool → the .md; data → the sidecar (NOT the data file itself).
      const abs = join(projectPath, primaryFileRel(artifact))
      if (existsSync(abs)) rmSync(abs, { force: true })
    }
  } catch {
    // best-effort
  }
  removeLegacyJson(projectPath, artifact)
}
