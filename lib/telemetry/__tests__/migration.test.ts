/**
 * Tests for migrateProjectConfig (§14.1).
 *
 * Run with: node --test lib/telemetry/__tests__/migration.test.ts
 * (uses Node's built-in test runner; no jest dep required)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { migrateProjectConfig } from '../migration.js'
import { PATHS } from '../../types.js'

function makeProject(seed: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-mig-test-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  writeFileSync(join(dir, PATHS.project), JSON.stringify(seed, null, 2))
  return dir
}

test('migrates a pre-telemetry project (no id, no telemetry, no schema version)', () => {
  const dir = makeProject({
    name: 'Test',
    description: '',
    questions: [],
    userCorrections: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    const r = migrateProjectConfig(dir)
    assert.equal(r.migrated, true)
    assert.equal(r.fromVersion, 0)
    assert.equal(r.toVersion, 1)
    assert.ok(r.config.id, 'id assigned')
    assert.equal(r.config.id?.length, 26, 'ULID length')
    assert.equal(r.config.telemetry?.tracingMode, 'disabled', 'opt-in default — new projects start disabled')
    assert.equal(r.config.telemetry?.bufferCapacity, 1024)
    assert.equal(r.config.configSchemaVersion, 1)

    // Persisted to disk
    const written = JSON.parse(readFileSync(join(dir, PATHS.project), 'utf8'))
    assert.equal(written.configSchemaVersion, 1)
    assert.equal(written.id, r.config.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idempotent: second call is a no-op', () => {
  const dir = makeProject({
    name: 'Test',
    questions: [],
    userCorrections: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    const r1 = migrateProjectConfig(dir)
    assert.equal(r1.migrated, true)
    const idAfterFirst = r1.config.id

    const r2 = migrateProjectConfig(dir)
    assert.equal(r2.migrated, false)
    assert.equal(r2.fromVersion, 1)
    assert.equal(r2.toVersion, 1)
    assert.equal(r2.config.id, idAfterFirst, 'id preserved across runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preserves user-set id and telemetry overrides', () => {
  const dir = makeProject({
    name: 'Test',
    questions: [],
    userCorrections: [],
    id: 'CUSTOM-USER-ID-123',
    telemetry: { tracingMode: 'disabled', bufferCapacity: 256 },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    const r = migrateProjectConfig(dir)
    assert.equal(r.migrated, true) // schema version was missing
    assert.equal(r.config.id, 'CUSTOM-USER-ID-123', 'user id kept')
    assert.equal(r.config.telemetry?.tracingMode, 'disabled', 'user opt-out kept')
    assert.equal(r.config.telemetry?.bufferCapacity, 256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writes config-migration row to tracing-state.jsonl', async () => {
  const dir = makeProject({
    name: 'Test',
    questions: [],
    userCorrections: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    migrateProjectConfig(dir)
    // tracing-state writer is async; wait one tick.
    await new Promise((r) => setTimeout(r, 50))
    const logFile = join(dir, PATHS.tracingState)
    assert.ok(existsSync(logFile), 'tracing-state.jsonl created')
    const content = readFileSync(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    assert.ok(lines.length >= 1)
    const row = JSON.parse(lines[0]!)
    assert.equal(row.kind, 'config-migration')
    assert.equal(row.fromState, 0)
    assert.equal(row.toState, 1)
    assert.equal(row.actor, 'system')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idempotent log: second migration call adds no extra row', async () => {
  const dir = makeProject({
    name: 'Test',
    questions: [],
    userCorrections: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    migrateProjectConfig(dir)
    await new Promise((r) => setTimeout(r, 50))
    migrateProjectConfig(dir) // no-op
    await new Promise((r) => setTimeout(r, 50))
    const content = readFileSync(join(dir, PATHS.tracingState), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1, 'only one migration row')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('throws on missing project.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-mig-test-'))
  try {
    assert.throws(() => migrateProjectConfig(dir), /project\.json not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
