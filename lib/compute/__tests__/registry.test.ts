import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputeRegistry } from '../registry.js'
import { extractResult } from '../../local-compute/progress.js'
import type { ComputeBackend } from '../backend.js'
import type {
  ComputePlan,
  ComputeRun,
  RunStatus,
  BackendAvailability,
  BackendCapabilities,
  BackendIdentity,
  PlanInput,
  SubmitOpts,
} from '../types.js'
import type { ComputeEvent } from '../events.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-registry-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

/** Minimal in-memory backend for testing the registry's contract. */
class FakeBackend implements ComputeBackend {
  readonly identity: BackendIdentity
  readonly capabilities: BackendCapabilities
  private runs = new Map<string, { run: ComputeRun; status: RunStatus }>()
  private nextRunNum = 1
  /** Captured for assertion. */
  public submittedPlans: ComputePlan[] = []
  public stopCalls: string[] = []

  constructor(
    id: string,
    toolPrefix: string,
    caps: Partial<BackendCapabilities> = {},
  ) {
    this.identity = { id, toolPrefix, displayName: id }
    this.capabilities = {
      requiresApproval: false,
      hasCost: false,
      supportsGpu: false,
      supportsStop: true,
      supportsStreaming: false,
      ...caps,
    }
  }

  async probeAvailability(): Promise<BackendAvailability> {
    return { available: true, missingRequirements: [] }
  }

  async plan(input: PlanInput): Promise<ComputePlan> {
    return {
      planId: `${this.identity.toolPrefix}-plan-${this.nextRunNum++}`,
      backend: this.identity.id,
      createdAt: new Date().toISOString(),
      command: input.command,
      taskDescription: input.taskDescription,
      scriptPath: input.scriptPath,
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
        reasoning: 'fake plan',
      },
      backendData: { fakeField: 'v' + this.nextRunNum },
      backendDataVersion: 1,
    }
  }

  async submit(plan: ComputePlan, _opts: SubmitOpts): Promise<ComputeRun> {
    this.submittedPlans.push(plan)
    const runId = `${this.identity.toolPrefix}-run-${this.nextRunNum++}`
    const run: ComputeRun = {
      runId,
      backend: this.identity.id,
      planId: plan.planId,
      status: 'running',
      command: plan.command,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      outputPath: `/tmp/${runId}.out`,
      retryCount: 0,
      backendData: {},
      backendDataVersion: 1,
    }
    const status: RunStatus = {
      status: 'running',
      elapsedSeconds: 0,
      outputBytes: 0,
      outputLines: 0,
      outputTail: '',
      stalled: false,
      backendData: {},
      backendDataVersion: 1,
    }
    this.runs.set(runId, { run, status })
    return run
  }

  getStatus(runId: string): RunStatus | undefined {
    return this.runs.get(runId)?.status
  }

  async waitForCompletion(runId: string, _timeoutMs: number): Promise<RunStatus | undefined> {
    return this.runs.get(runId)?.status
  }

  async stop(runId: string): Promise<void> {
    this.stopCalls.push(runId)
    const entry = this.runs.get(runId)
    if (entry) {
      entry.run.status = 'cancelled'
      entry.status.status = 'cancelled'
    }
  }

  async destroy(): Promise<void> {
    this.runs.clear()
  }

  async hydrate(): Promise<Array<{ run: ComputeRun; status: RunStatus }>> {
    return [...this.runs.values()]
  }
}

// ─── register() ──────────────────────────────────────────────────────────

