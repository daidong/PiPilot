/**
 * RFC-016 §4.1 — child exit sentinel + monitor liveness finalization.
 *
 * These tests exercise the "slow path": a run whose in-memory
 * handle.wait() is gone (the runner was reconstructed — main-process
 * reload, model switch, project reopen) must still be finalized from the
 * child-written exit sentinel + OS liveness, instead of being left an
 * eternal "running" zombie OR unconditionally marked failed.
 *
 * We simulate a reconstruction by writing a `running` record (with no live
 * PID) + an `exit_code` sentinel directly to the store, then constructing a
 * fresh ComputeRunner and asserting reconcileStaleRuns() derives the
 * correct terminal status from the sentinel.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRunner } from '../../local-compute/runner.js'
import { RunStore } from '../../local-compute/run-store.js'
import type { RunRecord } from '../../local-compute/types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-sentinel-'))
  mkdirSync(join(dir, '.research-pilot/compute-runs'), { recursive: true })
  return dir
}

/**
 * Seed a `running` record whose process is gone (no PID ⇒ isStaleRun) and,
 * optionally, an exit-code sentinel in its run dir.
 */
function seedStaleRun(projectPath: string, runId: string, sentinel: string | null): void {
  const store = new RunStore(projectPath)
  const runDir = store.getRunDir(runId)
  mkdirSync(runDir, { recursive: true })
  // Empty output/stderr so the tail reads don't throw.
  writeFileSync(store.getOutputPath(runId), '')
  writeFileSync(store.getStderrPath(runId), '')
  if (sentinel !== null) {
    writeFileSync(join(runDir, 'exit_code'), sentinel)
  }
  const now = new Date().toISOString()
  const record: RunRecord = {
    runId,
    status: 'running',
    weight: 'light',
    currentPhase: 'full',
    command: 'echo hi',
    workDir: '.',
    sandboxWorkDir: projectPath,
    sandbox: 'process',
    createdAt: now,
    startedAt: now,
    outputPath: store.getOutputPath(runId),
    outputBytes: 0,
    outputLines: 0,
    timeoutMs: 60_000,
    stallThresholdMs: 300_000,
    stalled: false,
    retryCount: 0,
    // pid intentionally omitted → isStaleRun() returns true (no live process)
  }
  store.createRun(record)
  store.flushNow()
}

test('reconcile: dead run with exit_code=0 → completed', async () => {
  const dir = tempProject()
  try {
    seedStaleRun(dir, 'cr-ok', '0\n')
    const runner = new ComputeRunner({ projectPath: dir, workspacePath: dir })
    const run = runner.getStore().getRun('cr-ok')
    assert.ok(run)
    assert.equal(run!.status, 'completed')
    assert.equal(run!.exitCode, 0)
    await runner.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reconcile: dead run with non-zero exit_code → failed (real code preserved)', async () => {
  const dir = tempProject()
  try {
    seedStaleRun(dir, 'cr-fail', '7')
    const runner = new ComputeRunner({ projectPath: dir, workspacePath: dir })
    const run = runner.getStore().getRun('cr-fail')
    assert.ok(run)
    assert.equal(run!.status, 'failed')
    assert.equal(run!.exitCode, 7)
    await runner.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reconcile: dead run with MISSING sentinel → failed (killed before write), not mislabeled', async () => {
  const dir = tempProject()
  try {
    seedStaleRun(dir, 'cr-killed', null)
    const runner = new ComputeRunner({ projectPath: dir, workspacePath: dir })
    const run = runner.getStore().getRun('cr-killed')
    assert.ok(run)
    assert.equal(run!.status, 'failed')
    assert.equal(run!.exitCode, undefined)
    assert.match(run!.error ?? '', /without recording an exit code/i)
    await runner.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onRunUpdate fires a terminal update during reconcile', async () => {
  const dir = tempProject()
  try {
    seedStaleRun(dir, 'cr-emit', '0')
    const updates: Array<{ runId: string; status: string }> = []
    const runner = new ComputeRunner({
      projectPath: dir,
      workspacePath: dir,
      onRunUpdate: (runId, status) => updates.push({ runId, status: status.status }),
    })
    const emitted = updates.find(u => u.runId === 'cr-emit')
    assert.ok(emitted, 'expected an onRunUpdate callback during reconcile')
    assert.equal(emitted!.status, 'completed')
    await runner.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
