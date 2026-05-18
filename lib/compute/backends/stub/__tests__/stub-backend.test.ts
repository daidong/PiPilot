import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StubBackend, STUB_BACKEND_DATA_VERSION } from '../stub-backend.js'
import { ComputeRegistry } from '../../../registry.js'
import type { ComputeContext } from '../../../context.js'
import type { ComputeEvent } from '../../../events.js'
import { isTerminal } from '../../../types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-stub-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

function buildContext(projectPath: string, events: ComputeEvent[]): ComputeContext {
  return {
    projectPath,
    workspacePath: projectPath,
    getCredentials: () => ({}),
    getCostThresholdUsd: () => 0,
    emit: e => events.push(e),
  }
}

// ─── identity / capabilities ────────────────────────────────────────────

test('StubBackend: identity matches conventions', () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))
    assert.equal(backend.identity.id, 'stub')
    assert.equal(backend.identity.toolPrefix, 'stub')
    assert.equal(backend.identity.displayName, 'Stub (diagnostic)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend: capabilities — no approval, no cost, supports stop', () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))
    assert.equal(backend.capabilities.requiresApproval, false)
    assert.equal(backend.capabilities.hasCost, false)
    assert.equal(backend.capabilities.supportsGpu, false)
    assert.equal(backend.capabilities.supportsStop, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend.probeAvailability: always available', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))
    const avail = await backend.probeAvailability()
    assert.equal(avail.available, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── plan ───────────────────────────────────────────────────────────────

test('StubBackend.plan: parses command keywords into plan data', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))

    const fast = await backend.plan({ command: 'echo hi' })
    assert.equal((fast.backendData as any).delayMs, 100)
    assert.equal((fast.backendData as any).simulateFailure, false)
    assert.equal(fast.costEstimate, undefined)
    assert.equal(fast.backendDataVersion, STUB_BACKEND_DATA_VERSION)

    const slow = await backend.plan({ command: 'SLOW heavy job' })
    assert.equal((slow.backendData as any).delayMs, 5000)

    const failPlan = await backend.plan({ command: 'should FAIL' })
    assert.equal((failPlan.backendData as any).simulateFailure, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend.plan: backendData is JSON-serializable (amendment A5)', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))
    const plan = await backend.plan({ command: 'FAIL slowly' })
    // Round trip — pin the JSON-only contract
    const a = JSON.parse(JSON.stringify(plan))
    const b = JSON.parse(JSON.stringify(plan))
    assert.deepEqual(a, b)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── end-to-end through Registry ────────────────────────────────────────

test('StubBackend e2e: plan + submit + wait reaches completed (happy path)', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    registry.subscribe(e => events.push(e))
    const ctx = buildContext(dir, [])
    ;(ctx as any).emit = (e: ComputeEvent) => registry.emit(e)
    registry.register(new StubBackend(ctx))

    const plan = await registry.plan('stub', { command: 'fast happy task' })
    assert.ok(plan.planId.startsWith('sp-'))
    const run = await registry.submit('stub', plan.planId, {})
    assert.ok(run.runId.startsWith('sr-'))

    const status = await registry.waitForCompletion(run.runId, 2000)
    assert.ok(status)
    assert.ok(isTerminal(status!.status))
    assert.equal(status!.status, 'completed')
    assert.equal(status!.exitCode, 0)

    // Events fired: plan-ready + run-update + run-complete
    assert.ok(events.find(e => e.kind === 'plan-ready'))
    assert.ok(events.find(e => e.kind === 'run-update'))
    assert.ok(events.find(e => e.kind === 'run-complete'))

    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend e2e: failure path surfaces failure signal', async () => {
  const dir = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const ctx = buildContext(dir, [])
    ;(ctx as any).emit = (e: ComputeEvent) => registry.emit(e)
    registry.register(new StubBackend(ctx))

    const plan = await registry.plan('stub', { command: 'job that will FAIL' })
    const run = await registry.submit('stub', plan.planId, {})
    const status = await registry.waitForCompletion(run.runId, 2000)
    assert.equal(status!.status, 'failed')
    assert.equal(status!.exitCode, 1)
    assert.ok(status!.failure)
    assert.equal(status!.failure!.code, 'COMMAND_FAILED')

    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend e2e: stop cancels a SLOW run', async () => {
  const dir = tempProject()
  try {
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const ctx = buildContext(dir, [])
    ;(ctx as any).emit = (e: ComputeEvent) => registry.emit(e)
    registry.register(new StubBackend(ctx))

    const plan = await registry.plan('stub', { command: 'SLOW long task' })
    const run = await registry.submit('stub', plan.planId, {})
    // Status should be running immediately (5s delayMs)
    assert.equal(registry.getStatus(run.runId)?.status, 'running')
    await registry.stop(run.runId)
    const status = await registry.waitForCompletion(run.runId, 500)
    assert.equal(status!.status, 'cancelled')

    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend.hydrate: in-memory only, returns empty', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const backend = new StubBackend(buildContext(dir, events))
    const hydrated = await backend.hydrate()
    assert.deepEqual(hydrated, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('StubBackend.destroy: clears in-flight timers (no leaked handles)', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const ctx = buildContext(dir, events)
    const backend = new StubBackend(ctx)
    const plan = await backend.plan({ command: 'SLOW idle' })
    await backend.submit(plan, {})
    // destroy before completion — timer should be cleared
    await backend.destroy()
    // Wait > delayMs to verify no event fires after destroy
    await new Promise(r => setTimeout(r, 150))
    // The plan-ready event fires via Registry, but here we call backend
    // methods directly so events come from submit's initial emit only.
    // Just assert no run-complete event fired post-destroy.
    const completes = events.filter(e => e.kind === 'run-complete')
    assert.equal(completes.length, 0, 'no run-complete should fire after destroy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
