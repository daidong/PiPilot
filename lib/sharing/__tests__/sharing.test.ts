/**
 * RFC-013 sharing — unit tests for the pure/fs parts and a real-git integration
 * round-trip. The gh-dependent paths are exercised only indirectly (they need an
 * authenticated `gh`, absent in CI); the git wrappers are tested against a local
 * bare remote so commit/ahead-behind/push/poll are covered without network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { slugifyDisplayName, ensureLocalIdentity, getLocalIdentity, getSharedLocalActor } from '../identity.js'
import { ensureSharingGitignore, ensureSharingGitattributes } from '../workspace-git.js'
import { looksLikeGithubLogin } from '../gh.js'
import { getSharingStatus, getLocalSyncState, shareProject, buildSharingPromptClause, syncProject, getConflictDetails, resolveSyncConflict, registerLocalMemberIdentity } from '../share.js'
import {
  isGitInstalled,
  gitInit,
  commitAll,
  hasChanges,
  fetch,
  getAheadBehind,
  push,
  listLargeChangedFiles,
  listIgnoredButTracked,
  addRemote,
  pushSetUpstream,
  classifyRemoteError,
} from '../git.js'
import { pollRemote } from '../share.js'
import { runCommand } from '../exec.js'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── slugifyDisplayName ───────────────────────────────────────────────────────

test('slugifyDisplayName: lowercases, hyphenates, strips junk', () => {
  assert.equal(slugifyDisplayName('Alice Chen'), 'alice-chen')
  assert.equal(slugifyDisplayName('Prof. Dai!!'), 'prof-dai')
  assert.equal(slugifyDisplayName('  multi   space '), 'multi-space')
  assert.equal(slugifyDisplayName('已被_清空'), 'member') // non-ascii → fallback
  assert.equal(slugifyDisplayName('--edge--'), 'edge')
})

// ── looksLikeGithubLogin ─────────────────────────────────────────────────────

test('looksLikeGithubLogin: accepts valid, rejects emails & bad shapes', () => {
  assert.ok(looksLikeGithubLogin('bob-gh'))
  assert.ok(looksLikeGithubLogin('a'))
  assert.ok(looksLikeGithubLogin('Octo-Cat-99'))
  assert.ok(!looksLikeGithubLogin('alice@univ.edu'))
  assert.ok(!looksLikeGithubLogin('-leading'))
  assert.ok(!looksLikeGithubLogin('trailing-'))
  assert.ok(!looksLikeGithubLogin('double--hyphen'))
  assert.ok(!looksLikeGithubLogin('a'.repeat(40)))
})

// ── classifyRemoteError (removed-collaborator vs network blip) ───────────────

test('classifyRemoteError: access loss vs transient network vs other', () => {
  // A removed collaborator / deleted repo over HTTPS and SSH:
  assert.equal(classifyRemoteError("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found"), 'access')
  assert.equal(classifyRemoteError('ERROR: Repository not found.'), 'access')
  assert.equal(classifyRemoteError('The requested URL returned error: 403'), 'access')
  assert.equal(classifyRemoteError('git@github.com: Permission denied (publickey).'), 'access')
  assert.equal(classifyRemoteError('fatal: Authentication failed for https://github.com/o/r.git/'), 'access')
  // Transient — files are fine, just retry later. Must NOT be read as access loss.
  assert.equal(classifyRemoteError('fatal: unable to access ...: Could not resolve host: github.com'), 'network')
  assert.equal(classifyRemoteError('ssh: connect to host github.com port 22: Operation timed out'), 'network')
  assert.equal(classifyRemoteError('fatal: unable to access ...: Failed to connect to github.com'), 'network')
  // Unrelated failures stay 'other'.
  assert.equal(classifyRemoteError('error: pathspec did not match'), 'other')
})

// ── gitignore / gitattributes idempotency ────────────────────────────────────

test('ensureSharingGitignore: asymmetric rule, idempotent, preserves user lines', () => {
  const dir = tmp('rp-gi-')
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    ensureSharingGitignore(dir)
    ensureSharingGitignore(dir) // second call must not duplicate
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    assert.ok(gi.includes('node_modules/'), 'preserves existing user lines')
    assert.ok(gi.includes('.research-pilot/*'), 'ignores .research-pilot contents')
    assert.ok(gi.includes('!.research-pilot/project.json'), 're-includes project.json')
    assert.equal(gi.match(/RFC-013/g)?.length, 1, 'block written exactly once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureSharingGitignore: refreshes a drifted managed block in place (no freeze)', () => {
  const dir = tmp('rp-gi-drift-')
  try {
    // An OLDER managed block (pre-agent-md rule) written by a previous build,
    // plus a user line outside it. Reproduces the already-shared-workspace freeze.
    writeFileSync(
      join(dir, '.gitignore'),
      'node_modules/\n' +
        '# --- research-pilot sharing (managed, RFC-013) ---\n' +
        '.research-pilot/*\n' +
        '!.research-pilot/project.json\n' +
        '# --- end research-pilot sharing ---\n'
    )
    ensureSharingGitignore(dir)
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    assert.ok(gi.includes('**/agent-md.md'), 'drifted block gains the newer agent-md rule')
    assert.ok(gi.includes('node_modules/'), 'user lines outside the block are preserved')
    assert.equal(gi.match(/RFC-013/g)?.length, 1, 'still exactly one managed block (no duplication)')
    ensureSharingGitignore(dir) // now current — must be a no-op
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), gi, 'second call is idempotent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureSharingGitattributes: managed block, idempotent', () => {
  const dir = tmp('rp-ga-')
  try {
    ensureSharingGitattributes(dir)
    ensureSharingGitattributes(dir)
    const ga = readFileSync(join(dir, '.gitattributes'), 'utf-8')
    assert.ok(ga.includes('* text=auto'))
    assert.equal(ga.match(/RFC-013/g)?.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── local identity ───────────────────────────────────────────────────────────

test('ensureLocalIdentity: stable actorId, updatable displayName', () => {
  const dir = tmp('rp-id-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    const a = ensureLocalIdentity(dir, 'Alice Chen')
    assert.equal(a.displayName, 'Alice Chen')
    assert.ok(a.id.length > 0)

    const b = ensureLocalIdentity(dir, 'Alice C.') // rename keeps id
    assert.equal(b.id, a.id)
    assert.equal(b.displayName, 'Alice C.')

    const c = getLocalIdentity(dir)
    assert.deepEqual(c, b)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getSharedLocalActor: deduplicates same-display-name slugs with actorId fragment', () => {
  const dir = tmp('rp-actor-slug-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    const me = ensureLocalIdentity(dir, 'Alex')
    writeFileSync(
      join(dir, '.research-pilot', 'project.json'),
      JSON.stringify({
        name: 'Shared',
        questions: [],
        userCorrections: [],
        createdAt: '',
        updatedAt: '',
        share: { host: 'github', repo: 'o/r' },
        members: [
          { actorId: 'other-actor', displayName: 'Alex', role: 'member' },
          { actorId: me.id, displayName: 'Alex', role: 'member' },
        ],
      })
    )
    const actor = getSharedLocalActor(dir)
    assert.equal(actor?.id, me.id)
    assert.equal(actor?.slug, `alex-${me.id.slice(-4).toLowerCase()}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── getSharingStatus: unshared project ───────────────────────────────────────

test('getSharingStatus: unshared non-git project reports shared=false, canShare=true', async () => {
  const dir = tmp('rp-st-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    writeFileSync(
      join(dir, '.research-pilot', 'project.json'),
      JSON.stringify({ name: 'Solo', questions: [], userCorrections: [], createdAt: '', updatedAt: '' })
    )
    const status = await getSharingStatus(dir)
    assert.equal(status.shared, false)
    assert.deepEqual(status.members, [])
    assert.equal(status.sync, undefined)
    assert.equal(status.canShare, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getSharingStatus + shareProject: refuse a folder that is already a git repo', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')
  const dir = tmp('rp-existing-git-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    writeFileSync(
      join(dir, '.research-pilot', 'project.json'),
      JSON.stringify({ name: 'Mine', questions: [], userCorrections: [], createdAt: '', updatedAt: '' })
    )
    await gitInit(dir) // user's own repo — must NOT be hijacked

    const status = await getSharingStatus(dir)
    assert.equal(status.canShare, false, 'an existing git repo cannot be shared')
    assert.ok(status.shareBlockedReason, 'a reason is provided for the UI')

    // Defense-in-depth: shareProject itself refuses even if the UI were bypassed.
    const res = await shareProject(dir, { repoName: 'x', displayName: 'Me' })
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /already a Git repository/i)
    // It must not have created a remote or written share config.
    const cfg = JSON.parse(readFileSync(join(dir, '.research-pilot', 'project.json'), 'utf-8'))
    assert.equal(cfg.share, undefined, 'share binding not written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── buildSharingPromptClause (§9 soft steer) ─────────────────────────────────

test('buildSharingPromptClause: empty unless shared + identity, mentions the slug', () => {
  const dir = tmp('rp-clause-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    const cfgPath = join(dir, '.research-pilot', 'project.json')
    const base = { name: 'P', questions: [], userCorrections: [], createdAt: '', updatedAt: '' }

    // Unshared → no clause.
    writeFileSync(cfgPath, JSON.stringify(base))
    assert.equal(buildSharingPromptClause(dir), '')

    // Shared but no local identity yet → still empty (nothing to steer toward).
    writeFileSync(cfgPath, JSON.stringify({ ...base, share: { host: 'github', repo: 'o/r' } }))
    assert.equal(buildSharingPromptClause(dir), '')

    // Shared + identity → clause names the per-actor slug, soft language.
    ensureLocalIdentity(dir, 'Alice Chen')
    const clause = buildSharingPromptClause(dir)
    assert.match(clause, /Shared workspace/)
    assert.match(clause, /alice-chen\//)
    assert.match(clause, /soft preference/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSharingPromptClause: uses the same deduplicated slug as artifact placement', () => {
  const dir = tmp('rp-clause-collision-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    const me = ensureLocalIdentity(dir, 'Alex')
    writeFileSync(
      join(dir, '.research-pilot', 'project.json'),
      JSON.stringify({
        name: 'P',
        questions: [],
        userCorrections: [],
        createdAt: '',
        updatedAt: '',
        share: { host: 'github', repo: 'o/r' },
        members: [
          { actorId: 'other-actor', displayName: 'Alex', role: 'member' },
          { actorId: me.id, displayName: 'Alex', role: 'member' },
        ],
      })
    )
    assert.match(buildSharingPromptClause(dir), new RegExp(`alex-${me.id.slice(-4).toLowerCase()}/`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerLocalMemberIdentity: fills invite placeholder; role derives from config.lead (no co-Lead)', async () => {
  const dir = tmp('rp-register-member-')
  try {
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    writeFileSync(
      join(dir, '.research-pilot', 'project.json'),
      JSON.stringify({
        name: 'Shared',
        questions: [],
        userCorrections: [],
        createdAt: '',
        updatedAt: '',
        lead: 'lead-actor',
        share: { host: 'github', repo: 'o/r' },
        members: [
          { actorId: 'lead-actor', displayName: 'Prof', role: 'lead' },
          { displayName: 'alice-gh', githubLogin: 'alice-gh', role: 'member' },
        ],
      })
    )
    const me = ensureLocalIdentity(dir, 'Alice Chen')
    const r = registerLocalMemberIdentity(dir, me, 'alice-gh')
    assert.equal(r.ok, true)

    const cfg = JSON.parse(readFileSync(join(dir, '.research-pilot', 'project.json'), 'utf-8'))
    const member = cfg.members.find((m: any) => m.githubLogin === 'alice-gh')
    assert.equal(member.actorId, me.id)
    assert.equal(member.displayName, 'Alice Chen')
    // Joiner is not config.lead → stays a member. There is no promotion path.
    assert.equal(member.role, 'member')

    const status = await getSharingStatus(dir)
    assert.equal(status.myRole, 'member')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── git integration: commit, ahead/behind, push, poll, LFS size scan ─────────

test('git wrappers: commit → push → ahead/behind → poll against a local bare remote', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')

  const remote = tmp('rp-remote-')
  const work = tmp('rp-work-')
  try {
    // Bare remote.
    const bare = await runCommand('git', ['init', '--bare', '-b', 'main', remote])
    if (!bare.ok) return t.skip('git init --bare unsupported')

    // Working repo wired to the bare remote.
    await gitInit(work)
    await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'Test'], { cwd: work })
    writeFileSync(join(work, 'a.txt'), 'hello')
    assert.equal(await hasChanges(work), true)
    const c = await commitAll(work, 'first')
    assert.ok(c.ok, 'commit succeeds')
    assert.equal(await hasChanges(work), false)

    await addRemote(work, remote)
    const up = await pushSetUpstream(work)
    assert.ok(up.ok, `push -u succeeds: ${up.stderr}`)

    await fetch(work)
    const ab0 = await getAheadBehind(work)
    assert.deepEqual({ ahead: ab0.ahead, behind: ab0.behind }, { ahead: 0, behind: 0 })
    assert.equal(ab0.hasUpstream, true)

    // Local commit not yet pushed ⇒ ahead 1.
    writeFileSync(join(work, 'b.txt'), 'more')
    await commitAll(work, 'second')
    await fetch(work)
    const ab1 = await getAheadBehind(work)
    assert.equal(ab1.ahead, 1)

    // Poll sees no remote movement yet (we haven't pushed).
    const poll0 = await pollRemote(work)
    assert.equal(poll0.reachable, true)

    const p = await push(work)
    assert.ok(p.ok, `push succeeds: ${p.raw.stderr}`)

    // getLocalSyncState: the cheap local slice the poll folds in. After push the
    // tree is clean and level with the remote.
    const lsClean = await getLocalSyncState(work)
    assert.deepEqual(
      { ahead: lsClean?.ahead, behind: lsClean?.behind, uncommitted: lsClean?.uncommitted },
      { ahead: 0, behind: 0, uncommitted: false }
    )
    // A new uncommitted file flips uncommitted=true — this is exactly what now
    // lets the Sync pill notice freshly created files between full refreshes.
    writeFileSync(join(work, 'c.txt'), 'dirty')
    const lsDirty = await getLocalSyncState(work)
    assert.equal(lsDirty?.uncommitted, true)
    assert.equal(lsDirty?.ahead, 0)
  } finally {
    rmSync(remote, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test('conflict round-trip: rebase clash → getConflictDetails → resolveSyncConflict lands on remote', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')
  const remote = tmp('rp-cf-remote-')
  const a = tmp('rp-cf-a-')
  const b = tmp('rp-cf-b-')
  const verify = tmp('rp-cf-v-')
  const cfg = async (dir: string) => {
    await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await runCommand('git', ['config', 'user.name', 'Test'], { cwd: dir })
  }
  try {
    const bare = await runCommand('git', ['init', '--bare', '-b', 'main', remote])
    if (!bare.ok) return t.skip('git init --bare unsupported')

    // A seeds the repo with a base file.
    await gitInit(a); await cfg(a)
    writeFileSync(join(a, 'shared.txt'), 'base\n')
    await commitAll(a, 'base')
    await addRemote(a, remote)
    await pushSetUpstream(a)

    // B clones the base.
    const clone = await runCommand('git', ['clone', remote, b])
    assert.ok(clone.ok, `clone: ${clone.stderr}`)
    await cfg(b)

    // A changes shared.txt and pushes.
    writeFileSync(join(a, 'shared.txt'), 'A version\n')
    await commitAll(a, 'A edit')
    const pa = await push(a)
    assert.ok(pa.ok, `A push: ${pa.raw.stderr}`)

    // B changes the SAME file → diverges.
    writeFileSync(join(b, 'shared.txt'), 'B version\n')
    await commitAll(b, 'B edit')

    // B syncs → rebase conflict, aborted, reported.
    const sync = await syncProject(b)
    assert.equal(sync.conflict, true, 'conflict detected')
    assert.ok(sync.conflictedFiles.includes('shared.txt'))

    // Both versions extracted for the card.
    const details = await getConflictDetails(b)
    const cf = details.find((d) => d.path === 'shared.txt')
    assert.ok(cf, 'shared.txt in conflict details')
    assert.match(cf!.mine ?? '', /B version/)
    assert.match(cf!.theirs ?? '', /A version/)
    assert.match(cf!.base ?? '', /base/)
    assert.equal(cf!.isBinary, false)

    // Resolve with an AI-merged-style content → merge commit + push.
    const res = await resolveSyncConflict(b, [{ path: 'shared.txt', mode: 'merged', content: 'A and B merged\n' }])
    assert.ok(res.ok, `resolve: ${res.error}`)
    assert.equal(res.pushed, true)

    // Remote main carries the merged content.
    await runCommand('git', ['clone', remote, verify])
    assert.match(readFileSync(join(verify, 'shared.txt'), 'utf-8'), /A and B merged/)
  } finally {
    for (const d of [remote, a, b, verify]) rmSync(d, { recursive: true, force: true })
  }
})

test('conflict round-trip: modify/delete resolves by accepting the deletion (git rm)', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')
  const remote = tmp('rp-md-remote-')
  const a = tmp('rp-md-a-')
  const b = tmp('rp-md-b-')
  const verify = tmp('rp-md-v-')
  const cfg = async (dir: string) => {
    await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await runCommand('git', ['config', 'user.name', 'Test'], { cwd: dir })
  }
  try {
    const bare = await runCommand('git', ['init', '--bare', '-b', 'main', remote])
    if (!bare.ok) return t.skip('git init --bare unsupported')

    await gitInit(a); await cfg(a)
    writeFileSync(join(a, 'shared.txt'), 'base\n')
    await commitAll(a, 'base')
    await addRemote(a, remote)
    await pushSetUpstream(a)

    const clone = await runCommand('git', ['clone', remote, b])
    assert.ok(clone.ok, `clone: ${clone.stderr}`)
    await cfg(b)

    // A DELETES the file and pushes; B MODIFIES the same file → modify/delete.
    rmSync(join(a, 'shared.txt'))
    await commitAll(a, 'A delete')
    const pa = await push(a)
    assert.ok(pa.ok, `A push: ${pa.raw.stderr}`)
    writeFileSync(join(b, 'shared.txt'), 'B version\n')
    await commitAll(b, 'B edit')

    const sync = await syncProject(b)
    assert.equal(sync.conflict, true, 'modify/delete conflict detected')
    assert.ok(sync.conflictedFiles.includes('shared.txt'))

    const details = await getConflictDetails(b)
    const cf = details.find((d) => d.path === 'shared.txt')
    assert.ok(cf, 'in conflict details')
    assert.equal(cf!.theirs, null, 'deleted on the incoming (theirs) side')
    assert.match(cf!.mine ?? '', /B version/)

    // Accept the deletion — pick "theirs" (the side that removed it). This is the
    // case that used to fail: `checkout --theirs` has no version → now `git rm`.
    const res = await resolveSyncConflict(b, [{ path: 'shared.txt', mode: 'theirs' }])
    assert.ok(res.ok, `resolve: ${res.error}`)
    assert.equal(res.pushed, true)
    assert.ok(!existsSync(join(b, 'shared.txt')), 'file removed locally')

    await runCommand('git', ['clone', remote, verify])
    assert.ok(!existsSync(join(verify, 'shared.txt')), 'deletion landed on remote')
  } finally {
    for (const d of [remote, a, b, verify]) rmSync(d, { recursive: true, force: true })
  }
})

test('listIgnoredButTracked: flags shared files a later .gitignore rule now matches', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')
  const work = tmp('rp-ignored-tracked-')
  try {
    await gitInit(work)
    await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'Test'], { cwd: work })
    mkdirSync(join(work, 'shared'), { recursive: true })
    writeFileSync(join(work, 'shared', 'note.md'), '# already shared\n')
    await commitAll(work, 'share a folder')

    // Healthy repo: nothing tracked is ignored.
    assert.deepEqual(await listIgnoredButTracked(work), [])
    const clean = await getLocalSyncState(work)
    assert.deepEqual(clean?.ignoredTracked, [])

    // User ignores an already-shared folder. git does NOT untrack it — the file
    // keeps syncing — but it now surfaces as tracked-but-ignored (the warning
    // set the Sync pill shows), because NEW files there would silently not sync.
    writeFileSync(join(work, '.gitignore'), 'shared/\n')
    const flagged = await listIgnoredButTracked(work)
    assert.ok(flagged.includes('shared/note.md'), 'the already-tracked file is flagged')
    const state = await getLocalSyncState(work)
    assert.ok((state?.ignoredTracked ?? []).includes('shared/note.md'), 'surfaced via getLocalSyncState')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('listLargeChangedFiles: flags only files over the threshold', async (t) => {
  if (!(await isGitInstalled())) return t.skip('git not installed')
  const work = tmp('rp-lfs-')
  try {
    await gitInit(work)
    await runCommand('git', ['config', 'user.email', 'test@example.com'], { cwd: work })
    await runCommand('git', ['config', 'user.name', 'Test'], { cwd: work })
    writeFileSync(join(work, 'small.txt'), 'x')
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(2048, 1))
    const big = await listLargeChangedFiles(work, 1024)
    assert.ok(big.includes('big.bin'), 'big file flagged')
    assert.ok(!big.includes('small.txt'), 'small file not flagged')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
