/**
 * EC2 cost estimator — coarse on-demand rates by instance family.
 *
 * Rates are 2026 us-east-1 on-demand pricing for the most common
 * instance types we expect a research workflow to ask for. Region- and
 * spot-pricing differences are NOT modeled; the cost-kill timer always
 * uses the conservative on-demand rate, which over-counts in spot or
 * cheaper regions — same direction of error as the Modal estimator's
 * `coverage: 'lower_bound'` calibration except inverted (we round UP to
 * be safe about kill thresholds).
 *
 * The lookup table is intentionally tiny — adding rates is a 1-line
 * change and the agent surfaces "unknown instance type" as a notes
 * string the user can investigate.
 */

import type { AwsEc2CostEstimate, AwsEc2InstanceSpec, AwsEc2TaskProfile } from './types.js'

const EC2_ON_DEMAND_USD_HR: Record<string, number> = {
  // General purpose
  't3.micro':    0.0104,
  't3.small':    0.0208,
  't3.medium':   0.0416,
  't3.large':    0.0832,
  't3.xlarge':   0.1664,
  't3.2xlarge':  0.3328,
  // Compute-optimized
  'c5.large':    0.085,
  'c5.xlarge':   0.17,
  'c5.2xlarge':  0.34,
  'c5.4xlarge':  0.68,
  // Memory-optimized
  'r5.large':    0.126,
  'r5.xlarge':   0.252,
  'r5.2xlarge':  0.504,
  // GPU
  'g4dn.xlarge': 0.526,
  'g4dn.2xlarge':0.752,
  'g5.xlarge':   1.006,
  'g5.2xlarge':  1.212,
  'g5.4xlarge':  1.624,
  'p4d.24xlarge':32.77,
  'p5.48xlarge': 98.32,
}

const DEFAULT_HOURLY_USD = 0.10 // conservative fallback for unmodeled types

export function estimateEc2Cost(
  spec: AwsEc2InstanceSpec,
  taskProfile: Pick<AwsEc2TaskProfile, 'expectedDurationClass'>,
  thresholdUsd: number,
): AwsEc2CostEstimate {
  const knownRate = EC2_ON_DEMAND_USD_HR[spec.instanceType]
  const hourlyRateUsd = knownRate ?? DEFAULT_HOURLY_USD

  const expectedDurationMinutes =
    taskProfile.expectedDurationClass === 'seconds'
      ? 1
      : taskProfile.expectedDurationClass === 'hours'
        ? 180
        : 30

  const estimatedTotalUsd = Number(((hourlyRateUsd / 60) * expectedDurationMinutes).toFixed(4))

  const noteParts: string[] = []
  if (!knownRate) {
    noteParts.push(
      `Instance type "${spec.instanceType}" is not in the local price table — using fallback $${DEFAULT_HOURLY_USD.toFixed(2)}/hr.`,
    )
  } else {
    noteParts.push(`On-demand rate $${hourlyRateUsd.toFixed(3)}/hr in us-east-1; regional variance not modeled.`)
  }
  if (spec.useSpot) {
    noteParts.push('Spot pricing requested but not yet supported in Phase 1 — running on-demand.')
  }
  noteParts.push(
    estimatedTotalUsd > thresholdUsd
      ? `Estimate exceeds the configured auto-kill threshold of $${thresholdUsd.toFixed(2)}.`
      : `Estimate is below the configured auto-kill threshold of $${thresholdUsd.toFixed(2)}.`,
  )

  return {
    instanceType: spec.instanceType,
    hourlyRateUsd,
    expectedDurationMinutes,
    estimatedTotalUsd,
    notes: noteParts.join(' '),
  }
}

export function computeEc2ElapsedCost(startedAt: string, hourlyRateUsd: number): number {
  const elapsedMs = Math.max(0, Date.now() - new Date(startedAt).getTime())
  return Number(((elapsedMs / 3_600_000) * hourlyRateUsd).toFixed(4))
}
