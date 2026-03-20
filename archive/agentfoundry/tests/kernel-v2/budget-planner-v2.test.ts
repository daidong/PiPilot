import { describe, expect, it } from 'vitest'

import { BudgetPlannerV2 } from '../../src/kernel-v2/budget-planner-v2.js'

describe('BudgetPlannerV2', () => {
  it('degrades optional zones in RFC-011 order', () => {
    const planner = new BudgetPlannerV2()

    const result = planner.plan({
      contextWindow: 1000,
      outputReserve: 200,
      fixedTokens: 200,
      requiredTokens: {
        protectedTurns: 200,
        taskAnchor: 100
      },
      desiredOptionalTokens: {
        memoryCards: 180,
        evidenceCards: 120,
        nonProtectedTurns: 200,
        optionalExpansion: 120
      }
    })

    // Optional budget available: 300 tokens.
    // non-protected takes first (200), then memory gets 100.
    expect(result.allocations.nonProtectedTurns).toBe(200)
    expect(result.allocations.memoryCards).toBe(100)
    expect(result.allocations.evidenceCards).toBe(0)
    expect(result.allocations.optionalExpansion).toBe(0)

    expect(result.degradedZones).toContain('optional-expansion')
    expect(result.degradedZones).toContain('evidence-cards')
    expect(result.degradedZones).toContain('memory-cards')
    expect(result.degradedZones).not.toContain('non-protected-turns')
  })

  it('enters failsafe when required tokens cannot fit', () => {
    const planner = new BudgetPlannerV2()

    const result = planner.plan({
      contextWindow: 600,
      outputReserve: 250,
      fixedTokens: 220,
      requiredTokens: {
        protectedTurns: 200,
        taskAnchor: 150
      },
      desiredOptionalTokens: {
        memoryCards: 100,
        evidenceCards: 100,
        nonProtectedTurns: 100,
        optionalExpansion: 100
      }
    })

    expect(result.failSafeMode).toBe(true)
    expect(result.protectedTurnsTarget).toBeGreaterThan(0)
    expect(result.degradedZones).toContain('protected-turns(failsafe)')
  })
})
