/**
 * RFC-013 — high-level sharing orchestration. Ties together preflight, identity,
 * the asymmetric git files, and the git/gh wrappers into the handful of actions
 * the UI exposes: share, sync, poll, invite/remove/promote, accept-invite.
 *
 * Invariants honored here:
 * - GitHub required, no fallback (§7).
 * - One project = one private repo; everyone on a single `main` (§5).
 * - Sync = commit → fetch → rebase → push, retry on race (§14).
 * - Detect-but-never-auto-apply: poll only reports; files move only on sync.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { PATHS, type ProjectConfig, type ProjectMember } from '../types.js'
import { checkSharingPreflight, type SharingPreflight } from './preflight.js'
import { ensureLocalIdentity, getLocalIdentity, slugifyDisplayName } from './identity.js'
import { ensureSharingGitFiles } from './workspace-git.js'
import {
  isGitRepo,
  gitInit,
  hasChanges,
  commitAll,
  fetch,
  getAheadBehind,
  rebaseOntoUpstream,
  abortRebase,
  push,
  lsRemote,
  lfsTrack,
  isLfsInstalled,
  listLargeChangedFiles,
  runGitRevParse,
  classifyRemoteError,
  getMergeBase,
  listChangedFiles,
  showFileAtRef,
  isPathBinary,
  mergeNoCommit,
  abortMerge,
  checkoutSide,
  listUnmergedFiles,
  stagePath,
  commitNoEdit,
  createTag,
} from './git.js'
import {
  repoCreatePrivate,
  repoView,
  repoClone,
  collaboratorAdd,
  collaboratorRemove,
  looksLikeGithubLogin,
  listRepoInvitations,
  acceptRepoInvitation,
  type RepoInvitation,
} from './gh.js'

/** Default LFS auto-route threshold (§8.1): just under GitHub's 50 MiB warning. */
export const DEFAULT_LFS_THRESHOLD = 50_000_000

function configPath(projectPath: string): string {
  return join(projectPath, PATHS.project)
}

function readConfig(projectPath: string): ProjectConfig {
  return JSON.parse(readFileSync(configPath(projectPath), 'utf-8')) as ProjectConfig
}

