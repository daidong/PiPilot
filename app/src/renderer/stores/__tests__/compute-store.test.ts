/**
 * Tests for the compute-store reducer + RFC-017 zone selectors.
 *
 * Covers the event→store wiring that the three-zone Compute tab depends on:
 *   - run events carry campaignId + drop the matching pending plan
 *   - plan-ready carries dangerFlags (danger-confirm framing)
 *   - cron events hydrate the scheduled-task list
 *   - campaign grouping (the pure groupRunsIntoCampaigns) buckets correctly
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  useComputeStore,
  groupRunsIntoCampaigns,
  type ComputeRunView,
} from '../compute-store'

beforeEach(() => {
  useComputeStore.getState().reset()
})

function runStatus(status: string, extra: Record<string, unknown> = {}) {
  return { status, elapsedSeconds: 0, outputBytes: 0, outputLines: 0, outputTail: '', stalled: false, backendData: {}, backendDataVersion: 1, ...extra }
}

test('run-update carries campaignId into the run view', () => {
  useComputeStore.getState().applyEvent({
    kind: 'run-update', backend: 'local', runId: 'cr-1', planId: 'cr-1',
    campaignId: 'turn-42', status: runStatus('running'),
  })
  const run = useComputeStore.getState().runs.get('cr-1')
  assert.equal(run?.campaignId, 'turn-42')
  assert.equal(run?.status, 'running')
})

test('plan-ready carries dangerFlags into the pending plan', () => {
  useComputeStore.getState().applyEvent({
    kind: 'plan-ready', backend: 'local', planId: 'lp-1', requiresApproval: true,
    dangerFlags: ['Recursive force-delete (rm -rf) — can wipe directories.'],
    plan: { backend: 'local', planId: 'lp-1', command: 'rm -rf x', createdAt: new Date().toISOString() },
  })
  const plan = useComputeStore.getState().pendingPlans.get('local::lp-1')
  assert.ok(plan)
  assert.equal(plan!.requiresApproval, true)
  assert.equal(plan!.dangerFlags?.length, 1)
})

test('run-update for an approved plan drops the pending-plan card', () => {
  const s = useComputeStore.getState()
  s.applyEvent({ kind: 'plan-ready', backend: 'modal', planId: 'mp-1', requiresApproval: true,
    plan: { backend: 'modal', planId: 'mp-1', command: 'train', createdAt: new Date().toISOString() } })
  assert.equal(useComputeStore.getState().pendingPlans.size, 1)
  s.applyEvent({ kind: 'run-update', backend: 'modal', runId: 'mr-1', planId: 'mp-1', status: runStatus('running') })
  assert.equal(useComputeStore.getState().pendingPlans.size, 0, 'card dropped once the run starts')
})

test('applyCronEvent: cron-tasks hydrates the scheduled list', () => {
  useComputeStore.getState().applyCronEvent({
    kind: 'cron-tasks',
    tasks: [{ id: 'cron-1', schedule: '1h', command: 'echo hi', backend: 'local', enabled: true,
      createdAt: new Date().toISOString(), campaignId: 'camp-1', missedSinceLastOpen: 0, scheduleValid: true }],
  })
  assert.equal(useComputeStore.getState().cronTasks.size, 1)
  assert.equal(useComputeStore.getState().cronTasks.get('cron-1')?.command, 'echo hi')
})

// ── campaign grouping ───────────────────────────────────────────────────────

function run(id: string, status: string, campaignId?: string, command = 'python probe.py'): ComputeRunView {
  return {
    runId: id, backend: 'local', status, currentPhase: 'full', command, sandbox: 'process',
    weight: 'light', elapsedSeconds: 0, outputBytes: 0, outputLines: 0, stalled: false, outputTail: '',
    createdAt: new Date().toISOString(), campaignId,
  }
}

test('groupRunsIntoCampaigns: ≥2 finished members form a labeled group; running members excluded', () => {
  const campaigns = groupRunsIntoCampaigns([
    run('a', 'completed', 'sweep'),
    run('b', 'failed', 'sweep'),
    run('c', 'running', 'sweep'),   // live → Running zone, NOT here (one place per run)
  ])
  const sweep = campaigns.find(c => c.id === 'sweep')!
  assert.ok(sweep)
  assert.equal(sweep.grouped, true)
  assert.equal(sweep.completed, 1)
  assert.equal(sweep.failed, 1)
  assert.equal(sweep.total, 2, 'running member c is excluded')
  assert.equal(sweep.label, 'probe.py', 'group labeled by shared command family')
})

test('groupRunsIntoCampaigns: a single finished run renders as a bare row (not a group)', () => {
  const campaigns = groupRunsIntoCampaigns([
    run('solo', 'completed', 'turn-1'),  // lone campaign member → bare
    run('d', 'completed'),               // no campaignId → bare
    run('e', 'running'),                 // live → excluded
  ])
  assert.equal(campaigns.length, 2)
  assert.ok(campaigns.every(c => !c.grouped && c.total === 1))
  assert.ok(campaigns.find(c => c.runs[0].runId === 'solo'))
  assert.ok(campaigns.find(c => c.runs[0].runId === 'd'))
  assert.equal(campaigns.find(c => c.runs[0].runId === 'e'), undefined)
})
