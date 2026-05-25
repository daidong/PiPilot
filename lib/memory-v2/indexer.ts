/**
 * Workspace artifact indexer (RFC-014 §5).
 *
 * Files are the source of truth; this builds the derived `Artifact[]` index by
 * scanning the workspace, recognizing:
 *   - `.md` with an `rp.id` front-matter block        → note / web-content / tool-output
 *   - `references.bib` (+ sibling `references.rp.yaml`)→ papers (per-actor library)
 *   - `<datafile>.rp.yaml` sidecars                    → data
 *   - legacy `.research-pilot/artifacts/<type>/<uuid>.json` → any (read-parity during
 *     the migration window; RFC-014 §8 lazy fallback)
 *
 * The index is persisted, sharded per-artifact, under `.research-pilot/index/`
 * (gitignored). A `.built` marker distinguishes "never indexed" from "no
 * artifacts". Writes keep shards in sync (store.ts); a full `rebuildIndex` runs
 * on first read and can be re-run by the app on external file changes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { parse as parseYaml } from 'yaml'
import { PATHS, type Artifact } from '../types.js'
import {
  readArtifactFromFile,
  parseMarkdownArtifact,
  parsePaperFile,
  dataArtifactFromSidecar,
  PAPER_BIB_EXT,
  RP_SIDECAR_SUFFIX
} from './artifact-files.js'

const INDEX_DIR = join(PATHS.root, 'index')
const INDEX_BUILT_MARKER = '.built'

/**
 * Directories never descended into during the workspace walk (and, reused by the
 * fs-watcher, never worth a reindex). These are VCS / dependency / virtualenv /
 * build / cache / IDE dirs — large, tool-generated, and never holders of managed
 * artifacts (managed `.md` carry rp.id front-matter; papers live in
 * `rp-artifacts/`; data sidecars sit beside the user's data files, which live in
 * data/ not build/). Skipping them keeps the scan from ballooning on real
 * research repos with .venv, node_modules, datasets-as-build-output, etc.
 */
export const WALK_SKIP_DIRS = new Set([
  // VCS
  '.git', '.hg', '.svn',
  // JS / deps
  'node_modules',
  // Python envs & caches
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.ipynb_checkpoints', '.tox',
  // Build / framework output
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.output',
  '.turbo', '.parcel-cache',
  // Caches / tooling
  '.cache', '.gradle', '.terraform', 'coverage',
  // IDE
  '.idea', '.vscode',
  // Research Pilot's own metadata (shared only via project.json)
  '.research-pilot',
])

