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
import { readTelemetryPrefs, hasTelemetryPrefs } from '../telemetry-prefs.js'
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
    assert.equal(r.toVersion, 2)
    assert.ok(r.config.id, 'id assigned')
    assert.equal(r.config.id?.length, 26, 'ULID length')
    assert.equal(r.config.telemetry, undefined, 'v2: telemetry not stored in project.json')
    assert.equal(r.config.configSchemaVersion, 2)

    // Persisted to disk — no telemetry block in the shared file.
    const written = JSON.parse(readFileSync(join(dir, PATHS.project), 'utf8'))
    assert.equal(written.configSchemaVersion, 2)
    assert.equal(written.telemetry, undefined, 'project.json carries no telemetry')
    assert.equal(written.id, r.config.id)
    // No legacy value ⇒ nothing seeded into local prefs (default disabled on read).
    assert.equal(hasTelemetryPrefs(dir), false)
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
    assert.equal(r2.fromVersion, 2)
    assert.equal(r2.toVersion, 2)
    assert.equal(r2.config.id, idAfterFirst, 'id preserved across runs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v2: migrates legacy telemetry into local prefs, strips it from project.json', () => {
  const dir = makeProject({
    name: 'Test',
    questions: [],
    userCorrections: [],
    id: 'CUSTOM-USER-ID-123',
    // Legacy v1 shape: telemetry lived in project.json. User had opted IN.
    telemetry: { tracingMode: 'enabled', bufferCapacity: 256 },
    configSchemaVersion: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  })
  try {
    const r = migrateProjectConfig(dir)
    assert.equal(r.migrated, true) // v1 → v2
    assert.equal(r.fromVersion, 1)
    assert.equal(r.toVersion, 2)
    assert.equal(r.config.id, 'CUSTOM-USER-ID-123', 'user id kept')
    assert.equal(r.config.telemetry, undefined, 'telemetry stripped from project.json')

    // project.json on disk no longer carries telemetry.
    const written = JSON.parse(readFileSync(join(dir, PATHS.project), 'utf8'))
    assert.equal(written.telemetry, undefined)

    // The opt-in was preserved — moved into the local, gitignored preferences.json.
    const tp = readTelemetryPrefs(dir)
    assert.equal(tp.tracingMode, 'enabled', 'user opt-in survives the move')
    assert.equal(tp.bufferCapacity, 256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SHARED project: v2 migration is read-only — never rewrites the shared project.json', () => {
  // Repro of the "joined and instantly shows uncommitted changes" bug: a project
  // shared at schema v1 (telemetry still in project.json) must NOT be rewritten
  // when a collaborator opens the clone, or git shows it dirty immediately.
  const dir = makeProject({
    name: 'Research Project',
    questions: [],
    userCorrections: [],
    id: '01KSDB8D7BGTS45PQN08TV0CZ8',
    telemetry: { tracingMode: 'disabled', bufferCapacity: 1024 },
    configSchemaVersion: 1,
    lead: '01KSDB8D7BGTS45PQN08TV0CZ8',
    members: [{ actorId: '01KSDB8D7BGTS45PQN08TV0CZ8', displayName: 'Dong Dai', role: 'lead' }],
    share: { host: 'github', repo: 'daidong/research-project-directoryskills' },
    createdAt: '2026-05-23T23:10:31.258Z',
    updatedAt: '2026-05-24T15:57:03.270Z',
  })
  try {
    const before = readFileSync(join(dir, PATHS.project), 'utf8')
    const r = migrateProjectConfig(dir)

    assert.equal(r.migrated, false, 'shared project.json is not rewritten on open')
    assert.equal(r.toVersion, 1, 'schema version left as-is for the shared file')

    const after = readFileSync(join(dir, PATHS.project), 'utf8')
    assert.equal(after, before, 'project.json must be byte-identical (no dirty clone)')

    // Member still gets telemetry locally (read side uses prefs).
    assert.equal(hasTelemetryPrefs(dir), true)
    assert.equal(readTelemetryPrefs(dir).tracingMode, 'disabled')
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
    assert.equal(row.toState, 2)
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
