import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCost, computeElapsedCost } from '../../../../modal-compute/cost-estimator.js'
import type { ModalImageInspection } from '../../../../modal-compute/types.js'

function defaultImage(gpuType: string | null): ModalImageInspection {
  return {
    source: 'script',
    baseImage: 'modal.Image.debian_slim',
    pythonVersion: '3.11',
    pythonPackages: [],
    pythonPackageInstallers: [],
    systemPackages: [],
    envVars: [],
    localDirs: [],
    localFiles: [],
    localPythonSources: [],
    buildCommands: [],
    buildFunctions: [],
    buildGpuType: null,
    runtimeGpuType: gpuType,
    gpuType,
    forceBuild: false,
    warnings: [],
    reasoning: 'test',
  }
}

test('estimateCost: known GPU types use their published rate', () => {
  const t4 = estimateCost(defaultImage('T4'), { expectedDurationClass: 'minutes' }, 5)
  assert.equal(t4.gpuRateUsdPerHour, 0.59)
  // 30 min × 0.59/hr → 0.295
  assert.ok(Math.abs(t4.estimatedTotalUsd - 0.295) < 0.001, `expected ~0.295, got ${t4.estimatedTotalUsd}`)
})

test('estimateCost: unknown GPU falls back to defaultGpuRate', () => {
  const odd = estimateCost(defaultImage('B200'), { expectedDurationClass: 'minutes' }, 5)
  // Default is 1.10 per hour; 30 min → 0.55
  assert.equal(odd.gpuRateUsdPerHour, 1.10)
})

test('estimateCost: no GPU uses defaultCpuRate', () => {
  const cpu = estimateCost(defaultImage(null), { expectedDurationClass: 'hours' }, 5)
  assert.equal(cpu.gpuRateUsdPerHour, 0.06)
  // 180 min × 0.06/hr → 0.18
  assert.ok(Math.abs(cpu.estimatedTotalUsd - 0.18) < 0.001)
})

test('estimateCost: notes reflect threshold comparison', () => {
  const cheap = estimateCost(defaultImage('T4'), { expectedDurationClass: 'seconds' }, 10)
  assert.ok(/below.*threshold/.test(cheap.notes))
  const expensive = estimateCost(defaultImage('H100'), { expectedDurationClass: 'hours' }, 1)
  assert.ok(/exceeds.*threshold/.test(expensive.notes))
})

test('estimateCost: duration class maps to fixed minute estimates', () => {
  const s = estimateCost(defaultImage('T4'), { expectedDurationClass: 'seconds' }, 5)
  const m = estimateCost(defaultImage('T4'), { expectedDurationClass: 'minutes' }, 5)
  const h = estimateCost(defaultImage('T4'), { expectedDurationClass: 'hours' }, 5)
  assert.equal(s.expectedDurationMinutes, 0.5)
  assert.equal(m.expectedDurationMinutes, 30)
  assert.equal(h.expectedDurationMinutes, 180)
})

test('computeElapsedCost: zero when startedAt is in the future', () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  assert.equal(computeElapsedCost(future, 10), 0)
})

test('computeElapsedCost: scales linearly with elapsed time and rate', () => {
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const cost = computeElapsedCost(oneHourAgo, 2)
  // ~2 dollars for 1 hour at $2/hr
  assert.ok(Math.abs(cost - 2.0) < 0.01, `expected ~2.0, got ${cost}`)
})

test('computeElapsedCost: respects the rate parameter (used for amendment A2 kill timer)', () => {
  // Pin the contract: the only rate used by the elapsed-cost
  // computation is the one passed in (hourlyRateUsd). No hidden
  // global state. Critical because Registry uses this same rate
  // to compute when to fire cost-killed.
  const t = new Date(Date.now() - 60_000).toISOString()
  const a = computeElapsedCost(t, 60)  // 1 min at $60/hr → $1
  const b = computeElapsedCost(t, 120) // 1 min at $120/hr → $2
  assert.ok(Math.abs(b - 2 * a) < 0.01)
})
