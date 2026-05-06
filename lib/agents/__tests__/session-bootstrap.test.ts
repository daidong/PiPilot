/**
 * Tests for session-bootstrap (orphan-message recovery, once-only).
 *
 * Uses real file IO via tmpdir so we exercise the same readOrphanMessages
 * path the coordinator does in production. No LLM, no agent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBootstrap } from '../session-bootstrap.js'
import { PATHS, type SessionSummary } from '../../types.js'

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'pipilot-bootstrap-'))
}

function writeSessionJsonl(
  project: string,
  sessionId: string,
  rows: Array<{ role: string; content: string; timestamp: number }>
): void {
  const dir = join(project, PATHS.sessions)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n'))
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'sess-A',
    turnRange: [1, 5],
    summary: 'prior turns',
    topicsDiscussed: ['x'],
    openQuestions: [],
    createdAt: new Date(1_000_000).toISOString(), // ms epoch 1,000,000
    ...overrides
  }
}

test('consume returns orphans newer than summary cutoff', () => {
  const project = tmpProject()
  try {
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'old user msg', timestamp: 500_000 },
      { role: 'assistant', content: 'old assistant msg', timestamp: 600_000 },
      { role: 'user', content: 'new user msg', timestamp: 1_500_000 },
      { role: 'assistant', content: 'new assistant msg', timestamp: 1_600_000 }
    ])
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    const result = bootstrap.consume(makeSummary())
    assert.equal(result.orphanCount, 2)
    assert.ok(result.context.includes('new user msg'))
    assert.ok(result.context.includes('new assistant msg'))
    assert.ok(!result.context.includes('old user msg'))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('consume is once-only: second call returns empty', () => {
  const project = tmpProject()
  try {
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'msg', timestamp: 2_000_000 }
    ])
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    const first = bootstrap.consume(makeSummary())
    assert.equal(first.orphanCount, 1)
    const second = bootstrap.consume(makeSummary())
    assert.equal(second.orphanCount, 0)
    assert.equal(second.context, '')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('null summary uses cutoff=0, picks up all orphans', () => {
  const project = tmpProject()
  try {
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'first', timestamp: 100 },
      { role: 'assistant', content: 'second', timestamp: 200 }
    ])
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    const result = bootstrap.consume(null)
    assert.equal(result.orphanCount, 2)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('no orphans newer than cutoff → empty result', () => {
  const project = tmpProject()
  try {
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'old', timestamp: 100 }
    ])
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    // Summary is newer than the only message
    const result = bootstrap.consume(makeSummary({ createdAt: new Date(500).toISOString() }))
    assert.equal(result.orphanCount, 0)
    assert.equal(result.context, '')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('missing session file → empty result, no throw', () => {
  const project = tmpProject()
  try {
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'never-existed' })
    const result = bootstrap.consume(null)
    assert.equal(result.orphanCount, 0)
    assert.equal(result.context, '')
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('after a missing-file consume, the once-only flag still flips', () => {
  // The bootstrap budget should be spent even when the first call recovers
  // nothing — second call must not retry.
  const project = tmpProject()
  try {
    const bootstrap = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    bootstrap.consume(null) // empty, but flips done flag
    // Now write a session file
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'late arrival', timestamp: 100 }
    ])
    const second = bootstrap.consume(null)
    assert.equal(second.orphanCount, 0)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('two independent bootstrap instances each have their own once-flag', () => {
  const project = tmpProject()
  try {
    writeSessionJsonl(project, 'sess-A', [
      { role: 'user', content: 'msg', timestamp: 100 }
    ])
    const a = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    const b = createSessionBootstrap({ projectPath: project, sessionId: 'sess-A' })
    assert.equal(a.consume(null).orphanCount, 1)
    assert.equal(a.consume(null).orphanCount, 0) // a spent
    assert.equal(b.consume(null).orphanCount, 1) // b independent
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
