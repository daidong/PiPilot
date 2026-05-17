/**
 * End-to-end smoke for the compute path on the local backend.
 *
 * Spawns a real `sh -c "echo …"` via ComputeRunner → LocalBackend →
 * ComputeRegistry → verifies the run reaches `completed` and that
 * `run-update` / `run-complete` events flow through Registry's
 * subscriber stream. No mocks; the only thing skipped is the LLM
 * path inside plan() (callLlm is undefined so profileTask returns
 * its deterministic default profile).
 *
 * Time budget: ~3-5s wall clock — the runner polls every few seconds
 * and the command exits in milliseconds. If the test takes longer,
 * the polling loop is broken.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRegistry } from '../registry.js'
import { LocalBackend } from '../backends/local/local-backend.js'
import type { ComputeContext } from '../context.js'
import type { ComputeEvent } from '../events.js'
import { isTerminal } from '../types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-e2e-'))
  mkdirSync(join(dir, '.research-pilot/compute-runs'), { recursive: true })
  return dir
}

function buildContext(projectPath: string, events: ComputeEvent[], emit: (event: ComputeEvent) => void): ComputeContext {
  return {
    projectPath,
    workspacePath: projectPath,
    getCredentials: () => ({}),
    getCostThresholdUsd: () => 0,
    emit: (e) => {
      events.push(e)
      emit(e)
    },
  }
}

test('end-to-end local: plan + submit + wait reaches completed (real process)', async (t) => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    registry.subscribe(e => events.push(e))

    // Build a ComputeContext that also forwards backend emits into the
    // registry's subscriber stream (Registry.emit), so the test sees the
    // same event flow the IPC layer would.
    const ctx = buildContext(dir, [], (e) => registry.emit(e))
    registry.register(new LocalBackend(ctx))

    // Plan a trivial command — no LLM, deterministic default profile.
    const plan = await registry.plan('local', { command: 'echo compute-e2e' })
    assert.equal(plan.backend, 'local')
    assert.ok(plan.planId.startsWith('lp-'))

    // Submit → expect a running ComputeRun back.
    const run = await registry.submit('local', plan.planId, { timeoutMinutes: 1, stallThresholdMinutes: 5 })
    assert.equal(run.backend, 'local')
    assert.ok(run.runId.length > 0)

    // Block up to 30s for completion (echo finishes immediately; the
    // runner just needs one poll cycle to notice).
    const status = await registry.waitForCompletion(run.runId, 30_000)
    assert.ok(status, 'waitForCompletion should return a status')
    assert.ok(isTerminal(status!.status), `run should be terminal; was ${status!.status}`)
    assert.equal(status!.status, 'completed', `echo should succeed; status=${status!.status}, exit=${status!.exitCode}`)
    assert.equal(status!.exitCode, 0)

    // The plan-ready event should have fired with requiresApproval: false
    // (local has no gate).
    const planReady = events.find(e => e.kind === 'plan-ready')
    assert.ok(planReady, 'expected plan-ready event')
    assert.equal((planReady as any).requiresApproval, false)

    // Cleanup
    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('end-to-end local: failed process surfaces failure signal', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const ctx = buildContext(dir, events, (e) => registry.emit(e))
    registry.register(new LocalBackend(ctx))

    const plan = await registry.plan('local', { command: 'sh -c "exit 7"' })
    const run = await registry.submit('local', plan.planId, { timeoutMinutes: 1 })
    const status = await registry.waitForCompletion(run.runId, 30_000)
    assert.ok(status)
    assert.equal(status!.status, 'failed', `expected failed; status=${status!.status}, exit=${status!.exitCode}`)
    assert.equal(status!.exitCode, 7)

    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('end-to-end local: stop cancels a long-running process', async () => {
  const dir = tempProject()
  try {
    const events: ComputeEvent[] = []
    const registry = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const ctx = buildContext(dir, events, (e) => registry.emit(e))
    registry.register(new LocalBackend(ctx))

    const plan = await registry.plan('local', { command: 'sh -c "sleep 30"' })
    const run = await registry.submit('local', plan.planId, { timeoutMinutes: 5 })

    // Give it a moment to actually start
    await new Promise(resolve => setTimeout(resolve, 200))

    await registry.stop(run.runId)
    const status = await registry.waitForCompletion(run.runId, 10_000)
    assert.ok(status)
    assert.equal(status!.status, 'cancelled', `expected cancelled; status=${status!.status}`)

    await registry.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