function writeConfig(projectPath: string, config: ProjectConfig): void {
  config.updatedAt = new Date().toISOString()
  writeFileSync(configPath(projectPath), JSON.stringify(config, null, 2), 'utf-8')
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface SyncState {
  ahead: number
  behind: number
  hasUpstream: boolean
  uncommitted: boolean
}

export interface SharingStatus {
  shared: boolean
  /** Project display name (from project.json). */
  name?: string
  repo?: string
  repoUrl?: string
  members: ProjectMember[]
  lead?: ProjectMember
  /** The local user's identity (may be null before first share/join). */
  me: { id: string; displayName: string } | null
  myRole?: 'lead' | 'member'
  /** Present only when shared. Local-only comparison (no network). */
  sync?: SyncState
  /**
   * Unshared only: false when this folder can't be shared as-is. Sharing
   * creates and manages its OWN repo, so a folder that is already a git
   * repository (or sits inside one) is refused — we never adopt/overwrite the
   * user's existing history.
   */
  canShare?: boolean
  shareBlockedReason?: string
}

/** Cheap, local-only status for the Settings tab + Sync pill. No network calls. */
export async function getSharingStatus(projectPath: string): Promise<SharingStatus> {
  const config = readConfig(projectPath)
  const me = getLocalIdentity(projectPath)
  const members = config.members ?? []
  const lead = members.find((m) => m.role === 'lead')

  if (!config.share) {
    // Sharing manages its own repo. Refuse a folder that's already a git repo
    // (or nested inside one) — we won't touch the user's existing history.
    const alreadyRepo = await isGitRepo(projectPath)
    return {
      shared: false,
      name: config.name,
      members,
      lead,
      me,
      canShare: !alreadyRepo,
      shareBlockedReason: alreadyRepo
        ? 'This folder is already a Git repository (or sits inside one). A shared project needs its own dedicated repo — copy your work into a fresh, non-Git folder and share that.'
        : undefined,
    }
  }

  const myRole = me ? (me.id === config.lead ? 'lead' : 'member') : undefined
  let sync: SyncState | undefined
  if (await isGitRepo(projectPath)) {
    const ab = await getAheadBehind(projectPath)
    sync = { ...ab, uncommitted: await hasChanges(projectPath) }
  }

  const info = config.share.repo ? await repoView(config.share.repo) : null
  return {
    shared: true,
    name: config.name,
    repo: config.share.repo,
    repoUrl: info?.url,
    members,
    lead,
    me,
    myRole,
    sync,
  }
}

/**
 * RFC-013 §9 Layer 1 — the soft conflict-prevention steer injected into the
 * agent's system prompt ONLY when the project is shared. It nudges the agent to
 * drop NEW free-form files (code/LaTeX/figures the file tools write, as opposed
 * to artifacts, which the writer already routes per-actor) into the local
 * member's `<slug>/` directory. Deliberately soft: editing existing files in
 * place and shared root deliverables are fine. Returns '' for solo projects (no
 * clause → today's unconstrained behavior, back-compat).
 */
export function buildSharingPromptClause(projectPath: string): string {
  let shared = false
  try {
    shared = !!readConfig(projectPath).share
  } catch {
    return ''
  }
  if (!shared) return ''
  const me = getLocalIdentity(projectPath)
  if (!me) return ''
  const slug = slugifyDisplayName(me.displayName)
  return `## Shared workspace (collaboration)
This project is shared with collaborators over git — everyone works on one branch.
To avoid file-level collisions, when you CREATE new files, prefer placing them under
your personal directory \`${slug}/\` (e.g. \`${slug}/analysis.py\`, \`${slug}/figures/plot.png\`).
This is a soft preference, not a hard rule: editing an existing file in place is fine,
and genuinely shared deliverables can live at the repo root. Do not modify files under
another collaborator's directory unless the user explicitly asks you to.`
}

// ── Share ─────────────────────────────────────────────────────────────────

export interface ShareOptions {
  /** Repo name: bare (current user) or `owner/name` for an org. */
  repoName: string
  /** The Lead's display name (seeds local identity). */
  displayName: string
  /** GitHub usernames to invite as Members. */
  invites?: string[]
}

export interface ShareResult {
  ok: boolean
  slug?: string
  repoUrl?: string
  invited: string[]
  inviteErrors: { login: string; error: string }[]
  error?: string
  preflight?: SharingPreflight
}

export async function shareProject(projectPath: string, opts: ShareOptions): Promise<ShareResult> {
  // Cheapest, dependency-free pre-conditions first (no network / no gh).
  const config = readConfig(projectPath)
  if (config.share) {
    return { ok: false, invited: [], inviteErrors: [], error: 'This project is already shared.' }
  }

  // HARD GUARD: never share a folder that's already a git repo (or nested in
  // one). Sharing creates and pushes its own private repo from scratch; adopting
  // a user's existing repo/history would risk overwriting their work. The Share
  // UI blocks this too (status.canShare); this is defense-in-depth. Checked
  // before preflight so the user hears about the folder problem regardless of
  // their gh setup.
  if (await isGitRepo(projectPath)) {
    return {
      ok: false,
      invited: [],
      inviteErrors: [],
      error:
        'This folder is already a Git repository. Start the shared project in a fresh, non-Git folder instead.',
    }
  }

  const preflight = await checkSharingPreflight()
  if (!preflight.ready) {
    return { ok: false, invited: [], inviteErrors: [], error: 'Setup incomplete', preflight }
  }

  const me = ensureLocalIdentity(projectPath, opts.displayName)
  ensureSharingGitFiles(projectPath)

  const init = await gitInit(projectPath)
  if (!init.ok) return { ok: false, invited: [], inviteErrors: [], error: `git init failed: ${init.stderr}` }

  // Initial commit (project.json + .gitignore + real files guarantee a non-empty tree).
  await autoTrackLargeFiles(projectPath)
  await commitAll(projectPath, 'Initialize shared project (Research Pilot)')

  // Create the private repo from this fresh repo and push.
  const created = await repoCreatePrivate(projectPath, opts.repoName)
  if (!created.ok || !created.slug) {
    return { ok: false, invited: [], inviteErrors: [], error: `repo create failed: ${created.raw.stderr}` }
  }
  const slug = created.slug

  // Persist roster + binding. Lead = me.
  const leadMember: ProjectMember = {
    actorId: me.id,
    displayName: me.displayName,
    role: 'lead',
    addedAt: new Date().toISOString(),
  }
  config.lead = me.id
  config.members = [leadMember]
  config.share = { host: 'github', repo: slug }
  writeConfig(projectPath, config)

  // Invite collaborators (best-effort, reported individually).
  const invited: string[] = []
  const inviteErrors: { login: string; error: string }[] = []
  for (const raw of opts.invites ?? []) {
    const login = raw.trim()
    if (!login) continue
    const res = await inviteMember(projectPath, login)
    if (res.ok) invited.push(login)
    else inviteErrors.push({ login, error: res.error ?? 'invite failed' })
  }

  // Push the roster commit so collaborators see project.json on clone.
  await commitAll(projectPath, 'Record sharing roster').catch(() => {})
  await push(projectPath).catch(() => {})

  const info = await repoView(slug)
  return { ok: true, slug, repoUrl: info?.url, invited, inviteErrors }
}

// ── Sync ─────────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean
  pushed: boolean
  pulled: boolean
  ahead: number
  behind: number
  /** A genuine co-edited-file clash (§9) — surfaced to the conflict card. */
  conflict: boolean
  conflictedFiles: string[]
  /**
   * The remote refused us — the member was removed from the repo (or it was
   * deleted). Local files stay intact; syncing is disabled until access returns.
   */
  accessDenied?: boolean
  error?: string
}

