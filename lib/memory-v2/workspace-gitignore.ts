/**
 * Ensure the workspace `.gitignore` keeps RFC-014 derived/backup state out of
 * git: the local artifact index and the migration backup. Idempotent — appends
 * a single managed block once.
 *
 * Note: the full RFC-013 "asymmetric" sharing rule (ignore all of
 * `.research-pilot/` except `project.json`) is a sharing-time concern and is NOT
 * imposed here; this only protects the always-derived caches.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'

const BLOCK_HEADER = '# --- research-pilot (managed, RFC-014) ---'
const BLOCK = `${BLOCK_HEADER}
.research-pilot/index/
.research-pilot/artifacts-legacy/
# --- end research-pilot ---
`

export function ensureWorkspaceGitignore(projectPath: string): void {
  const giPath = join(projectPath, '.gitignore')
  try {
    if (!existsSync(giPath)) {
      writeFileSync(giPath, BLOCK, 'utf-8')
      return
    }
    const current = readFileSync(giPath, 'utf-8')
    if (current.includes(BLOCK_HEADER)) return
    const sep = current.endsWith('\n') ? '\n' : '\n\n'
    appendFileSync(giPath, sep + BLOCK, 'utf-8')
  } catch {
    // best-effort — never block project open on .gitignore
  }
}
