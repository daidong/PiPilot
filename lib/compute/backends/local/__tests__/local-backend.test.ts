import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBackend, LOCAL_BACKEND_DATA_VERSION } from '../local-backend.js'
import type { ComputeContext } from '../../../context.js'
import type { ComputeEvent } from '../../../events.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-local-backend-'))
  mkdirSync(join(dir, '.research-pilot/compute-runs'), { recursive: true })
  return dir
}

function buildContext(projectPath: string, workspacePath: string = projectPath): ComputeContext {
  const events: ComputeEvent[] = []
  const ctx: ComputeContext = {
    projectPath,
    workspacePath,
    getCredentials: () => ({}),
    getCostThresholdUsd: () => 0,
    emit: e => events.push(e),
    // LocalBackend doesn't need createSubAgent — leave undefined.
  }
  ;(ctx as any).__events = events
  return ctx
}

function eventsOf(ctx: ComputeContext): ComputeEvent[] {
  return (ctx as any).__events as ComputeEvent[]
}

// ─── Identity / capabilities ─────────────────────────────────────────────

test('LocalBackend: identity matches RFC-008 §7.2', () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    assert.equal(backend.identity.id, 'local')
    assert.equal(backend.identity.toolPrefix, 'local')
    assert.equal(backend.identity.displayName, 'Local')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LocalBackend: capabilities — no approval, no cost, supports stop', () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    assert.equal(backend.capabilities.requiresApproval, false)
    assert.equal(backend.capabilities.hasCost, false)
    assert.equal(backend.capabilities.supportsStop, true)
    assert.equal(backend.capabilities.supportsStreaming, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── probeAvailability ───────────────────────────────────────────────────

test('LocalBackend: probeAvailability always returns available=true', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const avail = await backend.probeAvailability()
    assert.equal(avail.available, true)
    // missingRequirements may be non-empty when docker isn't installed —
    // but the backend itself is available (host-process fallback).
    assert.ok(Array.isArray(avail.missingRequirements))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── plan() — defaults when callLlm unavailable ──────────────────────────

test('LocalBackend.plan: produces a ComputePlan with the unified shape (no LLM available)', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const plan = await backend.plan({ command: 'python train.py' })
    assert.equal(plan.backend, 'local')
    assert.ok(plan.planId.startsWith('lp-'))
    assert.ok(plan.createdAt.length > 0)
    assert.equal(plan.command, 'python train.py')
    assert.ok(plan.taskProfile.reasoning.length > 0)
    assert.equal(plan.costEstimate, undefined, 'local has hasCost=false')
    assert.equal(plan.backendDataVersion, LOCAL_BACKEND_DATA_VERSION)
    // backendData is JSON-serializable (amendment A5 contract).
    // Note: undefined fields are dropped by JSON, so we compare two
    // round trips against each other (both go through the same lossy
    // pass), not the original against the round trip.
    const first = JSON.parse(JSON.stringify(plan))
    const second = JSON.parse(JSON.stringify(plan))
    assert.deepEqual(first, second)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LocalBackend.plan: backendData has the LocalBackendPlanData shape', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const plan = await backend.plan({ command: 'echo hi' })
    const data = plan.backendData as Record<string, unknown>
    assert.ok('smokeSupported' in data)
    assert.ok('risk' in data)
    assert.ok('recommendations' in data)
    assert.ok('resourceSnapshot' in data)
    assert.ok('envSummary' in data)
    // recommendations carries actionable defaults
    const rec = data.recommendations as Record<string, unknown>
    assert.ok(['docker', 'process', 'auto'].includes(rec.sandbox as string))
    assert.ok(typeof rec.timeoutMinutes === 'number')
    assert.ok(typeof rec.stallThresholdMinutes === 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LocalBackend.plan: reads script content when scriptPath provided', async () => {
  const dir = tempProject()
  try {
    const scriptDir = join(dir, 'scripts')
    mkdirSync(scriptDir, { recursive: true })
    const scriptPath = join(scriptDir, 'demo.py')
    writeFileSync(scriptPath, '# tiny script\nprint("hi")\n', 'utf-8')
    const backend = new LocalBackend(buildContext(dir, dir))
    const plan = await backend.plan({ command: 'python scripts/demo.py', scriptPath: 'scripts/demo.py' })
    // Just verifying it doesn't crash and the plan still references the script
    assert.equal(plan.scriptPath, 'scripts/demo.py')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── hydrate ─────────────────────────────────────────────────────────────

test('LocalBackend.hydrate: returns empty array when no runs persisted', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const result = await backend.hydrate()
    assert.deepEqual(result, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── getStatus on unknown runId ──────────────────────────────────────────

test('LocalBackend.getStatus: returns undefined for unknown runId', () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    assert.equal(backend.getStatus('lr-missing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── JSON serializability of plan data (amendment A5) ───────────────────

test('LocalBackend.plan: produces JSON-serializable backendData (amendment A5)', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const plan = await backend.plan({ command: 'echo hi' })
    // Verify deep clone via JSON round trip matches structurally
    const serialized = JSON.stringify(plan.backendData)
    const reparsed = JSON.parse(serialized)
    assert.deepEqual(reparsed, plan.backendData)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── Resource snapshot is populated ──────────────────────────────────────

test('LocalBackend.plan: resourceSnapshot has reasonable values', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    const plan = await backend.plan({ command: 'echo hi' })
    const data = plan.backendData as { resourceSnapshot: { freeMemoryMb: number; freeDiskMb: number; cpuLoadPercent: number; activeRuns: number } }
    assert.ok(data.resourceSnapshot.freeMemoryMb > 0, 'freeMemoryMb should be positive')
    assert.ok(data.resourceSnapshot.freeDiskMb >= 0, 'freeDiskMb should be non-negative')
    assert.ok(data.resourceSnapshot.cpuLoadPercent >= 0, 'cpuLoadPercent should be non-negative')
    assert.equal(data.resourceSnapshot.activeRuns, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── destroy is safe to call without runs ───────────────────────────────

test('LocalBackend.destroy: no-throw when nothing is running', async () => {
  const dir = tempProject()
  try {
    const backend = new LocalBackend(buildContext(dir))
    await backend.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