/** Message shown when a member has lost access (removed collaborator / repo gone). */
const ACCESS_DENIED_MESSAGE =
  'You no longer have access to this shared repository — it may have been removed by the project Lead, or deleted. Your local files are intact and still editable, but syncing is disabled. Contact the Lead if this is unexpected.'

/**
 * One-shot pull+push (§14): commit → fetch → rebase → push, retrying on a race.
 * Disjoint per-actor paths rebase cleanly; only co-edited files surface as conflicts.
 */
export async function syncProject(projectPath: string): Promise<SyncResult> {
  const base: SyncResult = { ok: false, pushed: false, pulled: false, ahead: 0, behind: 0, conflict: false, conflictedFiles: [] }
  if (!(await isGitRepo(projectPath))) return { ...base, error: 'Not a git repository.' }

  // 1. commit my changes (route big files to LFS first)
  if (await hasChanges(projectPath)) {
    await autoTrackLargeFiles(projectPath)
    const c = await commitAll(projectPath, syncCommitMessage(projectPath))
    if (!c.ok && !/nothing to commit/i.test(c.stdout + c.stderr)) {
      return { ...base, error: `commit failed: ${c.stderr}` }
    }
  }

  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 2. fetch
    const f = await fetch(projectPath)
    if (!f.ok) {
      if (classifyRemoteError(f.stderr + '\n' + f.stdout) === 'access') {
        return { ...base, accessDenied: true, error: ACCESS_DENIED_MESSAGE }
      }
      return { ...base, error: `fetch failed: ${f.stderr}` }
    }

    // 3. rebase onto latest main
    const before = await getAheadBehind(projectPath)
    const r = await rebaseOntoUpstream(projectPath)
    if (!r.ok) {
      if (r.conflict) {
        await abortRebase(projectPath)
        return { ...base, conflict: true, conflictedFiles: r.conflictedFiles, error: 'Co-edited file conflict.' }
      }
      return { ...base, error: `rebase failed: ${r.raw.stderr}` }
    }
    const pulled = before.behind > 0

    // 4. push
    const after = await getAheadBehind(projectPath)
    if (after.ahead === 0) {
      return { ...base, ok: true, pushed: false, pulled, ahead: 0, behind: 0 }
    }
    const p = await push(projectPath)
    if (p.ok) {
      return { ...base, ok: true, pushed: true, pulled, ahead: 0, behind: 0 }
    }
    if (p.nonFastForward) continue // someone pushed during our window — retry
    if (classifyRemoteError(p.raw.stderr + '\n' + p.raw.stdout) === 'access') {
      return { ...base, pulled, accessDenied: true, error: ACCESS_DENIED_MESSAGE }
    }
    return { ...base, pulled, error: `push failed: ${p.raw.stderr}` }
  }
  return { ...base, error: 'Sync kept racing with concurrent pushes; please retry.' }
}

