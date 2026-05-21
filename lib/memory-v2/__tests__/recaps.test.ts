/**
 * Tests for auto-recap persistence (lib/memory-v2/recaps.ts).
 *
 * Pure file-IO — no LLM, no network. Verifies:
 * - round-trip preserves the record
 * - latest-wins: writing again overwrites in place (we keep only the latest)
 * - missing file → null (not crash)
 * - malformed JSON → null (not crash)
 * - a record with neither did nor next → null (defensive)
 * - sessions persist independently
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLatestRecap, writeLatestRecap } from '../recaps.js'
import { PATHS, type RecapRecord } from '../../types.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-recap-'))
}

function makeRecap(overrides: Partial<RecapRecord> = {}): RecapRecord {
  return {
    sessionId: 'session-A',
    did: 'You were wiring the auto-recap feature and got idle detection working.',
    next: 'Test the 3-minute trigger end to end.',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

test('round-trip preserves all fields', () => {
  const project = tmpProject()
  try {
    const original = makeRecap()
    writeLatestRecap(project, original)
    assert.deepEqual(readLatestRecap(project, original.sessionId), original)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('latest wins — second write overwrites the first', () => {
  const project = tmpProject()
  try {
    writeLatestRecap(project, makeRecap({ did: 'first' }))
    writeLatestRecap(project, makeRecap({ did: 'second' }))
    const loaded = readLatestRecap(project, 'session-A')
    assert.ok(loaded)
    assert.equal(loaded!.did, 'second')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when file is missing', () => {
  const project = tmpProject()
  try {
    assert.equal(readLatestRecap(project, 'no-such-session'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null on malformed JSON instead of throwing', () => {
  const project = tmpProject()
  try {
    const dir = join(project, PATHS.recaps)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-A.json'), 'not { valid ::: json')
    assert.equal(readLatestRecap(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when neither did nor next is a string', () => {
  const project = tmpProject()
  try {
    const dir = join(project, PATHS.recaps)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session-A.json'),
      JSON.stringify({ sessionId: 'session-A', createdAt: new Date().toISOString() })
    )
    assert.equal(readLatestRecap(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('a recap with only "next" still loads (did may be empty)', () => {
  const project = tmpProject()
  try {
    writeLatestRecap(project, makeRecap({ did: '', next: 'Run the tests.' }))
    const loaded = readLatestRecap(project, 'session-A')
    assert.ok(loaded)
    assert.equal(loaded!.next, 'Run the tests.')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('two sessions persist independently', () => {
  const project = tmpProject()
  try {
    writeLatestRecap(project, makeRecap({ sessionId: 'A', did: 'A work' }))
    writeLatestRecap(project, makeRecap({ sessionId: 'B', did: 'B work' }))
    assert.equal(readLatestRecap(project, 'A')!.did, 'A work')
    assert.equal(readLatestRecap(project, 'B')!.did, 'B work')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
