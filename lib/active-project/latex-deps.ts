/**
 * LaTeX dependency walker.
 *
 * Given a project root and a known root .tex file, recursively follows
 *   \input / \include / \subfile          -> tex
 *   \bibliography{a,b,c} / \addbibresource -> bib
 *   \includegraphics                       -> images (with extension probing)
 *   \lstinputlisting / \verbatiminput     -> other assets
 *
 * Output paths are workspace-relative (relative to projectPath), normalized
 * with forward slashes and no leading `./`.
 *
 * Unsupported (returns false negatives; documented):
 *   - macro-expanded paths: `\input{\figpath/x}`
 *   - conditional compilation blocks
 *   - subfiles package nesting where a subfile has its own \documentclass
 *     (we strip the documentclass check at the root-detection layer, but
 *      \subfile{x} from a subfile is still followed via the \subfile branch)
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, posix, relative } from 'node:path'

import { stripLatexComments } from './comments.js'

const IMAGE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']

export interface DepWalkResult {
  texFiles: Set<string>
  bibFiles: Set<string>
  images: Set<string>
  otherAssets: Set<string>
}

export function walkDeps(projectPath: string, rootRel: string): DepWalkResult {
  const result: DepWalkResult = {
    texFiles: new Set(),
    bibFiles: new Set(),
    images: new Set(),
    otherAssets: new Set(),
  }

  const queue: string[] = [toRel(rootRel)]
  const visited = new Set<string>()
  // \graphicspath candidates accumulated as we walk (workspace-relative directories).
  const graphicsPaths: string[] = []

  while (queue.length > 0) {
    const texRel = queue.shift()!
    if (visited.has(texRel)) continue
    visited.add(texRel)

    const abs = join(projectPath, texRel)
    let raw: string
    try {
      raw = readFileSync(abs, 'utf-8')
    } catch {
      continue
    }
    const stripped = stripLatexComments(raw)

    result.texFiles.add(texRel)
    const baseDir = dirname(texRel) === '.' ? '' : dirname(texRel)

    // \graphicspath{{a/}{b/}} — collect search paths
    for (const p of parseGraphicsPath(stripped)) {
      const resolved = normRel(join(baseDir, p))
      if (!graphicsPaths.includes(resolved)) graphicsPaths.push(resolved)
    }

    // \input / \include / \subfile  → enqueue more tex
    for (const target of extractCommandArgs(stripped, ['input', 'include', 'subfile'])) {
      const resolved = resolveTexRef(projectPath, baseDir, target)
      if (resolved) queue.push(resolved)
    }

    // \bibliography{a,b,c}
    for (const target of extractCommandArgs(stripped, ['bibliography'])) {
      for (const piece of target.split(',').map(s => s.trim()).filter(Boolean)) {
        const resolved = resolveBibRef(projectPath, baseDir, piece)
        if (resolved) result.bibFiles.add(resolved)
      }
    }
    // \addbibresource{x.bib}
    for (const target of extractCommandArgs(stripped, ['addbibresource'])) {
      const resolved = resolveBibRef(projectPath, baseDir, target)
      if (resolved) result.bibFiles.add(resolved)
    }

    // \includegraphics[opts]{path}
    for (const target of extractCommandArgs(stripped, ['includegraphics'])) {
      const resolved = resolveImageRef(projectPath, baseDir, graphicsPaths, target)
      if (resolved) result.images.add(resolved)
    }

    // \lstinputlisting / \verbatiminput
    for (const target of extractCommandArgs(stripped, ['lstinputlisting', 'verbatiminput'])) {
      const resolved = resolveAssetRef(projectPath, baseDir, target)
      if (resolved) result.otherAssets.add(resolved)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Root detection
// ---------------------------------------------------------------------------

const ARCHIVED_DIR_PATTERNS = [
  /(^|\/)_old(\/|$)/i,
  /(^|\/)_scratch(\/|$)/i,
  /(^|\/)_archive(\/|$)/i,
  /(^|\/)backup(\/|$)/i,
  /(^|\/)old(\/|$)/i,
]

export function looksArchived(relPath: string): boolean {
  return ARCHIVED_DIR_PATTERNS.some(re => re.test(relPath))
}

/**
 * Given the file content (already comment-stripped is ideal but the function
 * also strips internally to be safe), decide whether it's a LaTeX root.
 *
 * Root = has \documentclass{...} AND \begin{document}, AND its \documentclass
 * is NOT `subfiles` (subfiles package files have \documentclass[../main.tex]{subfiles}
 * — they're sub-documents, not roots).
 */