// ── Conflict resolution (§9 Layer 2) ─────────────────────────────────────────

export interface ConflictFile {
  path: string
  /** Content at the merge-base, or null if the file was added on both sides. */
  base: string | null
  /** My version (HEAD). */
  mine: string | null
  /** The remote version (origin/main). */
  theirs: string | null
  /** Binary files can't be AI-merged — the card offers pick-one only. */
  isBinary: boolean
}

/**
 * Extract base/mine/theirs for each genuinely co-edited file so the conflict
 * card can show a diff and feed AI-merge. Reads from refs (HEAD, origin/main,
 * merge-base) — repo must be clean (post sync-abort); mutates nothing.
 */
export async function getConflictDetails(projectPath: string): Promise<ConflictFile[]> {
  if (!(await isGitRepo(projectPath))) return []
  const base = await getMergeBase(projectPath)
  if (!base) return []
  const mineChanged = new Set(await listChangedFiles(projectPath, base, 'HEAD'))
  const theirsChanged = await listChangedFiles(projectPath, base, 'origin/main')
  const out: ConflictFile[] = []
  for (const path of theirsChanged) {
    if (!mineChanged.has(path)) continue
    const mine = await showFileAtRef(projectPath, 'HEAD', path)
    const theirs = await showFileAtRef(projectPath, 'origin/main', path)
    if (mine === theirs) continue // both sides made the same edit → not a real clash
    out.push({
      path,
      base: await showFileAtRef(projectPath, base, path),
      mine,
      theirs,
      isBinary: await isPathBinary(projectPath, path),
    })
  }
  return out
}

export type ConflictResolution =
  | { path: string; mode: 'mine' }
  | { path: string; mode: 'theirs' }
  | { path: string; mode: 'merged'; content: string }

/**
 * Apply per-file resolutions and finish the sync as a merge commit. The merge is
 * opened and committed entirely within this call — the repo is never left
 * mid-merge across IPC round-trips (recovers via `merge --abort` on any error).
 */
export async function resolveSyncConflict(
  projectPath: string,
  resolutions: ConflictResolution[]
): Promise<SyncResult> {
  const base: SyncResult = { ok: false, pushed: false, pulled: true, ahead: 0, behind: 0, conflict: false, conflictedFiles: [] }
  if (!(await isGitRepo(projectPath))) return { ...base, error: 'Not a git repository.' }

  await mergeNoCommit(projectPath) // expected to report conflicts; that's the point

  for (const r of resolutions) {
    if (r.mode === 'mine' || r.mode === 'theirs') {
      const co = await checkoutSide(projectPath, r.mode === 'mine' ? 'ours' : 'theirs', r.path)
      if (!co.ok) { await abortMerge(projectPath); return { ...base, error: `resolve ${r.path} failed: ${co.stderr}` } }
    } else {
      try {
        const abs = join(projectPath, r.path)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, r.content, 'utf-8')
      } catch (e: any) {
        await abortMerge(projectPath)
        return { ...base, error: `write merged ${r.path} failed: ${String(e?.message ?? e)}` }
      }
      const add = await stagePath(projectPath, r.path)
      if (!add.ok) { await abortMerge(projectPath); return { ...base, error: `stage ${r.path} failed: ${add.stderr}` } }
    }
  }

  const unresolved = await listUnmergedFiles(projectPath)
  if (unresolved.length > 0) {
    await abortMerge(projectPath)
    return { ...base, conflict: true, conflictedFiles: unresolved, error: `Still unresolved: ${unresolved.join(', ')}` }
  }

  const c = await commitNoEdit(projectPath, "Merge collaborators' changes (Research Pilot)")
  if (!c.ok && !/nothing to commit/i.test(c.stdout + c.stderr)) {
    await abortMerge(projectPath)
    return { ...base, error: `merge commit failed: ${c.stderr}` }
  }
  const p = await push(projectPath)
  if (!p.ok) {
    if (classifyRemoteError(p.raw.stderr + '\n' + p.raw.stdout) === 'access') {
      return { ...base, accessDenied: true, error: ACCESS_DENIED_MESSAGE }
    }
    return { ...base, error: `push failed: ${p.raw.stderr}` }
  }
  return { ...base, ok: true, pushed: true }
}

