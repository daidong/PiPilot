import type { V2BudgetPlanInput, V2BudgetPlanResult } from './types.js'

export class BudgetPlannerV2 {
  plan(input: V2BudgetPlanInput): V2BudgetPlanResult {
    const degradedZones: string[] = []

    const requiredBase = input.outputReserve + input.fixedTokens + input.requiredTokens.taskAnchor
    const requiredWithProtected = requiredBase + input.requiredTokens.protectedTurns

    let failSafeMode = false
    let protectedTurnsTarget = input.requiredTokens.protectedTurns

    if (requiredWithProtected > input.contextWindow) {
      // Fail-safe: keep at least one protected turn worth of tokens.
      failSafeMode = true
      protectedTurnsTarget = Math.max(1, Math.floor(input.requiredTokens.protectedTurns / 2))
      if (requiredBase + protectedTurnsTarget > input.contextWindow) {
        protectedTurnsTarget = 1
      }
      degradedZones.push('protected-turns(failsafe)')
    }

    const requiredFinal = requiredBase + protectedTurnsTarget
    const availableOptional = Math.max(0, input.contextWindow - requiredFinal)

    // Allocate in priority order (least degradable first):
    // non-protected turns > memory > evidence > optional expansion.
    let remaining = availableOptional
    const allocNonProtected = Math.min(input.desiredOptionalTokens.nonProtectedTurns, remaining)
    remaining -= allocNonProtected

    const allocMemory = Math.min(input.desiredOptionalTokens.memoryCards, remaining)
    remaining -= allocMemory

    const allocEvidence = Math.min(input.desiredOptionalTokens.evidenceCards, remaining)
    remaining -= allocEvidence

    const allocExpansion = Math.min(input.desiredOptionalTokens.optionalExpansion, remaining)

    if (allocExpansion < input.desiredOptionalTokens.optionalExpansion) {
      degradedZones.push('optional-expansion')
    }
    if (allocEvidence < input.desiredOptionalTokens.evidenceCards) {
      degradedZones.push('evidence-cards')
    }
    if (allocMemory < input.desiredOptionalTokens.memoryCards) {
      degradedZones.push('memory-cards')
    }
    if (allocNonProtected < input.desiredOptionalTokens.nonProtectedTurns) {
      degradedZones.push('non-protected-turns')
    }

    return {
      failSafeMode,
      protectedTurnsTarget,
      allocations: {
        memoryCards: allocMemory,
        evidenceCards: allocEvidence,
        nonProtectedTurns: allocNonProtected,
        optionalExpansion: allocExpansion
      },
      degradedZones
    }
  }
}
