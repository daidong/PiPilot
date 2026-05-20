/**
 * Tests for path-utils — expandHome + resolveUserPath.
 *
 * These pin the user-path normalization contract that every compute
 * backend, tool, and IPC handler relies on. Getting `~` expansion
 * wrong is a class of bug we've already hit on EC2 (privateKeyPath)
 * and would have hit on compute_plan's script_path; centralizing the
 * logic here is what makes those sites match.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { expandHome, resolveUserPath } from '../path-utils.js'

const HOME = os.homedir()

// ── expandHome ─────────────────────────────────────────────────────────

test('expandHome: bare ~ → homedir()', () => {
  assert.equal(expandHome('~'), HOME)
})

test('expandHome: ~/.ssh/key.pem → <home>/.ssh/key.pem (canonical case)', () => {
  assert.equal(expandHome('~/.ssh/key.pem'), path.join(HOME, '.ssh', 'key.pem'))
})

test('expandHome: ~\\ssh\\key.pem (Windows backslash) → joined correctly', () => {
  assert.equal(expandHome('~\\ssh\\key.pem'), path.join(HOME, 'ssh\\key.pem'))
})

test('expandHome: absolute path passes through', () => {
  assert.equal(expandHome('/Users/dong/.ssh/key.pem'), '/Users/dong/.ssh/key.pem')
})

test('expandHome: relative path passes through (workspace-resolve is a separate concern)', () => {
  assert.equal(expandHome('scripts/foo.sh'), 'scripts/foo.sh')
})

test('expandHome: ~otheruser NOT expanded (cross-platform homedir-other is unsupported)', () => {
  assert.equal(expandHome('~otheruser/file'), '~otheruser/file')
})

test('expandHome: empty / undefined / mid-string ~ pass through (defensive)', () => {
  assert.equal(expandHome(''), '')
  assert.equal(expandHome('/var/log/~archive/foo'), '/var/log/~archive/foo')
})

// ── resolveUserPath ────────────────────────────────────────────────────

test('resolveUserPath: ~/foo expands then is absolute → workspace ignored', () => {
  const result = resolveUserPath('/workspace', '~/foo.sh')
  assert.equal(result, path.join(HOME, 'foo.sh'),
    'tilde-expanded paths are absolute — must NOT be joined under workspace')
})

test('resolveUserPath: relative path joined under workspace (Local/Modal expectation)', () => {
  const result = resolveUserPath('/workspace', 'scripts/foo.sh')
  assert.equal(result, path.resolve('/workspace', 'scripts/foo.sh'))
})

test('resolveUserPath: absolute path passes through unchanged', () => {
  const result = resolveUserPath('/workspace', '/abs/foo.sh')
  assert.equal(result, '/abs/foo.sh')
})

test('resolveUserPath: the regression — `~/foo.sh` must not become `<workspace>/~/foo.sh`', () => {
  // This is the broken behavior the layer-ordering of resolveUserPath
  // is designed to prevent. If a future refactor inverts the order
  // (path.resolve first, then expandHome), this test fails.
  const result = resolveUserPath('/workspace', '~/foo.sh')
  assert.ok(!result.includes('~'), `result should contain no literal '~' — got ${result}`)
  assert.ok(!result.startsWith('/workspace/~'), `result should not be workspace-relative — got ${result}`)
})

test('resolveUserPath: bare ~ resolves to homedir', () => {
  assert.equal(resolveUserPath('/workspace', '~'), HOME)
})
