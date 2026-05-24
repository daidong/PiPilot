/**
 * RFC-013 §7.2 — the setup gate. Sharing requires `git`, `gh` (authenticated),
 * and (for big binaries) `git-lfs`. We detect, never auto-install, and hand the
 * UI exact remediation commands.
 */

import { isGitInstalled, isLfsInstalled } from './git.js'
import { ghAuthStatus } from './gh.js'

export interface SharingPreflight {
  git: boolean
  gh: boolean
  ghAuthenticated: boolean
  lfs: boolean
  login?: string
  /** True ⇒ Share / Sync can proceed (LFS is optional, only a warning). */
  ready: boolean
  /** Ordered, human-facing remediation steps (empty when ready). */
  remediation: string[]
}

export async function checkSharingPreflight(): Promise<SharingPreflight> {
  const [git, lfs, auth] = await Promise.all([isGitInstalled(), isLfsInstalled(), ghAuthStatus()])

  const remediation: string[] = []
  if (!git) remediation.push('Install Git — https://git-scm.com/downloads')
  if (!auth.installed) {
    remediation.push('Install the GitHub CLI — https://cli.github.com')
  } else if (!auth.authenticated) {
    remediation.push('Authenticate the GitHub CLI — run:  gh auth login')
  }
  if (!lfs) {
    // Non-blocking — only matters for files over the LFS threshold.
    remediation.push('(optional) Install Git LFS for large files — https://git-lfs.com')
  }

  const ready = git && auth.installed && auth.authenticated
  return {
    git,
    gh: auth.installed,
    ghAuthenticated: auth.authenticated,
    lfs,
    login: auth.login,
    ready,
    remediation: ready ? remediation.filter((s) => s.startsWith('(optional)')) : remediation,
  }
}
