import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateEc2Cost, computeEc2ElapsedCost } from '../cost-estimator.js'
import type { AwsEc2InstanceSpec } from '../types.js'

function specOf(instanceType: string): AwsEc2InstanceSpec {
  return {
    instanceType,
    region: 'us-east-1',
    amiId: 'ami-test',
    keyName: 'k',
    privateKeyPath: '/tmp/k.pem',
    sshUser: 'ubuntu',
    scriptPath: 'run.sh',
  }
}

test('estimateEc2Cost: known instance type uses table rate', () => {
  const est = estimateEc2Cost(specOf('t3.medium'), { expectedDurationClass: 'minutes' }, 5)
  assert.equal(est.hourlyRateUsd, 0.0416)
  // 30 min × 0.0416 / 60 = 0.0208
  assert.ok(Math.abs(est.estimatedTotalUsd - 0.0208) < 0.001, `got ${est.estimatedTotalUsd}`)
})

test('estimateEc2Cost: unknown instance type falls back and notes it', () => {
  const est = estimateEc2Cost(specOf('z9.alien'), { expectedDurationClass: 'minutes' }, 5)
  assert.equal(est.hourlyRateUsd, 0.10)
  assert.ok(est.notes.includes('not in the local price table'), `notes=${est.notes}`)
})

test('estimateEc2Cost: notes flag when threshold exceeded', () => {
  const est = estimateEc2Cost(specOf('p4d.24xlarge'), { expectedDurationClass: 'hours' }, 5)
  // 180 min × 32.77/hr → ~98 USD, well above 5
  assert.ok(est.estimatedTotalUsd > 90, `expected >$90, got ${est.estimatedTotalUsd}`)
  assert.ok(est.notes.includes('exceeds'), `notes=${est.notes}`)
})

test('estimateEc2Cost: notes flag spot stub for non-spot fallback', () => {
  const spec = { ...specOf('t3.medium'), useSpot: true }
  const est = estimateEc2Cost(spec, { expectedDurationClass: 'minutes' }, 5)
  assert.ok(est.notes.includes('Spot pricing requested'), `notes=${est.notes}`)
})

test('computeEc2ElapsedCost: monotonic in elapsed time', () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString() // 1 min ago
  const cost = computeEc2ElapsedCost(startedAt, 6.0)            // 6/hr → 0.10/min
  assert.ok(cost >= 0.099 && cost <= 0.101, `expected ~0.10, got ${cost}`)
})