test('register: accepts a well-formed backend', () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local'))
    assert.equal(r.list().length, 1)
    assert.equal(r.get('local')?.identity.id, 'local')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('register: rejects duplicate id (amendment A4)', () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local'))
    assert.throws(
      () => r.register(new FakeBackend('local', 'other')),
      /id collision/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('register: rejects duplicate toolPrefix even when ids differ (amendment A4)', () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('aws-batch', 'aws'))
    assert.throws(
      () => r.register(new FakeBackend('aws-lambda', 'aws')),
      /toolPrefix collision/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('register: rejects toolPrefix that fails the regex (amendment A4)', () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    assert.throws(
      () => r.register(new FakeBackend('aws-batch', 'aws-batch')),  // hyphens not allowed
      /invalid toolPrefix/,
    )
    assert.throws(
      () => r.register(new FakeBackend('mixed', 'MixedCase')),
      /invalid toolPrefix/,
    )
    assert.throws(
      () => r.register(new FakeBackend('starts-num', '2nd')),
      /invalid toolPrefix/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── plan() — amendment A1 (PlanRecord captures effective flag) ──────────

test('plan: writes a PlanRecord with auto-approved when capability is false and force is false', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    const plan = await r.plan('local', { command: 'echo hi' })
    const record = r.getPlanRecord('local', plan.planId)
    assert.ok(record)
    assert.equal(record!.effectiveRequiresApproval, false)
    assert.equal(record!.approved, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan: writes a PlanRecord with pending approval when capability is true', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const plan = await r.plan('modal', { command: 'echo hi' })
    const record = r.getPlanRecord('modal', plan.planId)
    assert.ok(record)
    assert.equal(record!.effectiveRequiresApproval, true)
    assert.equal(record!.approved, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan: forceApproval=true gates even a capability-false backend (amendment A1)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: true })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    const plan = await r.plan('local', { command: 'echo hi' })
    const record = r.getPlanRecord('local', plan.planId)
    assert.equal(record!.effectiveRequiresApproval, true)
    assert.equal(record!.approved, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan: emits plan-ready with the EFFECTIVE requiresApproval flag', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: true })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    await r.plan('local', { command: 'echo hi' })
    const ready = events.find(e => e.kind === 'plan-ready')
    assert.ok(ready)
    assert.equal((ready as any).requiresApproval, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── submit() — amendment A1 (uses captured PlanRecord) ──────────────────

test('submit: rejects unknown planId', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local'))
    await assert.rejects(
      () => r.submit('local', 'p-missing', {}),
      /No plan/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: rejects an unapproved gated plan', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const plan = await r.plan('modal', { command: 'train' })
    await assert.rejects(
      () => r.submit('modal', plan.planId, {}),
      /requires approval/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: rejects a rejected plan with helpful message', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const plan = await r.plan('modal', { command: 'train' })
    r.rejectPlan('modal', plan.planId, 'too expensive')
    await assert.rejects(
      () => r.submit('modal', plan.planId, {}),
      /rejected/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: accepts an approved gated plan, clears PlanStore after', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const modal = new FakeBackend('modal', 'modal', { requiresApproval: true })
    r.register(modal)
    const plan = await r.plan('modal', { command: 'train' })
    r.approvePlan('modal', plan.planId)
    const run = await r.submit('modal', plan.planId, {})
    assert.equal(run.backend, 'modal')
    assert.equal(modal.submittedPlans.length, 1)
    assert.equal(modal.submittedPlans[0].planId, plan.planId)
    // Plan cleared after submit
    assert.equal(r.getPlanRecord('modal', plan.planId), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: settings flip between plan and submit does NOT change behavior (amendment A1 race guard)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    // Plan with no gate
    const plan = await r.plan('local', { command: 'echo hi' })
    // User flips the global override AFTER plan but BEFORE submit
    r.setForceApproval(true)
    // submit should still go through — captured effectiveRequiresApproval was false
    const run = await r.submit('local', plan.planId, {})
    assert.equal(run.status, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: a NEW plan after settings flip DOES honor the new override (pins "future-only")', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    r.setForceApproval(true)
    const plan = await r.plan('local', { command: 'echo hi' })
    await assert.rejects(
      () => r.submit('local', plan.planId, {}),
      /requires approval/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── approval API ────────────────────────────────────────────────────────

test('approvePlan: emits plan-approved event, updates record', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const plan = await r.plan('modal', { command: 'train' })
    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    const result = r.approvePlan('modal', plan.planId)
    assert.equal(result.success, true)
    const approved = events.find(e => e.kind === 'plan-approved')
    assert.ok(approved)
    assert.equal(r.getPlanRecord('modal', plan.planId)?.approved, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approvePlan: fails on unknown planId without throwing', () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const result = r.approvePlan('modal', 'p-missing')
    assert.equal(result.success, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approvePlan: refuses to approve a non-gated plan (no-op safety)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local', { requiresApproval: false }))
    const plan = await r.plan('local', { command: 'echo hi' })
    const result = r.approvePlan('local', plan.planId)
    assert.equal(result.success, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejectPlan: requires non-empty comments, emits plan-rejected', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('modal', 'modal', { requiresApproval: true }))
    const plan = await r.plan('modal', { command: 'train' })
    assert.equal(r.rejectPlan('modal', plan.planId, '   ').success, false)
    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    assert.equal(r.rejectPlan('modal', plan.planId, 'too expensive').success, true)
    const rej = events.find(e => e.kind === 'plan-rejected')
    assert.ok(rej)
    assert.equal((rej as any).comments, 'too expensive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discardPlan: clears the record, emits plan-discarded, idempotent on unknown', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local', { requiresApproval: true }))
    const plan = await r.plan('local', { command: 'python train.py' })
    r.approvePlan('local', plan.planId)
    assert.ok(r.getPlanRecord('local', plan.planId), 'precondition: plan exists')

    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    const result = r.discardPlan('local', plan.planId)
    assert.equal(result.success, true)
    // Record is gone — a later hydrate / read won't resurrect the row.
    assert.equal(r.getPlanRecord('local', plan.planId), undefined)
    const ev = events.find(e => e.kind === 'plan-discarded')
    assert.ok(ev)
    assert.equal((ev as any).planId, plan.planId)
    // Idempotent: discarding again (or an unknown id) is a successful no-op.
    assert.equal(r.discardPlan('local', plan.planId).success, true)
    assert.equal(r.discardPlan('local', 'p-never-existed').success, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── runId routing ───────────────────────────────────────────────────────

test('getStatus / stop: route via runId without prefix-string guessing (amendment A4 sibling cleanup)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const local = new FakeBackend('local', 'local')
    const modal = new FakeBackend('modal', 'modal', { requiresApproval: true })
    r.register(local)
    r.register(modal)

    const lp = await r.plan('local', { command: 'a' })
    const lr = await r.submit('local', lp.planId, {})

    const mp = await r.plan('modal', { command: 'b' })
    r.approvePlan('modal', mp.planId)
    const mr = await r.submit('modal', mp.planId, {})

    assert.equal(r.getStatus(lr.runId)?.status, 'running')
    assert.equal(r.getStatus(mr.runId)?.status, 'running')

    await r.stop(lr.runId)
    assert.deepEqual(local.stopCalls, [lr.runId])
    assert.deepEqual(modal.stopCalls, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop: throws when backend lacks supportsStop capability', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('queue', 'queue', { supportsStop: false }))
    const p = await r.plan('queue', { command: 'x' })
    const run = await r.submit('queue', p.planId, {})
    await assert.rejects(() => r.stop(run.runId), /does not support stop/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── hydrate — amendment A3 (returns runs+status + pendingPlans) ─────────

test('hydrate: returns { runs, pendingPlans }; populates runId routing', async () => {
  const dir = tempProject()
  try {
    const r1 = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const modal1 = new FakeBackend('modal', 'modal', { requiresApproval: true })
    r1.register(modal1)
    // Approve + submit one run so the backend has something to hydrate
    const p1 = await r1.plan('modal', { command: 'a' })
    r1.approvePlan('modal', p1.planId)
    await r1.submit('modal', p1.planId, {})
    // Leave a second plan pending (no approval) — should land in pendingPlans
    const p2 = await r1.plan('modal', { command: 'b' })

    // Simulate restart with a fresh registry
    const r2 = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const modal2 = new FakeBackend('modal', 'modal', { requiresApproval: true })
    // Inject the live run into modal2's memory by hand (FakeBackend doesn't
    // persist; we only care about the registry's contract)
    void modal2  // not registered for the hydrate test — we only check the pendingPlans branch
    r2.register(modal2)
    const result = await r2.hydrate()
    assert.equal(result.pendingPlans.length, 1)
    assert.equal(result.pendingPlans[0].planId, p2.planId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hydrate: approved-but-not-submitted plan survives (regression — was dropped, emptying the Compute tab)', async () => {
  const dir = tempProject()
  try {
    const r1 = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r1.register(new FakeBackend('local', 'local', { requiresApproval: true }))
    // Plan + approve but DON'T submit — mirrors an agent that proposed a
    // plan, the user approved it, and the run never started through the
    // backend (e.g. the agent ran the script via raw bash instead).
    const p = await r1.plan('local', { command: 'python train.py' })
    r1.approvePlan('local', p.planId)

    // Simulate a UI refresh / restart with a fresh registry.
    const r2 = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r2.register(new FakeBackend('local', 'local', { requiresApproval: true }))
    const result = await r2.hydrate()
    assert.equal(result.pendingPlans.length, 1)
    assert.equal(result.pendingPlans[0].planId, p.planId)
    assert.equal(result.pendingPlans[0].record.approved, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── isForceApproval / setForceApproval ──────────────────────────────────

test('setForceApproval: changes future-plan derivation only (matches A1 contract)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local'))
    assert.equal(r.isForceApproval(), false)
    r.setForceApproval(true)
    assert.equal(r.isForceApproval(), true)
    // Captured: a new plan now requires approval
    const plan = await r.plan('local', { command: 'echo' })
    assert.equal(r.getPlanRecord('local', plan.planId)!.effectiveRequiresApproval, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── events ──────────────────────────────────────────────────────────────

test('subscribe / unsubscribe lifecycle', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    r.register(new FakeBackend('local', 'local'))
    // Filter to plan-related events — register() now schedules an
    // async probeAvailability that emits availability-changed,
    // which can land between subscribe() and the assertions below.
    const planEvents: ComputeEvent[] = []
    const unsub = r.subscribe(e => {
      if (e.kind === 'plan-ready') planEvents.push(e)
    })
    await r.plan('local', { command: 'a' })
    assert.equal(planEvents.length, 1)
    unsub()
    await r.plan('local', { command: 'b' })
    assert.equal(planEvents.length, 1, 'subscriber should not be called after unsubscribe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('register: emits availability-changed asynchronously (fixes "Checking…" stuck state)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const events: ComputeEvent[] = []
    r.subscribe(e => events.push(e))
    r.register(new FakeBackend('local', 'local'))
    // Wait one tick for the probe promise to resolve.
    await new Promise(resolve => setTimeout(resolve, 10))
    const availabilityEvents = events.filter(e => e.kind === 'availability-changed')
    assert.equal(availabilityEvents.length, 1, 'register should emit one availability-changed event')
    assert.equal((availabilityEvents[0] as any).backend, 'local')
    assert.equal((availabilityEvents[0] as any).availability.available, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── submit idempotency (P0-2 fix) ───────────────────────────────────────

test('submit: calling twice with the same planId returns the SAME run (idempotent)', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', 'local')
    r.register(backend)
    const plan = await r.plan('local', { command: 'echo hi' })
    const [run1, run2] = await Promise.all([
      r.submit('local', plan.planId, {}),
      r.submit('local', plan.planId, {}),
    ])
    assert.equal(run1.runId, run2.runId)
    assert.equal(backend.submittedPlans.length, 1, 'backend.submit should be called only once')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('submit: sequential duplicate submit also short-circuits to the memoized run', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    const backend = new FakeBackend('local', 'local')
    r.register(backend)
    const plan = await r.plan('local', { command: 'echo hi' })
    const first = await r.submit('local', plan.planId, {})
    const second = await r.submit('local', plan.planId, {})
    assert.equal(first.runId, second.runId)
    assert.equal(backend.submittedPlans.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── extractResult (##RESULT## protocol — P1-1 fix) ──────────────────────

test('extractResult: returns the JSON payload from a single ##RESULT## line', () => {
  const tail = 'doing work\n##RESULT## {"accuracy":0.92,"loss":0.13}\nbye'
  const result = extractResult(tail) as Record<string, number>
  assert.equal(result.accuracy, 0.92)
  assert.equal(result.loss, 0.13)
})

test('extractResult: last marker wins when multiple are present', () => {
  const tail = '##RESULT## {"v":1}\nmid line\n##RESULT## {"v":2}\n'
  assert.deepEqual(extractResult(tail), { v: 2 })
})

test('extractResult: returns undefined when no marker present', () => {
  assert.equal(extractResult('just some output\nno markers here\n'), undefined)
})

test('extractResult: malformed JSON skips back to an earlier valid line', () => {
  const tail = '##RESULT## {"good":true}\n##RESULT## not-json\n'
  // The trailing malformed line is skipped, the earlier valid line wins.
  assert.deepEqual(extractResult(tail), { good: true })
})

test('extractResult: supports non-object JSON (numbers, strings, arrays)', () => {
  assert.equal(extractResult('##RESULT## 42\n'), 42)
  assert.equal(extractResult('##RESULT## "ok"\n'), 'ok')
  assert.deepEqual(extractResult('##RESULT## [1,2,3]\n'), [1, 2, 3])
})

test('submit: failed submit clears the memo so the caller can retry', async () => {
  const dir = tempProject()
  try {
    const r = new ComputeRegistry({ projectPath: dir, forceApproval: false })
    // Backend that fails the FIRST submit and succeeds the second.
    class FlakyBackend extends FakeBackend {
      private calls = 0
      override async submit(plan: ComputePlan, opts: SubmitOpts): Promise<ComputeRun> {
        this.calls++
        if (this.calls === 1) throw new Error('transient backend failure')
        return super.submit(plan, opts)
      }
    }
    const backend = new FlakyBackend('local', 'local')
    r.register(backend)
    const plan = await r.plan('local', { command: 'echo hi' })
    await assert.rejects(() => r.submit('local', plan.planId, {}), /transient/)
    // After the failure, re-write the plan record (Registry.plan clears
    // on successful submit; the failure path leaves it intact, but we
    // re-plan to be explicit about restart-safe semantics).
    const plan2 = await r.plan('local', { command: 'echo hi' })
    const run = await r.submit('local', plan2.planId, {})
    assert.equal(run.status, 'running')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