/** Prompt for AI-merging one text file (caller runs it through the main LLM). */
export function buildAiMergePrompt(file: ConflictFile): { system: string; user: string } {
  const system =
    'You are reconciling two versions of the same file that two collaborators edited ' +
    'concurrently. Produce ONE merged version that preserves BOTH sides\' intent and keeps the ' +
    'file valid. Output ONLY the merged file content — no commentary, no code fences, and never ' +
    'any git conflict markers (<<<<<<, ======, >>>>>>).'
  const user =
    `File: ${file.path}\n\n` +
    `=== COMMON ANCESTOR (base) ===\n${file.base ?? '(did not exist at the common ancestor)'}\n\n` +
    `=== VERSION A (mine) ===\n${file.mine ?? '(deleted on my side)'}\n\n` +
    `=== VERSION B (theirs) ===\n${file.theirs ?? '(deleted on their side)'}\n\n` +
    `Return the merged content of ${file.path}:`
  return { system, user }
}

// ── Snapshot (§16: snapshot = git tag) ───────────────────────────────────────

export async function createSnapshot(
  projectPath: string,
  label?: string
): Promise<{ ok: boolean; tag?: string; error?: string }> {
  if (!(await isGitRepo(projectPath))) return { ok: false, error: 'Not a git repository.' }
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const tag = `rp-snapshot-${ts}`
  const r = await createTag(projectPath, tag, label?.trim() || `Snapshot ${ts}`)
  if (!r.ok) return { ok: false, error: r.stderr || 'Could not create the snapshot tag.' }
  return { ok: true, tag }
}

// ── Poll (detect-only) ──────────────────────────────────────────────────────

export interface PollResult {
  /** Remote tip differs from our last-fetched origin/main ⇒ updates available. */
  updatesAvailable: boolean
  reachable: boolean
  /** The remote refused us (removed collaborator / repo gone). Detected automatically. */
  accessRevoked?: boolean
}

/** Background poll (§14): network ls-remote vs last-fetched ref. Never mutates files. */
export async function pollRemote(projectPath: string): Promise<PollResult> {
  if (!(await isGitRepo(projectPath))) return { updatesAvailable: false, reachable: false }
  const ls = await lsRemote(projectPath, 'main')
  if (!ls.ok) {
    // Distinguish "you were removed" (sticky, explain) from a transient network blip.
    const revoked = classifyRemoteError(ls.stderr + '\n' + ls.stdout) === 'access'
    return { updatesAvailable: false, reachable: false, accessRevoked: revoked }
  }
  const remoteHead = ls.stdout ? (ls.stdout.split(/\s+/)[0] ?? null) : null
  if (!remoteHead) return { updatesAvailable: false, reachable: true }
  const localRef = await runGitRevParse(projectPath, 'origin/main')
  // If we've never fetched origin/main, any remote head counts as "updates available".
  if (!localRef) return { updatesAvailable: true, reachable: true }
  return { updatesAvailable: remoteHead !== localRef, reachable: true }
}

// ── Members ────────────────────────────────────────────────────────────────

export interface MemberOpResult {
  ok: boolean
  error?: string
}

export async function inviteMember(projectPath: string, login: string): Promise<MemberOpResult> {
  const config = readConfig(projectPath)
  if (!config.share) return { ok: false, error: 'Project is not shared.' }
  const clean = login.trim()
  if (!looksLikeGithubLogin(clean)) {
    return { ok: false, error: `"${clean}" is not a GitHub username. Email invites aren't supported — use the username.` }
  }
  const res = await collaboratorAdd(config.share.repo, clean, 'push')
  if (!res.ok) return { ok: false, error: res.stderr || 'GitHub rejected the invite.' }

  const members = config.members ?? []
  if (!members.some((m) => m.githubLogin === clean)) {
    members.push({ displayName: clean, role: 'member', githubLogin: clean, addedAt: new Date().toISOString() })
    config.members = members
    writeConfig(projectPath, config)
  }
  return { ok: true }
}

