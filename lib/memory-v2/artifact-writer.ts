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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { PATHS, AGENT_MD_ID, type Artifact, type ArtifactType, type PaperArtifact } from '../types.js'
import { slugifyDisplayName } from '../sharing/identity.js'
import {
  markdownArtifactToText,
  dataArtifactToSidecar,
  paperToBibEntry,
  paperToSidecarEntry,
  PAPER_BIB_EXT,
  RP_SIDECAR_SUFFIX
} from './artifact-files.js'

// Artifacts live under a single distinctive top-level dir, `rp-artifacts/`, so
// they never collide with the user's own `notes/`, `papers/`, etc. (RFC-013;
// mirrors the `rp-pi-guidance/` convention). web-content is EXCLUDED: it stays
// local JSON inside .research-pilot (not shared; exempt from files-as-carrier).
const RP_ARTIFACTS_DIR = 'rp-artifacts'
const MD_TYPE_DIR: Record<'note' | 'tool-output', string> = {
  note: `${RP_ARTIFACTS_DIR}/notes`,
  'tool-output': `${RP_ARTIFACTS_DIR}/tool-output`
}
const PAPER_DIR = `${RP_ARTIFACTS_DIR}/papers`

/** Filesystem-safe filename stem for a paper, derived from its citeKey. */
function paperSlug(citeKey: string): string {
  const s = (citeKey ?? '').trim().replace(/[/\\:*?"<>|\s]+/g, '_')
  return s || 'paper'
}

/**
 * Short, stable id fragment appended to a human-named artifact filename so two
 * artifacts that share a slug (two papers with the same citeKey, two notes with
 * the same title) never map to the same file and silently overwrite each other.
 * Derived purely from the artifact id, so the path stays a pure function of the
 * artifact (find/update/delete recompute it).
 */
function idFrag(id: string): string {
  return ((id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x').toLowerCase()
}

/**
 * Filesystem-safe, human-readable filename stem for a note / tool-output,
 * derived from its title. Mirrors paperSlug (keeps CJK and other readable
 * characters, neutralises only path separators + reserved chars) and truncates
 * so the full `<slug>-<frag>.md` comfortably clears filesystem name limits.
 * Falls back to `note` when the title yields nothing usable.
 */
function noteSlug(title: string): string {
  let s = (title ?? '').trim().replace(/[/\\:*?"<>|\s]+/g, '_')
  s = s.replace(/^[._-]+|[._-]+$/g, '').slice(0, 60).replace(/[._-]+$/g, '')
  return s || 'note'
}

/**
 * RFC-013 §9 conflict prevention: in a shared project, new artifacts carry
 * `provenance.actor` (stamped at create time) and live under a per-actor subdir
 * `<typeDir>/<displayName-slug>/…` so collaborators' files never collide on the
 * same path. The actor travels in the file's front-matter/sidecar (RFC-014), so
 * the path stays a PURE FUNCTION of the artifact — find/update/delete recompute
 * the same location without storing it. Solo/legacy artifacts have no actor →
 * flat `<typeDir>/…` (back-compat). Returns `''` or `<slug>/`.
 */
function actorDirPrefix(artifact: Artifact): string {
  const actor = artifact.provenance?.actor
  if (!actor?.displayName) return ''
  // Prefer the dedup'd slug stamped at create time; fall back to deriving it.
  const slug = actor.slug || slugifyDisplayName(actor.displayName)
  return `${slug}/`
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
      // The pinned agent.md singleton keeps its fixed `agent-md.md` name. It is
      // special-cased throughout (ensureAgentMd's idempotency check, prompt
      // references), and title-naming it ('agent.md' → 'agent') would orphan the
      // existing file and re-create an empty duplicate on the next open. Keeping
      // bare `<id>.md` also makes legacyRel === newRel, so the convergence
      // migration skips it untouched.
      if (artifact.id === AGENT_MD_ID) {
        return `${MD_TYPE_DIR[artifact.type]}/${actorDirPrefix(artifact)}${artifact.id}.md`
      }
      // Human-readable, like papers: `<title-slug>-<idFrag>.md`. The title
      // lives in front-matter (the index finds the file by rp.id, not by
      // name), so the filename is purely for the human browsing the folder.
      // The idFrag keeps same-titled notes from colliding and keeps the path
      // a pure function of the artifact.
      return `${MD_TYPE_DIR[artifact.type]}/${actorDirPrefix(artifact)}${noteSlug(artifact.title)}-${idFrag(artifact.id)}.md`
    case 'web-content':
      // Local-only inside .research-pilot — never shared, so no per-actor split.
      return join(PATHS.webContent, `${artifact.id}.json`)
    case 'data':
      // Sidecar lives next to the user's data file — its location is the data
      // file's, not a per-actor subdir.
      return `${artifact.filePath}${RP_SIDECAR_SUFFIX}`
    case 'paper':
      return `${PAPER_DIR}/${actorDirPrefix(artifact)}${paperSlug(artifact.citeKey)}-${idFrag(artifact.id)}${PAPER_BIB_EXT}`
  }
}

/**
 * The PRE-rename `<id>.md` path a note/tool-output used before filenames
 * tracked the title. Used ONLY by the one-time filename-convergence migration
 * to locate and remove the old id-named file. Returns null for other types.
 */
export function legacyMdFileRel(artifact: Artifact): string | null {
  if (artifact.type !== 'note' && artifact.type !== 'tool-output') return null
  return `${MD_TYPE_DIR[artifact.type]}/${actorDirPrefix(artifact)}${artifact.id}.md`
}

function paperSidecarRel(paper: PaperArtifact): string {
  return `${PAPER_DIR}/${actorDirPrefix(paper)}${paperSlug(paper.citeKey)}-${idFrag(paper.id)}${RP_SIDECAR_SUFFIX}`
}

/** Read the artifact id recorded in a paper sidecar (.rp.yaml), or null. */
function readSidecarId(absPath: string): string | null {
  try {
    const v = parseYaml(readFileSync(absPath, 'utf-8')) as { id?: unknown }
    return typeof v?.id === 'string' ? v.id : null
  } catch {
    return null
  }
}

/**
 * Converge a pre-uniqueness `<citeKey>.bib`/`.rp.yaml` (no id fragment) for THIS
 * paper to the new collision-safe name. Guarded by the sidecar id so we never
 * delete a *different* paper that happens to share the citeKey.
 */
function removeLegacyPaperFiles(projectPath: string, paper: PaperArtifact, newBibRel: string): void {
  const stem = `${PAPER_DIR}/${actorDirPrefix(paper)}${paperSlug(paper.citeKey)}`
  const legBibRel = `${stem}${PAPER_BIB_EXT}`
  if (legBibRel === newBibRel) return // no fragment in play
  const legBibAbs = join(projectPath, legBibRel)
  const legSideAbs = join(projectPath, `${stem}${RP_SIDECAR_SUFFIX}`)
  if (existsSync(legBibAbs) && readSidecarId(legSideAbs) === paper.id) {
    rmSync(legBibAbs, { force: true })
    if (existsSync(legSideAbs)) rmSync(legSideAbs, { force: true })
  }
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
  removeLegacyPaperFiles(projectPath, paper, bibRel)
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
      // Also clean a pre-uniqueness <citeKey>.bib for this same paper, if any.
      removeLegacyPaperFiles(projectPath, artifact as PaperArtifact, primaryFileRel(artifact))
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
