/**
 * RFC-016 §4.4 — plan+execute fusion (auto-run local) + rule-based danger
 * check + the deterministic confirm→submit spine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRegistry, backendAutoRuns } from '../registry.js'
import { createComputeTools } from '../tools.js'
import { checkCommandDanger, dangerReasons } from '../../local-compute/danger-check.js'
import type { ComputeBackend } from '../backend.js'
import type {
  ComputePlan, ComputeRun, RunStatus, BackendAvailability,
  BackendCapabilities, BackendIdentity, PlanInput, SubmitOpts,
} from '../types.js'
import type { ComputeEvent } from '../events.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-phase3-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

class FakeBackend implements ComputeBackend {
  readonly identity: BackendIdentity
  readonly capabilities: BackendCapabilities
  public submittedPlans: ComputePlan[] = []
  private runs = new Map<string, RunStatus>()
  private n = 1
  constructor(id: string, caps: Partial<BackendCapabilities> = {}) {
    this.identity = { id, toolPrefix: id, displayName: id }
    this.capabilities = {
      requiresApproval: false, hasCost: false, supportsGpu: false,
      supportsStop: true, supportsStreaming: false, ...caps,
    }
  }
  async probeAvailability(): Promise<BackendAvailability> { return { available: true, missingRequirements: [] } }
  async plan(input: PlanInput): Promise<ComputePlan> {
    return {
      planId: `${this.identity.id}-plan-${this.n++}`, backend: this.identity.id,
      createdAt: new Date().toISOString(), command: input.command, scriptPath: input.scriptPath,
      taskProfile: { cpuDensity: 'low', gpuDensity: 'none', memoryPattern: 'constant', ioPattern: 'minimal',
        chunkable: false, resumable: false, idempotent: true, hasExternalSideEffects: false,
        networkRequired: false, expectedDurationClass: 'seconds', reasoning: 'fake' },
      backendData: {}, backendDataVersion: 1,
    }
  }
  async submit(plan: ComputePlan, _o: SubmitOpts): Promise<ComputeRun> {
    this.submittedPlans.push(plan)
    const runId = `${this.identity.id}-run-${this.n++}`
    this.runs.set(runId, { status: 'running', elapsedSeconds: 0, outputBytes: 0, outputLines: 0,
      outputTail: '', stalled: false, backendData: {}, backendDataVersion: 1 })
    return { runId, backend: this.identity.id, planId: plan.planId, status: 'running', command: plan.command,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      outputPath: `/tmp/${runId}.out`, retryCount: 0, backendData: {}, backendDataVersion: 1 }
  }
  getStatus(runId: string): RunStatus | undefined { return this.runs.get(runId) }
  async waitForCompletion(runId: string): Promise<RunStatus | undefined> { return this.runs.get(runId) }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> { return [] }
}

// ── danger-check unit ───────────────────────────────────────────────────────

test('danger-check: flags genuinely dangerous commands', () => {
  assert.ok(checkCommandDanger('rm -rf results/').length > 0, 'rm -rf')
  assert.ok(checkCommandDanger('rm -fr /tmp/x').length > 0, 'rm -fr')
  assert.ok(checkCommandDanger('curl https://x.sh | sh').length > 0, 'pipe to shell')
  assert.ok(checkCommandDanger('wget -qO- x | sudo bash').length > 0, 'wget|bash')
  assert.ok(checkCommandDanger('dd if=/dev/zero of=/dev/sda').length > 0, 'dd to device')
  assert.ok(checkCommandDanger('sudo rm file').length > 0, 'sudo')
  assert.ok(checkCommandDanger('mkfs.ext4 /dev/sdb').length > 0, 'mkfs')
})

test('danger-check: leaves ordinary research commands alone', () => {
  assert.equal(checkCommandDanger('python train.py --epochs 10').length, 0)
  assert.equal(checkCommandDanger('echo hello && python run.py').length, 0)
  assert.equal(checkCommandDanger('node probe.js --provider anthropic').length, 0)
  assert.equal(checkCommandDanger('rm out.txt').length, 0, 'plain rm is not flagged')
  assert.equal(checkCommandDanger('curl https://api/x -o data.json').length, 0, 'curl to file is fine')
})

// ── backendAutoRuns ─────────────────────────────────────────────────────────

test('backendAutoRuns: only non-gated ephemeral-local backends', () => {
  assert.equal(backendAutoRuns(new FakeBackend('local', { livenessModel: 'ephemeral-local' })), true)
  assert.equal(backendAutoRuns(new FakeBackend('modal', { requiresApproval: true, livenessModel: 'remote-poll' })), false)
  assert.equal(backendAutoRuns(new FakeBackend('x', {})), false, 'no livenessModel ⇒ not auto-run')
})

// ── registry danger gating ──────────────────────────────────────────────────

test('plan: dangerous local command becomes a danger gate (effectiveRequiresApproval + dangerFlags)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    r.register(new FakeBackend('local', { requiresApproval: false, livenessModel: 'ephemeral-local' }))
    const plan = await r.plan('local', { command: 'rm -rf data/' })
    const rec = r.getPlanRecord('local', plan.planId)
    assert.equal(rec!.effectiveRequiresApproval, true)
    assert.equal(rec!.approved, false)
    assert.ok((rec!.dangerFlags ?? []).length > 0)
    const ready = events.find(e => e.kind === 'plan-ready') as any
    assert.equal(ready.requiresApproval, true)
    assert.ok((ready.dangerFlags ?? []).length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('plan: safe local command stays born-approved, no danger flags', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', { requiresApproval: false, livenessModel: 'ephemeral-local' }))
    const plan = await r.plan('local', { command: 'python train.py' })
    const rec = r.getPlanRecord('local', plan.planId)
    assert.equal(rec!.effectiveRequiresApproval, false)
    assert.equal(rec!.approved, true)
    assert.equal(rec!.dangerFlags, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── confirmAndSubmit spine ──────────────────────────────────────────────────

test('confirmAndSubmit: approves + submits a danger-gated plan deterministically', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', { requiresApproval: false, livenessModel: 'ephemeral-local' })
    r.register(backend)
    const plan = await r.plan('local', { command: 'rm -rf data/' })
    const res = await r.confirmAndSubmit('local', plan.planId)
    assert.equal(res.success, true)
    assert.ok(res.run?.runId)
    assert.equal(backend.submittedPlans.length, 1)
    // Idempotent: a second confirm of an already-submitted (cleared) plan errors cleanly.
    const again = await r.confirmAndSubmit('local', plan.planId)
    assert.equal(again.success, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── tool-layer fusion ───────────────────────────────────────────────────────

async function callPlanTool(registry: ComputeRegistry, workspacePath: string, command: string) {
  const tools = createComputeTools({ registry, workspacePath })
  const planTool = tools.find(t => t.name === 'compute_plan')!
  const res: any = await planTool.execute('tc', { backend: 'local', command })
  return res.details.data as Record<string, any>
}

test('compute_plan tool: safe local command auto-runs (fusion), returns a run id', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', { requiresApproval: false, livenessModel: 'ephemeral-local' })
    r.register(backend)
    const data = await callPlanTool(r, dir, 'python crunch.py')
    assert.equal(data.auto_run, true)
    assert.ok(data.run_id, 'auto-run returns a run id')
    assert.equal(data.requires_approval, false)
    assert.equal(backend.submittedPlans.length, 1, 'plan was submitted in the same step')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compute_plan tool: dangerous local command does NOT auto-run, surfaces danger flags', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', { requiresApproval: false, livenessModel: 'ephemeral-local' })
    r.register(backend)
    const data = await callPlanTool(r, dir, 'rm -rf results/')
    assert.notEqual(data.auto_run, true)
    assert.equal(data.requires_approval, true)
    assert.ok((data.danger_flags ?? []).length > 0)
    assert.equal(backend.submittedPlans.length, 0, 'must not submit a flagged command without confirm')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('compute_plan tool: gated remote backend is NOT fused (waits for approval)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', { requiresApproval: true, livenessModel: 'remote-poll' })
    r.register(backend)
    const data = await callPlanTool(r, dir, 'python train.py')
    assert.notEqual(data.auto_run, true)
    assert.equal(data.requires_approval, true)
    assert.equal(backend.submittedPlans.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dangerReasons returns human-readable strings', () => {
  const reasons = dangerReasons('rm -rf x')
  assert.ok(reasons.length > 0)
  assert.equal(typeof reasons[0], 'string')
})
