/**
 * Tests for compaction-state persistence.
 *
 * Pure file-IO tests — no LLM, no network. Verifies:
 * - round-trip preserves payload
 * - schemaVersion mismatch returns null (not crash)
 * - corrupt JSON returns null (not crash)
 * - missing file returns null
 * - sessionId mismatch in payload returns null (defensive)
 * - delete is idempotent and tolerates missing file
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCompactionState,
  writeCompactionState,
  deleteCompactionState,
  COMPACTION_STATE_SCHEMA_VERSION,
  type CompactionState
} from '../store.js'
import { PATHS } from '../../types.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-compaction-'))
}

function makeState(overrides: Partial<CompactionState> = {}): CompactionState {
  return {
    schemaVersion: COMPACTION_STATE_SCHEMA_VERSION,
    sessionId: 'session-A',
    summary: 'turns 1-20: discussed quantum entanglement experiments',
    compactionCount: 1,
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

test('round-trip preserves all fields', () => {
  const project = tmpProject()
  try {
    const original = makeState()
    writeCompactionState(project, original)
    const loaded = readCompactionState(project, original.sessionId)
    assert.deepEqual(loaded, original)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when file is missing', () => {
  const project = tmpProject()
  try {
    assert.equal(readCompactionState(project, 'no-such-session'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null on schemaVersion mismatch (forward + back compat)', () => {
  const project = tmpProject()
  try {
    const dir = join(project, PATHS.compactionState)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'session-A.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 99,
        sessionId: 'session-A',
        summary: 'something',
        compactionCount: 1,
        updatedAt: new Date().toISOString()
      })
    )
    assert.equal(readCompactionState(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null on malformed JSON instead of throwing', () => {
  const project = tmpProject()
  try {
    const dir = join(project, PATHS.compactionState)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session-A.json'), 'not { valid ::: json')
    assert.equal(readCompactionState(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when payload sessionId does not match query sessionId', () => {
  const project = tmpProject()
  try {
    writeCompactionState(project, makeState({ sessionId: 'session-A' }))
    assert.equal(readCompactionState(project, 'session-B'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when summary is empty string', () => {
  const project = tmpProject()
  try {
    writeCompactionState(project, makeState({ summary: '' }))
    assert.equal(readCompactionState(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('returns null when required field is missing', () => {
  const project = tmpProject()
  try {
    const dir = join(project, PATHS.compactionState)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'session-A.json'),
      JSON.stringify({
        schemaVersion: COMPACTION_STATE_SCHEMA_VERSION,
        sessionId: 'session-A',
        summary: 'present'
        // compactionCount + updatedAt missing
      })
    )
    assert.equal(readCompactionState(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('writeCompactionState overwrites prior state in place', () => {
  const project = tmpProject()
  try {
    writeCompactionState(project, makeState({ summary: 'first', compactionCount: 1 }))
    writeCompactionState(project, makeState({ summary: 'second', compactionCount: 2 }))
    const loaded = readCompactionState(project, 'session-A')
    assert.ok(loaded)
    assert.equal(loaded!.summary, 'second')
    assert.equal(loaded!.compactionCount, 2)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('deleteCompactionState removes the file', () => {
  const project = tmpProject()
  try {
    writeCompactionState(project, makeState())
    const filePath = join(project, PATHS.compactionState, 'session-A.json')
    assert.ok(existsSync(filePath))
    deleteCompactionState(project, 'session-A')
    assert.ok(!existsSync(filePath))
    assert.equal(readCompactionState(project, 'session-A'), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('deleteCompactionState is idempotent on missing file', () => {
  const project = tmpProject()
  try {
    // No write — file doesn't exist
    assert.doesNotThrow(() => deleteCompactionState(project, 'never-written'))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('two sessions persist independently', () => {
  const project = tmpProject()
  try {
    writeCompactionState(project, makeState({ sessionId: 'A', summary: 'A summary' }))
    writeCompactionState(project, makeState({ sessionId: 'B', summary: 'B summary' }))

    const a = readCompactionState(project, 'A')
    const b = readCompactionState(project, 'B')

    assert.ok(a && b)
    assert.equal(a!.summary, 'A summary')
    assert.equal(b!.summary, 'B summary')

    deleteCompactionState(project, 'A')

    assert.equal(readCompactionState(project, 'A'), null)
    assert.ok(readCompactionState(project, 'B'))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