function toPosixRel(projectPath: string, abs: string): string {
  return relative(projectPath, abs).split(sep).join('/')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function parseYamlObject(text: string | null): Record<string, unknown> {
  if (!text) return {}
  try {
    const v = parseYaml(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanning (source of truth → Artifact[])
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full scan of the workspace producing the canonical `Artifact[]`. New-format
 * files win over legacy JSON when both carry the same id.
 */
export function scanWorkspaceArtifacts(projectPath: string): Artifact[] {
  const byId = new Map<string, Artifact>()

  // 1) Legacy JSON (read-parity / migration window).
  for (const rel of [PATHS.notes, PATHS.papers, PATHS.data, PATHS.webContent, PATHS.toolOutputs]) {
    const dir = join(projectPath, rel)
    if (!existsSync(dir)) continue
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith('.json')) continue
      const a = readArtifactFromFile(join(dir, file))
      if (a) byId.set(a.id, a)
    }
  }

  // 2) New-format files anywhere in the workspace (outside .research-pilot/).
  walkNewFormat(projectPath, projectPath, byId)

  return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

function walkNewFormat(projectPath: string, dir: string, byId: Map<string, Artifact>): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const name of entries) {
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      if (WALK_SKIP_DIRS.has(name)) continue
      walkNewFormat(projectPath, abs, byId)
      continue
    }
    if (!st.isFile()) continue

    // Paper: <citeKey>.bib + sibling <citeKey>.rp.yaml (one file per paper).
    // Only entries carrying an rp_id/sidecar id are managed artifacts; a raw
    // user .bib without one is ignored.
    if (name.endsWith(PAPER_BIB_EXT)) {
      const bibText = readTextFile(abs)
      if (!bibText) continue
      const base = name.slice(0, -PAPER_BIB_EXT.length)
      const sidecar = parseYamlObject(readTextFile(join(dir, base + RP_SIDECAR_SUFFIX)))
      const p = parsePaperFile(bibText, sidecar)
      if (p) byId.set(p.id, p)
      continue
    }

    // Sidecar `.rp.yaml`: a DATA sidecar (type:data). Paper sidecars (type:paper)
    // are handled via their `.bib` above and skipped here.
    if (name.endsWith(RP_SIDECAR_SUFFIX)) {
      const sidecar = parseYamlObject(readTextFile(abs))
      if (sidecar.type === 'paper') continue
      const dataFileAbs = abs.slice(0, -RP_SIDECAR_SUFFIX.length)
      const d = dataArtifactFromSidecar(sidecar, toPosixRel(projectPath, dataFileAbs))
      if (d) byId.set(d.id, d)
      continue
    }

    // Markdown-backed artifact (note / web-content / tool-output)
    if (name.endsWith('.md')) {
      const text = readTextFile(abs)
      if (!text) continue
      const a = parseMarkdownArtifact(text)
      if (a) byId.set(a.id, a)
      continue
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted index (sharded under .research-pilot/index/)
// ─────────────────────────────────────────────────────────────────────────────

function indexDir(projectPath: string): string {
  return join(projectPath, INDEX_DIR)
}

function shardPath(projectPath: string, id: string): string {
  // ids are UUIDs (filesystem-safe); guard pathological values defensively.
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(indexDir(projectPath), `${safe}.json`)
}

/** True when a full index build has completed at least once. */
export function isIndexBuilt(projectPath: string): boolean {
  return existsSync(join(indexDir(projectPath), INDEX_BUILT_MARKER))
}

/** Read the persisted index shards. Returns null when never built. */
export function readIndex(projectPath: string): Artifact[] | null {
  const dir = indexDir(projectPath)
  if (!existsSync(join(dir, INDEX_BUILT_MARKER))) return null
  const out: Artifact[] = []
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith('.json')) continue
    const a = readArtifactFromFile(join(dir, file))
    if (a) out.push(a)
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** Full rebuild: scan the workspace, replace all shards, set the built marker. */
export function rebuildIndex(projectPath: string): Artifact[] {
  const artifacts = scanWorkspaceArtifacts(projectPath)
  const dir = indexDir(projectPath)
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const a of artifacts) {
      writeFileSync(shardPath(projectPath, a.id), JSON.stringify(a, null, 2), 'utf-8')
    }
    writeFileSync(join(dir, INDEX_BUILT_MARKER), new Date().toISOString(), 'utf-8')
  } catch {
    // Index is a derived cache — persistence failure must not break reads.
  }
  return artifacts
}

/** Read the index, building it on first use (lazy fallback, RFC-014 §8). */
export function getArtifacts(projectPath: string): Artifact[] {
  const cached = readIndex(projectPath)
  if (cached) return cached
  return rebuildIndex(projectPath)
}

/** Insert/replace a single artifact in the index (called by writes). */
export function upsertIndexEntry(projectPath: string, artifact: Artifact): void {
  if (!isIndexBuilt(projectPath)) return // a later rebuild will include it
  try {
    mkdirSync(indexDir(projectPath), { recursive: true })
    writeFileSync(shardPath(projectPath, artifact.id), JSON.stringify(artifact, null, 2), 'utf-8')
  } catch {
    // ignore — derived cache
  }
}

/** Remove a single artifact from the index (called by deletes). */
export function removeIndexEntry(projectPath: string, id: string): void {
  if (!isIndexBuilt(projectPath)) return
  try {
    const p = shardPath(projectPath, id)
    if (existsSync(p)) rmSync(p, { force: true })
  } catch {
    // ignore
  }
}
