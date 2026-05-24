/**
 * RFC-013 — git command wrappers (all shell to the user's `git`, §7). Each takes
 * the workspace `cwd`. Network ops (fetch/push/ls-remote) use the credentials
 * `gh auth` configured. Nothing here throws; callers inspect the typed result.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand, type ExecResult } from './exec.js'

const git = (cwd: string, args: string[], timeout?: number) =>
  runCommand('git', args, { cwd, timeout })

export async function isGitInstalled(): Promise<boolean> {
  const r = await runCommand('git', ['--version'], { timeout: 5000 })
  return r.ok
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout === 'true'
}

export async function gitInit(cwd: string): Promise<ExecResult> {
  // Initialize on `main` directly so we never depend on the user's init.defaultBranch.
  const r = await git(cwd, ['init', '-b', 'main'])
  if (r.ok) return r
  // Older git without -b: init then rename.
  const init = await git(cwd, ['init'])
  if (!init.ok) return init
  return git(cwd, ['checkout', '-B', 'main'])
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.stdout : null
}

/** `git status --porcelain` — empty stdout ⇒ clean working tree. */
export async function hasChanges(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain'])
  return r.ok && r.stdout.length > 0
}

/** Stage everything and commit. Returns ok:false (no error) when there is nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<ExecResult> {
  const add = await git(cwd, ['add', '-A'])
  if (!add.ok) return add
  return git(cwd, ['commit', '-m', message])
}

export async function fetch(cwd: string): Promise<ExecResult> {
  return git(cwd, ['fetch', 'origin'], 120_000)
}

export interface AheadBehind {
  ahead: number
  behind: number
  /** False when there is no upstream configured yet (never pushed). */
  hasUpstream: boolean
}

/**
 * Counts local-only (ahead) and remote-only (behind) commits against the tracked
 * upstream. Run after {@link fetch} for a fresh comparison.
 */
export async function getAheadBehind(cwd: string): Promise<AheadBehind> {
  // left = @{u} not in HEAD = behind ; right = HEAD not in @{u} = ahead
  const r = await git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (!r.ok) return { ahead: 0, behind: 0, hasUpstream: false }
  const m = r.stdout.split(/\s+/)
  const behind = Number(m[0] ?? 0)
  const ahead = Number(m[1] ?? 0)
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0, hasUpstream: true }
}

export interface RebaseResult {
  ok: boolean
  /** True when the rebase stopped on a genuine co-edited-file conflict (§9). */
  conflict: boolean
  conflictedFiles: string[]
  raw: ExecResult
}

/** Rebase the current branch onto its upstream. Detects (and aborts) conflicts. */
export async function rebaseOntoUpstream(cwd: string): Promise<RebaseResult> {
  const r = await git(cwd, ['rebase', 'origin/main'], 120_000)
  if (r.ok) return { ok: true, conflict: false, conflictedFiles: [], raw: r }
  const conflict = /conflict/i.test(r.stdout + r.stderr)
  let conflictedFiles: string[] = []
  if (conflict) {
    const cf = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
    conflictedFiles = cf.ok ? cf.stdout.split('\n').filter(Boolean) : []
  }
  return { ok: false, conflict, conflictedFiles, raw: r }
}

export async function abortRebase(cwd: string): Promise<ExecResult> {
  return git(cwd, ['rebase', '--abort'])
}

// ── Conflict extraction + merge-based resolution (§9 Layer 2) ────────────────

/** Common ancestor of HEAD and origin/main, or null. */
export async function getMergeBase(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['merge-base', 'HEAD', 'origin/main'])
  return r.ok && r.stdout ? r.stdout : null
}

/** Files changed between two refs (`git diff --name-only a b`). */
export async function listChangedFiles(cwd: string, from: string, to: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', from, to])
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : []
}

/** File content at a ref (`git show ref:path`), or null if absent there (added on one side). */
export async function showFileAtRef(cwd: string, ref: string, relPath: string): Promise<string | null> {
  const r = await git(cwd, ['show', `${ref}:${relPath}`])
  return r.ok ? r.stdout : null
}

/** Heuristic binary check: a NUL byte in the working-tree file (git's own test). */
export async function isPathBinary(cwd: string, relPath: string): Promise<boolean> {
  try {
    const { readFileSync } = await import('node:fs')
    const buf = readFileSync(join(cwd, relPath))
    return buf.subarray(0, 8000).includes(0)
  } catch {
    return false
  }
}

/** Start a no-commit merge of origin/main (conflicts leave the tree in merge state). */
export async function mergeNoCommit(cwd: string): Promise<ExecResult> {
  return git(cwd, ['merge', '--no-commit', '--no-ff', 'origin/main'], 120_000)
}

export async function abortMerge(cwd: string): Promise<ExecResult> {
  return git(cwd, ['merge', '--abort'])
}

/** During a merge, take one side wholesale for a path (`--ours`=HEAD/mine, `--theirs`=incoming). */
export async function checkoutSide(cwd: string, side: 'ours' | 'theirs', relPath: string): Promise<ExecResult> {
  const co = await git(cwd, ['checkout', `--${side}`, '--', relPath])
  if (!co.ok) return co
  return git(cwd, ['add', '--', relPath])
}

