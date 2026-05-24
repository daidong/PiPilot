/**
 * RFC-013 — GitHub CLI (`gh`) wrappers (§7). The app owns no OAuth; it shells to
 * the user's authenticated `gh`. GitHub is required (no non-GitHub fallback).
 */

import { runCommand, type ExecResult } from './exec.js'

const gh = (args: string[], cwd?: string, timeout?: number) =>
  runCommand('gh', args, { cwd, timeout })

export async function isGhInstalled(): Promise<boolean> {
  const r = await gh(['--version'], undefined, 5000)
  return r.ok
}

export interface GhAuth {
  installed: boolean
  authenticated: boolean
  login?: string
}

/** `gh auth status` writes to stderr; we confirm via `gh api user` for the login. */
export async function ghAuthStatus(): Promise<GhAuth> {
  if (!(await isGhInstalled())) return { installed: false, authenticated: false }
  const me = await gh(['api', 'user', '-q', '.login'], undefined, 15_000)
  if (me.ok && me.stdout) return { installed: true, authenticated: true, login: me.stdout }
  return { installed: true, authenticated: false }
}

/**
 * Create a PRIVATE repo from the local working tree and push. `name` may be a
 * bare name (owned by the current user) or `owner/name` (e.g. an org).
 * Returns the `owner/name` slug on success.
 */
export async function repoCreatePrivate(
  cwd: string,
  name: string
): Promise<{ ok: boolean; slug?: string; raw: ExecResult }> {
  const create = await gh(
    ['repo', 'create', name, '--private', '--source=.', '--remote=origin', '--push'],
    cwd,
    180_000
  )
  if (!create.ok) return { ok: false, raw: create }
  // Resolve the canonical slug (handles the bare-name → current-user case).
  const view = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd, 15_000)
  return { ok: true, slug: view.ok ? view.stdout : name, raw: create }
}

export interface RepoInfo {
  nameWithOwner: string
  isPrivate: boolean
  url: string
}

export async function repoView(slug: string): Promise<RepoInfo | null> {
  const r = await gh(['repo', 'view', slug, '--json', 'nameWithOwner,isPrivate,url'], undefined, 15_000)
  if (!r.ok) return null
  try {
    return JSON.parse(r.stdout) as RepoInfo
  } catch {
    return null
  }
}

/** Clone a repo into `destPath` (which must not yet exist / be empty — §7.1). */
export async function repoClone(slug: string, destPath: string): Promise<ExecResult> {
  return gh(['repo', 'clone', slug, destPath], undefined, 600_000)
}

/** GitHub usernames: 1–39 chars, alnum or single hyphens, no leading/trailing hyphen. */
export function looksLikeGithubLogin(s: string): boolean {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(s.trim())
}

/**
 * Add a collaborator with push (write) access. `login` must be a GitHub username
 * — the collaborators API does not accept email addresses.
 */
export async function collaboratorAdd(
  slug: string,
  login: string,
  permission: 'push' | 'admin' = 'push'
): Promise<ExecResult> {
  return gh(['api', '-X', 'PUT', `repos/${slug}/collaborators/${login}`, '-f', `permission=${permission}`])
}

export async function collaboratorRemove(slug: string, login: string): Promise<ExecResult> {
  return gh(['api', '-X', 'DELETE', `repos/${slug}/collaborators/${login}`])
}

export interface Collaborator {
  login: string
  /** Highest granted permission, e.g. 'admin' | 'push' | 'pull'. */
  role: string
}

/** A pending repository invitation the CURRENT user has received (§7.1). */
export interface RepoInvitation {
  id: number
  /** `owner/name` of the repo they're invited to. */
  repo: string
  /** GitHub login of whoever invited them. */
  inviter: string
}

/**
 * List the current user's pending repository invitations. This is how the
 * invitee discovers what they've been invited to from inside the app — without
 * the Lead having to tell them the repo slug out of band. (Invitations already
 * accepted on github.com won't appear here; those repos show up via `gh repo
 * list` / are clonable directly.)
 */
export async function listRepoInvitations(): Promise<RepoInvitation[]> {
  const r = await gh(['api', '/user/repository_invitations'], undefined, 20_000)
  if (!r.ok || !r.stdout) return []
  try {
    const arr = JSON.parse(r.stdout) as Array<{ id: number; repository?: { full_name?: string }; inviter?: { login?: string } }>
    return arr.map((x) => ({
      id: x.id,
      repo: x.repository?.full_name ?? '',
      inviter: x.inviter?.login ?? '',
    })).filter((x) => x.repo)
  } catch {
    return []
  }
}

/** Accept a received repository invitation by id (PATCH → 204). */
export async function acceptRepoInvitation(id: number): Promise<ExecResult> {
  return gh(['api', '-X', 'PATCH', `/user/repository_invitations/${id}`])
}

export async function collaboratorList(slug: string): Promise<Collaborator[]> {
  const r = await gh(
    ['api', `repos/${slug}/collaborators`, '-q', '.[] | .login + " " + .role_name'],
    undefined,
    30_000
  )
  if (!r.ok || !r.stdout) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [login, role] = line.split(' ')
      return { login: login ?? '', role: role ?? 'pull' }
    })
}
