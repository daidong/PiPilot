/**
 * Tests for AwsEc2Backend.plan()'s handling of PlanInput.backendData.
 *
 * RFC-009 Phase 1 contract: agents pass the full instanceSpec +
 * taskProfile via compute_plan's `backend_data` JSON, which arrives at
 * the backend as PlanInput.backendData (already-parsed object). The
 * backend must:
 *   • throw with an actionable error when backendData is missing
 *   • throw with a field-specific error when a required string is empty
 *   • produce a ComputePlan with the spec embedded when input is valid
 *
 * These tests run AwsEc2Backend.plan() directly, with a mock
 * AwsCredentialProvider (provider isn't called during plan() — only
 * during submit() / probeAvailability — so a stub is sufficient).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsEc2Backend, type AwsEc2BackendPlanData } from '../aws-ec2-backend.js'
import type { ComputeContext } from '../../../context.js'

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rp-ec2-plan-'))
  mkdirSync(join(dir, '.research-pilot'), { recursive: true })
  return dir
}

function mockCtx(projectPath: string): ComputeContext {
  return {
    projectPath,
    workspacePath: projectPath,
    getCredentials: () => ({}),
    getCostThresholdUsd: () => 5,
    emit: () => { /* no-op */ },
  }
}

/**
 * AwsCredentialProvider is class-typed but plan() never calls it.
 * Cast a duck-typed object through `unknown` so we don't pull in the
 * @aws-sdk/client-sts dependency just to construct a real provider.
 */
function mockProvider(): any {
  return {
    resolve: () => { throw new Error('plan() should not call credentials') },
    validate: async () => ({ valid: false }),
    invalidate: () => { /* no-op */ },
  }
}

const VALID_SPEC = {
  instanceType: 't3.small',
  region: 'us-east-1',
  amiId: 'ami-test',
  keyName: 'k',
  privateKeyPath: '/tmp/k.pem',
  sshUser: 'ubuntu',
  scriptPath: 'run.sh',
}

test('AwsEc2Backend.plan: throws with actionable message when backendData missing', async () => {
  const projectPath = tempProject()
  try {
    const backend = new AwsEc2Backend(mockCtx(projectPath), mockProvider())
    await assert.rejects(
      () => backend.plan({ command: 'bash run.sh' }),
      (err: Error) => {
        // Must mention backend_data (the agent-visible parameter name)
        // and the expected JSON shape so the agent can self-correct.
        assert.match(err.message, /backend_data/i)
        assert.match(err.message, /instanceSpec/i)
        assert.match(err.message, /taskProfile/i)
        return true
      },
    )
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('AwsEc2Backend.plan: throws when instanceSpec is missing required field', async () => {
  const projectPath = tempProject()
  try {
    const backend = new AwsEc2Backend(mockCtx(projectPath), mockProvider())
    const { sshUser: _, ...spec } = VALID_SPEC   // omit sshUser
    await assert.rejects(
      () => backend.plan({
        command: 'bash run.sh',
        backendData: { instanceSpec: spec, taskProfile: { expectedDurationClass: 'minutes' } },
      }),
      (err: Error) => {
        assert.match(err.message, /sshUser/i, `expected error to name the missing field; got: ${err.message}`)
        return true
      },
    )
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('AwsEc2Backend.plan: reads spec from backendData and returns a usable ComputePlan', async () => {
  const projectPath = tempProject()
  try {
    const backend = new AwsEc2Backend(mockCtx(projectPath), mockProvider())
    const plan = await backend.plan({
      command: 'bash run.sh',
      taskDescription: 'smoke',
      backendData: {
        instanceSpec: VALID_SPEC,
        taskProfile: { expectedDurationClass: 'minutes' },
      },
    })

    assert.equal(plan.backend, 'aws-ec2')
    assert.equal(plan.scriptPath, 'run.sh')
    assert.equal(plan.command, 'bash run.sh')
    assert.equal(plan.taskProfile.expectedDurationClass, 'minutes')
    const data = plan.backendData as AwsEc2BackendPlanData
    assert.equal(data.instanceSpec.instanceType, 't3.small')
    assert.equal(data.instanceSpec.region, 'us-east-1')
    assert.ok(plan.costEstimate, 'cost estimate should be present (hasCost=true)')
    assert.ok(plan.costEstimate!.hourlyRateUsd > 0, 'hourly rate should be a positive number for a known instance type')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('AwsEc2Backend.plan: ignores legacy scriptContent (no longer the contract)', async () => {
  // Guards against the v1 mistake where scriptContent was overloaded
  // to mean "JSON spec". v2 routes JSON through backendData. If someone
  // accidentally passes a JSON string via scriptContent, the backend
  // should NOT try to parse it; instead it should report the missing
  // backendData with the proper error message.
  const projectPath = tempProject()
  try {
    const backend = new AwsEc2Backend(mockCtx(projectPath), mockProvider())
    await assert.rejects(
      () => backend.plan({
        command: 'bash run.sh',
        scriptContent: JSON.stringify({ instanceSpec: VALID_SPEC }),  // v1 caller pattern
      }),
      (err: Error) => {
        assert.match(err.message, /backend_data/i)
        return true
      },
    )
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})
