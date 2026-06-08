/**
 * RFC-016 §4.2 / §4.4 — remote track + deterministic confirm→submit.
 *
 *  - confirmAndSubmit() approves + submits a cost-gated remote plan from
 *    the main process (RFC-015 bridge), so the run starts without relying
 *    on the agent making a second execute call.
 *  - ModalRunner reconciles a crash-orphaned "running" record on
 *    (re)construction instead of leaving a remote zombie.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRegistry } from '../registry.js'
import { ModalRunner } from '../../modal-compute/modal-runner.js'
import { ModalRunStore } from '../../modal-compute/modal-run-store.js'
import type { ModalImageInspection, ModalRunRecord } from '../../modal-compute/types.js'
import type { ComputeBackend } from '../backend.js'
import type {
  ComputePlan, ComputeRun, RunStatus, BackendAvailability,
  BackendCapabilities, BackendIdentity, PlanInput, SubmitOpts,
} from '../types.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-phase4-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

/** A gated, remote-poll backend (Modal/AWS shape) for the confirm bridge. */
class GatedRemoteBackend implements ComputeBackend {
  readonly identity: BackendIdentity = { id: 'modal', toolPrefix: 'modal', displayName: 'Modal' }
  readonly capabilities: BackendCapabilities = {
    requiresApproval: true, hasCost: true, supportsGpu: true,
    supportsStop: true, supportsStreaming: false, livenessModel: 'remote-poll',
  }
  public submitted = 0
  async probeAvailability(): Promise<BackendAvailability> { return { available: true, missingRequirements: [] } }
  async plan(input: PlanInput): Promise<ComputePlan> {
    return {
      planId: 'mp-1', backend: 'modal', createdAt: new Date().toISOString(), command: input.command,
      taskProfile: { cpuDensity: 'low', gpuDensity: 'heavy', memoryPattern: 'constant', ioPattern: 'minimal',
        chunkable: false, resumable: false, idempotent: true, hasExternalSideEffects: false,
        networkRequired: true, expectedDurationClass: 'minutes', reasoning: 'fake' },
      costEstimate: { estimatedTotalUsd: 0.4, hourlyRateUsd: 2.4, expectedDurationMinutes: 10, notes: '', coverage: 'lower_bound' },
      backendData: {}, backendDataVersion: 1,
    }
  }
  async submit(plan: ComputePlan): Promise<ComputeRun> {
    this.submitted++
    return { runId: 'mr-1', backend: 'modal', planId: plan.planId, status: 'running', command: plan.command,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      outputPath: '/tmp/mr-1.out', retryCount: 0, estimatedCostUsd: 0, backendData: {}, backendDataVersion: 1 }
  }
  getStatus(): RunStatus | undefined {
    return { status: 'running', elapsedSeconds: 0, outputBytes: 0, outputLines: 0, outputTail: '',
      stalled: false, backendData: {}, backendDataVersion: 1 }
  }
  async waitForCompletion(): Promise<RunStatus | undefined> { return this.getStatus() }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> { return [] }
}

test('confirmAndSubmit: approves + submits a cost-gated remote plan deterministically', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new GatedRemoteBackend()
    r.register(backend)
    const plan = await r.plan('modal', { command: 'python train.py' })
    // Born gated (requiresApproval) — not yet approved, not yet submitted.
    const rec = r.getPlanRecord('modal', plan.planId)
    assert.equal(rec!.effectiveRequiresApproval, true)
    assert.equal(rec!.approved, false)
    assert.equal(backend.submitted, 0)

    const res = await r.confirmAndSubmit('modal', plan.planId)
    assert.equal(res.success, true)
    assert.equal(res.run?.runId, 'mr-1')
    assert.equal(backend.submitted, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('confirmAndSubmit: refuses a rejected plan', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new GatedRemoteBackend())
    const plan = await r.plan('modal', { command: 'python train.py' })
    r.rejectPlan('modal', plan.planId, 'too expensive')
    const res = await r.confirmAndSubmit('modal', plan.planId)
    assert.equal(res.success, false)
    assert.match(res.error ?? '', /rejected/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Modal restart reconcile ─────────────────────────────────────────────────

function fakeImage(): ModalImageInspection {
  return {
    source: 'modal_default', baseImage: 'python:3.11', pythonVersion: '3.11',
    pythonPackages: [], pythonPackageInstallers: [], systemPackages: [], envVars: [],
    localDirs: [], localFiles: [], localPythonSources: [], buildCommands: [], buildFunctions: [],
    buildGpuType: null, runtimeGpuType: null, gpuType: null, forceBuild: false, warnings: [], reasoning: '',
  }
}

test('ModalRunner reconcile: a crash-orphaned running record is finalized (not a zombie)', async () => {
  const dir = tempProject()
  try {
    const store = new ModalRunStore(dir)
    const runId = 'mr-zombie'
    const runDir = store.getRunDir(runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(store.getOutputPath(runId), 'some logs\n')
    const now = new Date().toISOString()
    const record: ModalRunRecord = {
      runId, planId: 'mp-z', status: 'running', command: 'modal run x.py', scriptPath: 'x.py',
      image: fakeImage(), costEstimate: { gpuRateUsdPerHour: 2.4, expectedDurationMinutes: 10, estimatedTotalUsd: 0.4, notes: '' },
      createdAt: now, startedAt: now, outputPath: store.getOutputPath(runId), outputBytes: 0, outputLines: 0,
      lastOutputAt: now, timeoutMs: 3_600_000, stallThresholdMs: 300_000, stalled: false, retryCount: 0,
      // pid omitted → treated as not-alive on reconstruction
    }
    store.createRun(record)
    store.flushNow()

    const runner = new ModalRunner({
      projectPath: dir, workspacePath: dir,
      getCostThreshold: () => 5, onCostKilled: () => {},
    })
    const reconciled = runner.getStore().getRun(runId)
    assert.ok(reconciled)
    assert.equal(reconciled!.status, 'failed')
    assert.match(reconciled!.error ?? '', /app restart/i)
    await runner.destroy()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
