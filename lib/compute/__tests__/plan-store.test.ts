import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlanStore } from '../plan-store.js'
import type { PlanRecord, ComputePlan } from '../types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-plan-store-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

function samplePlan(planId: string, backend = 'local'): ComputePlan {
  return {
    planId,
    backend,
    createdAt: new Date().toISOString(),
    command: 'echo hi',
    taskProfile: {
      cpuDensity: 'low',
      gpuDensity: 'none',
      memoryPattern: 'constant',
      ioPattern: 'minimal',
      chunkable: false,
      resumable: false,
      idempotent: true,
      hasExternalSideEffects: false,
      networkRequired: false,
      expectedDurationClass: 'seconds',
      reasoning: 'test plan',
    },
    backendData: { sandbox: 'process' },
    backendDataVersion: 1,
  }
}

function sampleRecord(planId: string, opts: Partial<PlanRecord> = {}): PlanRecord {
  return {
    plan: samplePlan(planId),
    effectiveRequiresApproval: false,
    approved: true,
    ...opts,
  }
}

test('PlanStore: read returns undefined when no record exists', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)
    assert.equal(store.read('local', 'p-missing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: write + read round trip preserves PlanRecord exactly', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)
    const record = sampleRecord('p-1', { effectiveRequiresApproval: true, approved: false })
    store.write('local', 'p-1', record)
    const read = store.read('local', 'p-1')
    assert.deepEqual(read, record)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: persists across instances via the JSON file', () => {
  const dir = tempProject()
  try {
    const a = new PlanStore(dir)
    a.write('local', 'p-1', sampleRecord('p-1'))
    // New instance — no shared cache. Must read from disk.
    const b = new PlanStore(dir)
    assert.equal(b.read('local', 'p-1')?.plan.planId, 'p-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: clear deletes a single (backend, planId) entry without touching others', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)
    store.write('local', 'p-1', sampleRecord('p-1'))
    store.write('modal', 'p-2', sampleRecord('p-2'))
    store.write('local', 'p-3', sampleRecord('p-3'))
    store.clear('local', 'p-1')
    assert.equal(store.read('local', 'p-1'), undefined)
    assert.notEqual(store.read('modal', 'p-2'), undefined)
    assert.notEqual(store.read('local', 'p-3'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: write atomically replaces the file (no torn writes from rapid succession)', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)
    for (let i = 0; i < 10; i++) {
      store.write('local', `p-${i}`, sampleRecord(`p-${i}`))
    }
    // Final file should be a single, parseable JSON document.
    const filePath = join(dir, '.research-pilot', 'compute-plans.json')
    assert.ok(existsSync(filePath))
    // Re-read from a fresh instance — confirms the file is well-formed JSON.
    const fresh = new PlanStore(dir)
    for (let i = 0; i < 10; i++) {
      assert.equal(fresh.read('local', `p-${i}`)?.plan.planId, `p-${i}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: listPending returns only ungated, unapproved, non-rejected entries', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)

    // (a) requires approval, not yet approved → should appear
    store.write('modal', 'p-pending', sampleRecord('p-pending', {
      effectiveRequiresApproval: true,
      approved: false,
    }))

    // (b) requires approval but already approved → should NOT appear
    store.write('modal', 'p-approved', sampleRecord('p-approved', {
      effectiveRequiresApproval: true,
      approved: true,
      approvedAt: new Date().toISOString(),
    }))

    // (c) requires approval but rejected → should NOT appear
    store.write('modal', 'p-rejected', sampleRecord('p-rejected', {
      effectiveRequiresApproval: true,
      approved: false,
      rejectedAt: new Date().toISOString(),
      rejectionComments: 'nope',
    }))

    // (d) does not require approval (auto-approved) → should NOT appear
    store.write('local', 'p-auto', sampleRecord('p-auto', {
      effectiveRequiresApproval: false,
      approved: true,
    }))

    const pending = store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].backend, 'modal')
    assert.equal(pending[0].planId, 'p-pending')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: listActive returns every non-rejected entry — approved-but-not-run plans survive hydrate (regression)', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)

    // (a) requires approval, not yet approved → active (approval banner)
    store.write('modal', 'p-pending', sampleRecord('p-pending', {
      effectiveRequiresApproval: true,
      approved: false,
    }))

    // (b) requires approval, already approved but NOT yet submitted →
    // active (renders as a "queued, waiting for agent" placeholder row).
    // This is the case the old listPending()-backed hydrate dropped,
    // making the Compute tab go empty after a UI refresh.
    store.write('modal', 'p-approved', sampleRecord('p-approved', {
      effectiveRequiresApproval: true,
      approved: true,
      approvedAt: new Date().toISOString(),
    }))

    // (c) rejected → NOT active (chat flow takes over)
    store.write('modal', 'p-rejected', sampleRecord('p-rejected', {
      effectiveRequiresApproval: true,
      approved: false,
      rejectedAt: new Date().toISOString(),
      rejectionComments: 'nope',
    }))

    // (d) auto-approved (no approval required) but not yet submitted →
    // active (also a queued placeholder until the agent executes).
    store.write('local', 'p-auto', sampleRecord('p-auto', {
      effectiveRequiresApproval: false,
      approved: true,
    }))

    const active = store.listActive()
    const ids = active.map((e) => e.planId).sort()
    assert.deepEqual(ids, ['p-approved', 'p-auto', 'p-pending'])
    assert.ok(!ids.includes('p-rejected'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: composite key cleanly splits even when planId contains :: (regression guard)', () => {
  const dir = tempProject()
  try {
    const store = new PlanStore(dir)
    // PlanIds use random hex; this guards against future schemes that might.
    store.write('modal', 'mp-abc::weird', sampleRecord('mp-abc::weird'))
    const all = store.listAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].backend, 'modal')
    // Key splits on FIRST '::', so the rest stays as planId.
    assert.equal(all[0].planId, 'mp-abc::weird')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PlanStore: tolerant of corrupt JSON on disk (returns empty, does not throw)', () => {
  const dir = tempProject()
  try {
    const filePath = join(dir, '.research-pilot', 'compute-plans.json')
    mkdirSync(join(dir, '.research-pilot'), { recursive: true })
    // Write garbage
    writeFileSync(filePath, '{not valid json', 'utf-8')
    const store = new PlanStore(dir)
    assert.equal(store.read('local', 'p-1'), undefined)
    assert.deepEqual(store.listPending(), [])
    // Recoverable: subsequent write should succeed
    store.write('local', 'p-new', sampleRecord('p-new'))
    assert.notEqual(store.read('local', 'p-new'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