/** Unmerged (conflicted) paths in the current merge state. */
export async function listUnmergedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : []
}

export async function stagePath(cwd: string, relPath: string): Promise<ExecResult> {
  return git(cwd, ['add', '--', relPath])
}

export async function commitNoEdit(cwd: string, message: string): Promise<ExecResult> {
  return git(cwd, ['commit', '--no-edit', '-m', message])
}

/** Create + push an annotated tag (snapshot, §16). */
export async function createTag(cwd: string, tag: string, message: string): Promise<ExecResult> {
  const t = await git(cwd, ['tag', '-a', tag, '-m', message])
  if (!t.ok) return t
  return git(cwd, ['push', 'origin', tag], 120_000)
}

export interface PushResult {
  ok: boolean
  /** Remote moved under us — caller should re-fetch+rebase and retry. */
  nonFastForward: boolean
  raw: ExecResult
}

export async function push(cwd: string): Promise<PushResult> {
  const r = await git(cwd, ['push', 'origin', 'HEAD:main'], 120_000)
  if (r.ok) return { ok: true, nonFastForward: false, raw: r }
  const nonFastForward = /non-fast-forward|fetch first|rejected/i.test(r.stdout + r.stderr)
  return { ok: false, nonFastForward, raw: r }
}

/** First push: set upstream so future ahead/behind tracking works. */
export async function pushSetUpstream(cwd: string): Promise<ExecResult> {
  return git(cwd, ['push', '-u', 'origin', 'main'], 120_000)
}

export async function hasRemote(cwd: string, name = 'origin'): Promise<boolean> {
  const r = await git(cwd, ['remote'])
  return r.ok && r.stdout.split('\n').includes(name)
}

export async function addRemote(cwd: string, url: string, name = 'origin'): Promise<ExecResult> {
  return git(cwd, ['remote', 'add', name, url])
}

export async function getLocalHead(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', 'HEAD'])
  return r.ok ? r.stdout : null
}

/** Resolve any ref (e.g. `origin/main`) to a sha, or null if it doesn't exist. */
export async function runGitRevParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', ref])
  return r.ok && r.stdout ? r.stdout : null
}

/** Network: remote tip of `main` without fetching objects — raw result so callers can classify failures. */
export async function lsRemote(cwd: string, branch = 'main'): Promise<ExecResult> {
  return git(cwd, ['ls-remote', 'origin', branch], 30_000)
}

/** Parsed remote head sha, or null on failure / no such ref. */
export async function lsRemoteHead(cwd: string, branch = 'main'): Promise<string | null> {
  const r = await lsRemote(cwd, branch)
  if (!r.ok || !r.stdout) return null
  return r.stdout.split(/\s+/)[0] ?? null
}

export type RemoteErrorKind = 'access' | 'network' | 'other'

/**
 * Classify a failed remote git operation's output. Distinguishes a member who
 * has LOST ACCESS (removed collaborator / repo deleted — sync should stop and
 * explain) from a TRANSIENT network problem (retry later, files still fine).
 * Network is checked first so a timeout is never mistaken for a permission loss.
 */
export function classifyRemoteError(text: string): RemoteErrorKind {
  const s = (text || '').toLowerCase()
  if (/could not resolve host|couldn't resolve|failed to connect|connection timed out|timed out|network is unreachable|temporary failure in name resolution|operation timed out|no route to host/.test(s)) {
    return 'network'
  }
  if (/permission denied|\b403\b|access rights|authentication failed|could not read username|repository not found|access denied|invalid username or password|terminal prompts disabled/.test(s)) {
    return 'access'
  }
  return 'other'
}

/** Route a single path through Git LFS (appends a pattern to `.gitattributes`). */
export async function lfsTrack(cwd: string, relPath: string): Promise<ExecResult> {
  return git(cwd, ['lfs', 'track', relPath])
}

export async function isLfsInstalled(): Promise<boolean> {
  const r = await runCommand('git', ['lfs', 'version'], { timeout: 5000 })
  return r.ok
}

/**
 * Untracked-or-modified files larger than `thresholdBytes` (from
 * `git status --porcelain`). Used to auto-route big binaries to LFS before
 * committing. Returns workspace-relative POSIX paths.
 */
export async function listLargeChangedFiles(cwd: string, thresholdBytes: number): Promise<string[]> {
  const r = await git(cwd, ['status', '--porcelain', '-z'])
  if (!r.ok || !r.stdout) return []
  // -z uses NUL separators; renames carry an extra NUL-terminated old path.
  const entries = r.stdout.split('\0').filter(Boolean)
  const out: string[] = []
  for (const entry of entries) {
    // Format: "XY <path>" (3-char prefix). Deletions (status starts with D) skipped.
    const status = entry.slice(0, 2)
    const rel = entry.slice(3)
    if (status.includes('D')) continue
    try {
      const size = statSync(join(cwd, rel)).size
      if (size >= thresholdBytes) out.push(rel)
    } catch {
      /* gone / unreadable — skip */
    }
  }
  return out
}

export async function setLocalGitConfig(cwd: string, key: string, value: string): Promise<ExecResult> {
  return git(cwd, ['config', '--local', key, value])
}
