import type { ModalCostEstimate, ModalImageInspection } from './types.js'
import type { ModalTaskProfile } from './types.js'

interface RatesFile {
  gpuRatesUsdPerHour: Record<string, number>
  defaultGpuRate: number
  defaultCpuRate: number
}

const MODAL_RATES: RatesFile = {
  gpuRatesUsdPerHour: {
    T4: 0.59,
    A10G: 1.10,
    A100: 3.72,
    'A100-80GB': 4.28,
    H100: 8.10,
    L4: 0.80,
    CPU: 0.06,
  },
  defaultGpuRate: 1.10,
  defaultCpuRate: 0.06,
}

export function estimateCost(image: ModalImageInspection, taskProfile: Pick<ModalTaskProfile, 'expectedDurationClass'>, thresholdUsd: number): ModalCostEstimate {
  const gpuRate = image.gpuType
    ? (MODAL_RATES.gpuRatesUsdPerHour[image.gpuType] ?? MODAL_RATES.defaultGpuRate)
    : MODAL_RATES.defaultCpuRate
  const expectedDurationMinutes = taskProfile.expectedDurationClass === 'seconds'
    ? 0.5
    : taskProfile.expectedDurationClass === 'hours'
      ? 180
      : 30
  const estimatedTotalUsd = Number(((gpuRate / 60) * expectedDurationMinutes).toFixed(4))
  const notes = estimatedTotalUsd > thresholdUsd
    ? `Estimated cost exceeds the configured auto-kill threshold of $${thresholdUsd.toFixed(2)}.`
    : `Estimated cost is below the configured auto-kill threshold of $${thresholdUsd.toFixed(2)}.`

  return {
    gpuRateUsdPerHour: gpuRate,
    expectedDurationMinutes,
    estimatedTotalUsd,
    notes,
  }
}

export function computeElapsedCost(startedAt: string, gpuRateUsdPerHour: number): number {
  const elapsedMs = Math.max(0, Date.now() - new Date(startedAt).getTime())
  return Number(((elapsedMs / 3_600_000) * gpuRateUsdPerHour).toFixed(4))
}
