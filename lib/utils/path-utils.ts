/**
 * Path expansion utilities — used by compute backends, tools, and any
 * IPC handler that consumes a user-supplied filesystem path.
 *
 * The Node stdlib does NOT expand shell-style `~` — that's a shell
 * convention, not a path one. Without explicit expansion, an agent
 * receiving `~/.ssh/key.pem` from the user passes a literal 17-character
 * string to `fs.readFileSync`, which fails with ENOENT even though the
 * file plainly exists. Same problem with `path.resolve(workspace,
 * '~/foo')` → `<workspace>/~/foo`.
 *
 * Design: separate functions per concern (mirrors Python's
 * `os.path.expanduser` / `os.path.expandvars` split). Tilde and env-var
 * substitution have different audiences and different security
 * properties; bundling them invites surprises.
 *
 * This module is intentionally dep-free and side-effect-free so it can
 * be imported from anywhere — main process, renderer, library code,
 * tests, future workers.
 */

import os from 'node:os'
import path from 'node:path'

/**
 * Expand a leading `~` (with optional `/` or `\` separator) to the
 * current user's home directory. Everything else passes through
 * untouched.
 *
 * - `~`                  → `os.homedir()`
 * - `~/foo`              → `<home>/foo`
 * - `~\foo` (Windows)    → `<home>/foo`
 * - `~other/foo`         → `~other/foo` (NOT expanded — other-user
 *                          home is unsupported cross-platform)
 * - `/abs/path`          → `/abs/path` (passthrough)
 * - `relative/path`      → `relative/path` (passthrough — workspace
 *                          resolution is a separate layer's job)
 * - `''` / undefined     → returned as-is (defensive; no crash)
 *
 * Behaviorally identical to the `untildify` npm package, kept in-tree
 * to avoid one more dep for ten lines of code.
 */
export function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

/**
 * Apply expandHome, then resolve relative paths against a workspace
 * root. Common path-normalization stack for "user typed a path, we
 * need an absolute filesystem path".
 *
 * Order matters: expandHome FIRST so `~/foo` becomes `<home>/foo`
 * (absolute), then isAbsolute is true and the workspace-resolve step
 * is skipped. If we resolved first, `path.resolve('<workspace>',
 * '~/foo')` would produce `<workspace>/~/foo` (broken).
 */
export function resolveUserPath(workspacePath: string, p: string): string {
  const expanded = expandHome(p)
  return path.isAbsolute(expanded) ? expanded : path.resolve(workspacePath, expanded)
}
