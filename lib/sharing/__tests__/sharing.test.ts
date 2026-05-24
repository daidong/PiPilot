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

import { slugifyDisplayName, ensureLocalIdentity, getLocalIdentity } from '../identity.js'
import { ensureSharingGitignore, ensureSharingGitattributes } from '../workspace-git.js'
import { looksLikeGithubLogin } from '../gh.js'
import { getSharingStatus, shareProject, buildSharingPromptClause } from '../share.js'
import {
  isGitInstalled,
  gitInit,
  commitAll,
  hasChanges,
  fetch,
  getAheadBehind,
  push,
  listLargeChangedFiles,
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
  } finally {
    rmSync(remote, { recursive: true, force: true })
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
