import type {
  TurnConstraints,
  TurnSpec,
  YoloStage
} from './types.js'

export function buildDefaultP0Constraints(): TurnConstraints {
  return {
    maxToolCalls: 12,
    maxWallClockSec: 300,
    maxStepCount: 20,
    maxNewAssets: 6,
    maxDiscoveryOps: 20,
    maxReadBytes: 250_000,
    maxPromptTokens: 30_000,
    maxCompletionTokens: 4_000,
    maxTurnTokens: 30_000,
    maxTurnCostUsd: 2
  }
}

export function isTurnSpecValid(turnSpec: TurnSpec): boolean {
  if (!turnSpec.objective.trim()) return false
  if (!turnSpec.stage) return false
  if (!turnSpec.branch.activeBranchId || !turnSpec.branch.activeNodeId) return false

  const values = Object.values(turnSpec.constraints)
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return false

  return true
}

export function createConservativeFallbackSpec(input: {
  turnNumber: number
  stage: YoloStage
  activeBranchId: string
  activeNodeId: string
  constraints?: TurnConstraints
}): TurnSpec {
  return {
    turnNumber: input.turnNumber,
    stage: input.stage,
    branch: {
      activeBranchId: input.activeBranchId,
      activeNodeId: input.activeNodeId,
      action: 'advance'
    },
    objective: 'consolidate current state and report blockers',
    expectedAssets: ['Note'],
    constraints: input.constraints ?? buildDefaultP0Constraints()
  }
}
