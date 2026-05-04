/**
 * Active project resolver.
 *
 * Identifies the "canonical paper" in a workspace — the LaTeX root file plus
 * the transitive closure of its \input / \include / \includegraphics /
 * \bibliography / etc. dependencies, with comments stripped before parsing.
 *
 * Consumers (audit, coordinator, sidebar, drift tool) consume this as a fact:
 * "the paper consists of these files." They use it for prompting / labeling /
 * highlighting, NOT as a hard filter — files outside the canonical set still
 * exist on disk and remain readable.
 *
 * Returns `null` if no LaTeX root is found (non-LaTeX project, empty workspace,
 * etc.). All consumers must handle this gracefully and degrade to current
 * behavior.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getFileList } from '../mentions/file-index.js'
import { isLatexRoot, looksArchived, toWorkspaceRel, walkDeps } from './latex-deps.js'

export interface CanonicalPaper {
  rootPath: string                 // workspace-relative, e.g. "paper/main.tex"
  texFiles: Set<string>            // includes rootPath + transitive \input/\include/\subfile
  bibFiles: Set<string>            // \bibliography{a,b,c} → {a.bib, b.bib, ...}; \addbibresource{x.bib}
  images: Set<string>              // \includegraphics, with extension probing + \graphicspath
  otherAssets: Set<string>         // \lstinputlisting / \verbatiminput
  allFiles: Set<string>            // union of all four — convenience for consumers
}

export interface GetCanonicalPaperOpts {
  /** When multiple roots exist, prefer one whose path matches this hint. */
  hintPath?: string
}

/**
 * Resolve the canonical paper for a workspace.
 *
 * Returns `null` if no LaTeX root is found.
 */
export async function getCanonicalPaper(
  projectPath: string,
  opts: GetCanonicalPaperOpts = {}
): Promise<CanonicalPaper | null> {
  const root = await findRoot(projectPath, opts.hintPath)
  if (!root) return null

  const deps = walkDeps(projectPath, root)
  const allFiles = new Set<string>([
    ...deps.texFiles,
    ...deps.bibFiles,
    ...deps.images,
    ...deps.otherAssets
  ])

  return {
    rootPath: root,
    texFiles: deps.texFiles,
    bibFiles: deps.bibFiles,
    images: deps.images,
    otherAssets: deps.otherAssets,
    allFiles
  }
}

/**
 * Returns true if the given path (absolute or workspace-relative) belongs
 * to the canonical paper. Normalizes to workspace-relative form first.
 *
 * Convenience helper for consumers that want a one-liner check.
 */
export function isCanonicalPath(
  canonical: CanonicalPaper,
  projectPath: string,
  path: string
): boolean {
  const rel = toWorkspaceRel(projectPath, path)
  return canonical.allFiles.has(rel)
}

// ---------------------------------------------------------------------------
// Root selection
// ---------------------------------------------------------------------------

async function findRoot(projectPath: string, hintPath?: string): Promise<string | null> {
  const files = await getFileList(projectPath)
  const texFiles = files.filter(f => f.endsWith('.tex'))

  const roots: string[] = []
  for (const f of texFiles) {
    let content: string
    try {
      content = readFileSync(join(projectPath, f), 'utf-8')
    } catch {
      continue
    }
    if (isLatexRoot(content)) roots.push(f)
  }

  if (roots.length === 0) return null
  if (roots.length === 1) return roots[0]

  // Multiple roots — disambiguate.
  if (hintPath) {
    const normalizedHint = toWorkspaceRel(projectPath, hintPath)
    if (roots.includes(normalizedHint)) return normalizedHint
  }

  // Prefer non-archived. If exactly one survives, use it. If multiple
  // survive, prefer the shallowest (fewest path segments) deterministically.
  const live = roots.filter(r => !looksArchived(r))
  const pool = live.length > 0 ? live : roots

  pool.sort((a, b) => {
    const da = a.split('/').length
    const db = b.split('/').length
    if (da !== db) return da - db
    return a.localeCompare(b)
  })
  return pool[0] ?? null
}

// Re-export helpers consumers might want.
export { toWorkspaceRel } from './latex-deps.js'