export async function removeMember(projectPath: string, login: string): Promise<MemberOpResult> {
  const config = readConfig(projectPath)
  if (!config.share) return { ok: false, error: 'Project is not shared.' }
  const res = await collaboratorRemove(config.share.repo, login.trim())
  if (!res.ok) return { ok: false, error: res.stderr || 'GitHub rejected the removal.' }
  config.members = (config.members ?? []).filter((m) => m.githubLogin !== login.trim())
  writeConfig(projectPath, config)
  return { ok: true }
}

export async function promoteMember(projectPath: string, login: string): Promise<MemberOpResult> {
  const config = readConfig(projectPath)
  if (!config.share) return { ok: false, error: 'Project is not shared.' }
  const res = await collaboratorAdd(config.share.repo, login.trim(), 'admin')
  if (!res.ok) return { ok: false, error: res.stderr || 'GitHub rejected the promotion.' }
  const member = (config.members ?? []).find((m) => m.githubLogin === login.trim())
  if (member) {
    member.role = 'lead'
    writeConfig(projectPath, config)
  }
  return { ok: true }
}

// ── Accept invitation (join) ────────────────────────────────────────────────

/**
 * Pending invitations this user has received — surfaced in the Join modal so the
 * invitee doesn't need the Lead to tell them the repo slug. GitHub still sends
 * the email; this just lets them act on it inside the app.
 */
export async function listInvitations(): Promise<RepoInvitation[]> {
  const preflight = await checkSharingPreflight()
  if (!preflight.ready) return []
  return listRepoInvitations()
}

export interface AcceptInviteOptions {
  /** `owner/name` of the repo. */
  repo: string
  /** Destination folder — must be empty or not yet exist (§7.1). */
  destFolder: string
  displayName: string
  /**
   * When joining from a pending invitation, its id — we PATCH-accept it on
   * GitHub before cloning. Omit when the user already accepted on github.com
   * (the repo is then directly clonable).
   */
  invitationId?: number
}

export interface AcceptInviteResult {
  ok: boolean
  projectPath?: string
  error?: string
  preflight?: SharingPreflight
}

export async function acceptInvite(opts: AcceptInviteOptions): Promise<AcceptInviteResult> {
  const preflight = await checkSharingPreflight()
  if (!preflight.ready) return { ok: false, error: 'Setup incomplete', preflight }

  // If acting on a pending invitation, accept it on GitHub first so the clone
  // has access. (No-op / harmless if they already accepted on the web.)
  if (opts.invitationId != null) {
    const accept = await acceptRepoInvitation(opts.invitationId)
    if (!accept.ok && !/404|not found/i.test(accept.stderr)) {
      return { ok: false, error: `Could not accept the invitation: ${accept.stderr}` }
    }
  }

  const dest = opts.destFolder
  if (existsSync(dest)) {
    let entries: string[] = []
    try {
      entries = readdirSync(dest).filter((e) => e !== '.DS_Store')
    } catch {
      return { ok: false, error: 'Destination folder is not readable.' }
    }
    if (entries.length > 0) {
      return { ok: false, error: 'Destination folder must be empty or not yet exist. Pick another folder.' }
    }
  }

  const clone = await repoClone(opts.repo, dest)
  if (!clone.ok) return { ok: false, error: `Clone failed: ${clone.stderr}` }

  // Fresh local identity for this member (actorId generated here).
  ensureLocalIdentity(dest, opts.displayName)
  return { ok: true, projectPath: dest }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function autoTrackLargeFiles(projectPath: string): Promise<void> {
  if (!(await isLfsInstalled())) return
  const big = await listLargeChangedFiles(projectPath, DEFAULT_LFS_THRESHOLD)
  for (const rel of big) {
    await lfsTrack(projectPath, rel).catch(() => {})
  }
}

function syncCommitMessage(projectPath: string): string {
  const me = getLocalIdentity(projectPath)
  const who = me?.displayName ?? 'member'
  return `Sync (${who}) — ${new Date().toISOString()}`
}
