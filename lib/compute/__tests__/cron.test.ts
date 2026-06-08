/**
 * RFC-016 §4.5 — scheduled / recurring runs: schedule parsing, the
 * home-scoped store, and the app-lifetime scanner.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSchedule, isDue, nextDue, countMissed, isValidSchedule } from '../cron/schedule.js'
import { CronStore } from '../cron/cron-store.js'
import { CronScanner } from '../cron/scanner.js'
import type { CronTask } from '../cron/types.js'

// ── schedule ────────────────────────────────────────────────────────────────

test('parseSchedule: intervals', () => {
  assert.deepEqual(parseSchedule('1h'), { kind: 'interval', ms: 3_600_000 })
  assert.deepEqual(parseSchedule('15m'), { kind: 'interval', ms: 900_000 })
  assert.deepEqual(parseSchedule('30s'), { kind: 'interval', ms: 30_000 })
  assert.deepEqual(parseSchedule('2d'), { kind: 'interval', ms: 172_800_000 })
})

test('parseSchedule: cron + invalid', () => {
  assert.equal(parseSchedule('*/5 * * * *').kind, 'cron')
  assert.equal(parseSchedule('0 9 * * 1-5').kind, 'cron')
  assert.equal(parseSchedule('').kind, 'invalid')
  assert.equal(parseSchedule('garbage').kind, 'invalid')
  assert.equal(parseSchedule('* * *').kind, 'invalid')      // wrong field count
  assert.equal(parseSchedule('99 * * * *').kind, 'invalid') // minute out of range
  assert.equal(isValidSchedule('1h'), true)
  assert.equal(isValidSchedule('nope'), false)
})

test('isDue: interval fires once enough time has elapsed', () => {
  const now = 10_000_000
  assert.equal(isDue('1h', now - 3_600_001, now), true)
  assert.equal(isDue('1h', now - 60_000, now), false)
})

test('isDue: cron matches the minute and avoids double-fire within it', () => {
  // 10:30:30 local — mid-minute so a small offset stays in the same minute.
  const t = Date.parse('2026-06-07T10:30:30')
  // baseline 90s earlier (10:29:00) is a different minute → due.
  assert.equal(isDue('* * * * *', t - 90_000, t), true)
  // baseline 5s earlier (10:30:25) is the SAME minute → already fired → not due.
  assert.equal(isDue('* * * * *', t - 5_000, t), false)
})

test('nextDue + countMissed: interval', () => {
  const base = 1_000_000_000
  assert.equal(nextDue('1h', base, base + 100), base + 3_600_000)
  // closed for ~5h: 4 missed ticks (the 5th is "due now")
  assert.equal(countMissed('1h', base, base + 5 * 3_600_000 + 1), 4)
  assert.equal(countMissed('1h', base, base + 30 * 60_000), 0)
})

// ── store ─────────────────────────────────────────────────────────────────

function tempStore(): { store: CronStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rp-cron-'))
  return { store: new CronStore({ dir }), dir }
}

test('CronStore: create / get / list / update / delete round-trips', () => {
  const { store, dir } = tempStore()
  try {
    const t = store.create({ schedule: '1h', command: 'echo hi', backend: 'local', enabled: true })
    assert.ok(t.id.startsWith('cron-'))
    assert.ok(t.campaignId.startsWith('camp-'))
    assert.equal(store.get(t.id)?.command, 'echo hi')
    assert.equal(store.list().length, 1)
    const updated = store.update(t.id, { enabled: false, lastRun: '2026-01-01T00:00:00Z' })
    assert.equal(updated?.enabled, false)
    assert.equal(store.get(t.id)?.lastRun, '2026-01-01T00:00:00Z')
    assert.equal(store.delete(t.id), true)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── scanner ───────────────────────────────────────────────────────────────

test('CronScanner.tick: fires a due enabled task, advances lastRun, stamps lastRunId', async () => {
  const { store, dir } = tempStore()
  try {
    const fired: CronTask[] = []
    const scanner = new CronScanner({
      store,
      submit: async (task) => { fired.push(task); return { runId: 'cr-fired-1' } },
    })
    const t = store.create({ schedule: '1h', command: 'python probe.py', backend: 'local', enabled: true })
    // Make it overdue.
    store.update(t.id, { lastRun: new Date(Date.now() - 2 * 3_600_000).toISOString() })

    await scanner.tick()
    assert.equal(fired.length, 1)
    assert.equal(fired[0].id, t.id)
    const after = store.get(t.id)!
    assert.equal(after.lastRunId, 'cr-fired-1')
    assert.ok(after.lastRun && Date.now() - Date.parse(after.lastRun) < 5_000, 'lastRun advanced to ~now')

    // Not due again immediately.
    await scanner.tick()
    assert.equal(fired.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CronScanner.tick: skips disabled tasks; runNow fires regardless of schedule', async () => {
  const { store, dir } = tempStore()
  try {
    let fires = 0
    const scanner = new CronScanner({ store, submit: async () => { fires++; return { runId: 'x' } } })
    const t = store.create({ schedule: '1h', command: 'echo hi', backend: 'local', enabled: false })
    store.update(t.id, { lastRun: new Date(Date.now() - 5 * 3_600_000).toISOString() })
    await scanner.tick()
    assert.equal(fires, 0, 'disabled tasks never fire on a tick')

    const res = await scanner.runNow(t.id)
    assert.equal(res.success, true)
    assert.equal(fires, 1, 'runNow fires even a disabled task on demand')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CronScanner.tick: a skipped tick (no target) does NOT consume the due tick', async () => {
  const { store, dir } = tempStore()
  try {
    let calls = 0
    const scanner = new CronScanner({ store, submit: async () => { calls++; return { skipped: true, error: 'No project open' } } })
    const t = store.create({ schedule: '1h', command: 'echo hi', backend: 'local', enabled: true })
    store.update(t.id, { lastRun: new Date(Date.now() - 2 * 3_600_000).toISOString() })

    await scanner.tick()
    assert.equal(calls, 1, 'submit was attempted')
    const after = store.get(t.id)!
    // lastRun unchanged → still due → re-fires next pass.
    assert.ok(Date.now() - Date.parse(after.lastRun!) > 3_600_000, 'lastRun NOT advanced on skip')

    await scanner.tick()
    assert.equal(calls, 2, 'still due, so it re-fires once a target appears')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CronScanner.listStatuses: surfaces nextDue + missedSinceLastOpen', () => {
  const { store, dir } = tempStore()
  try {
    const scanner = new CronScanner({ store, submit: async () => ({ runId: 'x' }) })
    const t = store.create({ schedule: '1h', command: 'echo hi', backend: 'local', enabled: true })
    store.update(t.id, { lastRun: new Date(Date.now() - 5 * 3_600_000).toISOString() })
    const status = scanner.listStatuses().find(s => s.id === t.id)!
    assert.ok(status.scheduleValid)
    assert.ok(status.nextDue, 'nextDue computed')
    assert.ok(status.missedSinceLastOpen >= 3, `missed counted (got ${status.missedSinceLastOpen})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
