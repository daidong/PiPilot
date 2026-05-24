/**
 * RFC-013 Phase 0 — the asymmetric workspace `.gitignore` + a managed
 * `.gitattributes`.
 *
 * Asymmetric rule (§8): OUTSIDE `.research-pilot/` we track everything (the real
 * note/paper/data files, `rp-pi-guidance/`, user files); INSIDE
 * `.research-pilot/` we share ONLY `project.json` — sessions, memory, the derived
 * index, caches, traces, usage, preferences are local-only so members never
 * clobber each other's session UUID / model choice.
 *
 * Both files use idempotent managed blocks so re-running is safe and the user's
 * own lines are preserved. Distinct from RFC-014's
 * `lib/memory-v2/workspace-gitignore.ts` (which only hid the derived index +
 * migration backup); the asymmetric rule here supersedes it but the two blocks
 * coexist harmlessly.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const GI_HEADER = '# --- research-pilot sharing (managed, RFC-013) ---'
const GI_BLOCK = `${GI_HEADER}
# Asymmetric rule: keep ALL of .research-pilot/ local EXCEPT the shared project.json.
.research-pilot/*
!.research-pilot/project.json
# agent.md is per-member (your own instructions + agent memory) — local, never
# shared. Match any location (rp-artifacts/notes/ or the pre-rename notes/).
**/agent-md.md
# Secrets never travel.
.env
.env.local
# --- end research-pilot sharing ---
`

const GA_HEADER = '# --- research-pilot sharing (managed, RFC-013) ---'
const GA_BLOCK = `${GA_HEADER}
# Normalize line endings so PI/student on different OSes don't churn diffs.
* text=auto
# Large binaries are routed to Git LFS at sync time by size (git lfs track <path>),
# which appends its own lines below.
# --- end research-pilot sharing ---
`

function ensureManagedBlock(filePath: string, header: string, block: string): void {
  try {
    const normalized = block.trimEnd()
    if (!existsSync(filePath)) {
      writeFileSync(filePath, block, 'utf-8')
      return
    }
    const current = readFileSync(filePath, 'utf-8')
    const start = current.indexOf(header)
    if (start === -1) {
      const sep = current.endsWith('\n') ? '\n' : '\n\n'
      appendFileSync(filePath, sep + block, 'utf-8')
      return
    }
    // A managed block already exists. Idempotency is keyed on block CONTENT, not
    // merely the header's presence: refresh it IN PLACE when it has drifted from
    // the current managed version. Without this, later additions to the block
    // (e.g. a new ignore rule) would never reach already-shared workspaces —
    // they'd freeze at whatever first wrote the block. The footer is the block's
    // last line; we replace header→footer and preserve everything around it.
    const footer = normalized.slice(normalized.lastIndexOf('\n') + 1)
    const footerStart = current.indexOf(footer, start)
    if (footerStart === -1) return // malformed / hand-edited — leave it alone
    const end = footerStart + footer.length
    if (current.slice(start, end) === normalized) return // already current
    writeFileSync(filePath, current.slice(0, start) + normalized + current.slice(end), 'utf-8')
  } catch {
    // best-effort — never block on these
  }
}

/** Write/append the asymmetric `.gitignore` block. Idempotent. */
export function ensureSharingGitignore(projectPath: string): void {
  ensureManagedBlock(join(projectPath, '.gitignore'), GI_HEADER, GI_BLOCK)
}

/** Write/append the managed `.gitattributes` block. Idempotent. */
export function ensureSharingGitattributes(projectPath: string): void {
  ensureManagedBlock(join(projectPath, '.gitattributes'), GA_HEADER, GA_BLOCK)
}

/** Convenience: both files at once (called at share time). */
export function ensureSharingGitFiles(projectPath: string): void {
  ensureSharingGitignore(projectPath)
  ensureSharingGitattributes(projectPath)
}