export function isLatexRoot(content: string): boolean {
  const stripped = stripLatexComments(content)
  if (!/\\documentclass\b/.test(stripped)) return false
  if (!/\\begin\{document\}/.test(stripped)) return false
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{subfiles\}/.test(stripped)) return false
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull every `{...}` argument of the listed commands from text.
 * Handles optional `[...]` args between command and main arg.
 * Multiple commands are alternated in one regex for efficiency.
 *
 * NOTE: this regex assumes the argument has no nested `{`. That matches LaTeX
 * usage for these specific commands in practice (paths, file names, comma
 * lists). If a future command needs nested-brace support, switch to a
 * brace-matching loop.
 */
function extractCommandArgs(text: string, commands: string[]): string[] {
  const cmdAlt = commands.join('|')
  const re = new RegExp(`\\\\(?:${cmdAlt})\\b\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const arg = m[1].trim()
    if (arg) out.push(arg)
  }
  return out
}

/**
 * `\graphicspath{{a/}{b/}}` -> ['a/', 'b/'] (relative to current file's dir).
 */
function parseGraphicsPath(text: string): string[] {
  const out: string[] = []
  const outer = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g
  let m: RegExpExecArray | null
  while ((m = outer.exec(text)) !== null) {
    const inner = m[1]
    const inner_re = /\{([^}]*)\}/g
    let im: RegExpExecArray | null
    while ((im = inner_re.exec(inner)) !== null) {
      const p = im[1].trim()
      if (p) out.push(p)
    }
  }
  return out
}

function resolveTexRef(projectPath: string, baseDir: string, target: string): string | null {
  // \input/\include/\subfile auto-append .tex if no extension.
  const candidates = hasExtension(target) ? [target] : [target, `${target}.tex`]
  for (const cand of candidates) {
    const rel = normRel(join(baseDir, cand))
    if (isOutsideProject(rel)) continue
    if (existsSync(join(projectPath, rel))) return rel
  }
  return null
}

function resolveBibRef(projectPath: string, baseDir: string, target: string): string | null {
  const candidates = hasExtension(target) ? [target] : [target, `${target}.bib`]
  for (const cand of candidates) {
    const rel = normRel(join(baseDir, cand))
    if (isOutsideProject(rel)) continue
    if (existsSync(join(projectPath, rel))) return rel
  }
  return null
}

function resolveImageRef(
  projectPath: string,
  baseDir: string,
  graphicsPaths: string[],
  target: string
): string | null {
  // Try the exact target path first (if it has an extension).
  if (hasExtension(target)) {
    const direct = normRel(join(baseDir, target))
    if (!isOutsideProject(direct) && existsSync(join(projectPath, direct))) return direct

    // Also try graphicspath dirs with the exact filename.
    for (const gp of graphicsPaths) {
      const cand = normRel(join(gp, target))
      if (isOutsideProject(cand)) continue
      if (existsSync(join(projectPath, cand))) return cand
    }
  }

  // No extension or extension probe didn't find it: try IMAGE_EXTENSIONS.
  const baseAndGraphics = ['', ...graphicsPaths]
  for (const dir of baseAndGraphics) {
    const root = dir ? join(baseDir, dir) : baseDir
    for (const ext of IMAGE_EXTENSIONS) {
      const candidate = hasExtension(target) ? target : `${target}${ext}`
      const rel = normRel(join(root, candidate))
      if (isOutsideProject(rel)) continue
      if (existsSync(join(projectPath, rel))) return rel
    }
  }
  return null
}

function resolveAssetRef(projectPath: string, baseDir: string, target: string): string | null {
  const rel = normRel(join(baseDir, target))
  if (isOutsideProject(rel)) return null
  if (existsSync(join(projectPath, rel))) return rel
  return null
}

function hasExtension(p: string): boolean {
  // Last segment contains a `.` not at position 0
  const seg = p.split('/').pop() ?? p
  const dot = seg.lastIndexOf('.')
  return dot > 0 && dot < seg.length - 1
}

/**
 * Convert any path (possibly with `..`, `./`, mixed separators) to a
 * normalized workspace-relative posix path.
 */
function normRel(p: string): string {
  const norm = normalize(p).replace(/\\/g, '/')
  // strip leading "./"
  return norm.startsWith('./') ? norm.slice(2) : norm
}

function isOutsideProject(rel: string): boolean {
  return rel.startsWith('../') || rel === '..' || isAbsolute(rel)
}

function toRel(p: string): string {
  return normRel(p)
}

/**
 * Convert any path to a workspace-relative form when given the projectPath.
 * Public helper used by consumers that want to compare arbitrary paths
 * (e.g. provenance node refs) against canonical paper sets.
 */
export function toWorkspaceRel(projectPath: string, p: string): string {
  if (isAbsolute(p)) {
    const r = relative(projectPath, p).replace(/\\/g, '/')
    return r.startsWith('./') ? r.slice(2) : r
  }
  return normRel(p)
}

// Suppressed: posix import is used implicitly via normRel's forward-slash output.
void posix
