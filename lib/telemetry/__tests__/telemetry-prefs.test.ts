/**
 * Tests for telemetry-prefs (schema v2): telemetry config lives in the LOCAL
 * preferences.json, merge-preserving so it coexists with model/effort prefs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTelemetryPrefs, writeTelemetryPrefs, hasTelemetryPrefs, isTracingEnabled } from '../telemetry-prefs.js'
import { PATHS } from '../../types.js'

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-tp-'))
  mkdirSync(join(dir, PATHS.root), { recursive: true })
  return dir
}
const prefsFile = (dir: string) => join(dir, PATHS.root, 'preferences.json')

test('defaults to disabled / 1024 when no prefs exist', () => {
  const dir = makeProject()
  try {
    assert.equal(hasTelemetryPrefs(dir), false)
    const tp = readTelemetryPrefs(dir)
    assert.equal(tp.tracingMode, 'disabled')
    assert.equal(tp.bufferCapacity, 1024)
    assert.equal(isTracingEnabled(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write + read round-trip', () => {
  const dir = makeProject()
  try {
    writeTelemetryPrefs(dir, { tracingMode: 'enabled' })
    assert.equal(hasTelemetryPrefs(dir), true)
    assert.equal(isTracingEnabled(dir), true)
    assert.equal(readTelemetryPrefs(dir).bufferCapacity, 1024, 'unspecified field keeps default')
    writeTelemetryPrefs(dir, { bufferCapacity: 512 })
    const tp = readTelemetryPrefs(dir)
    assert.equal(tp.tracingMode, 'enabled', 'prior field preserved on partial write')
    assert.equal(tp.bufferCapacity, 512)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merge-preserving: never clobbers sibling keys (selectedModel/reasoningEffort)', () => {
  const dir = makeProject()
  try {
    // Simulate prefs:save having written model/effort first.
    writeFileSync(prefsFile(dir), JSON.stringify({ selectedModel: 'claude-opus-4-7', reasoningEffort: 'high' }))
    writeTelemetryPrefs(dir, { tracingMode: 'enabled' })
    const onDisk = JSON.parse(readFileSync(prefsFile(dir), 'utf-8'))
    assert.equal(onDisk.selectedModel, 'claude-opus-4-7', 'model preserved')
    assert.equal(onDisk.reasoningEffort, 'high', 'effort preserved')
    assert.equal(onDisk.telemetry.tracingMode, 'enabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tolerates malformed preferences.json (falls back to defaults)', () => {
  const dir = makeProject()
  try {
    writeFileSync(prefsFile(dir), '{ not json')
    const tp = readTelemetryPrefs(dir)
    assert.equal(tp.tracingMode, 'disabled')
    // A subsequent write recovers a valid file.
    writeTelemetryPrefs(dir, { tracingMode: 'enabled' })
    assert.equal(readTelemetryPrefs(dir).tracingMode, 'enabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
