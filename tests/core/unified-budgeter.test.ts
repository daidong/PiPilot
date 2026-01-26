/**
 * UnifiedBudgeter Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  UnifiedBudgeter,
  createBudgeterForModel,
  type BudgetDecision
} from '../../src/core/unified-budgeter.js'

describe('UnifiedBudgeter', () => {
  let budgeter: UnifiedBudgeter

  beforeEach(() => {
    budgeter = new UnifiedBudgeter({
      contextWindow: 128000,
      outputReserve: 4096
    })
  })

  describe('initialization', () => {
    it('should initialize with default values', () => {
      const b = new UnifiedBudgeter()
      const allocation = b.getAllocation()

      expect(allocation.contextWindow).toBe(128000)
      expect(allocation.outputReserve).toBe(4096)
    })

    it('should calculate correct allocation percentages', () => {
      const allocation = budgeter.getAllocation()
      const available = 128000 - 4096

      // Default: 15% system, 25% tools, 60% messages
      expect(allocation.systemBudget).toBe(Math.floor(available * 0.15))
      expect(allocation.toolsBudget).toBe(Math.floor(available * 0.25))
      expect(allocation.messagesBudget).toBe(Math.floor(available * 0.60))
    })

    it('should respect custom allocation percentages', () => {
      const custom = new UnifiedBudgeter({
        contextWindow: 100000,
        outputReserve: 5000,
        systemAllocationPct: 0.20,
        toolsAllocationPct: 0.30,
        messagesAllocationPct: 0.50
      })

      const allocation = custom.getAllocation()
      const available = 100000 - 5000

      expect(allocation.systemBudget).toBe(Math.floor(available * 0.20))
      expect(allocation.toolsBudget).toBe(Math.floor(available * 0.30))
      expect(allocation.messagesBudget).toBe(Math.floor(available * 0.50))
    })
  })

  describe('usage tracking', () => {
    it('should track system tokens', () => {
      budgeter.setSystemTokens(5000)
      expect(budgeter.getUsage().system).toBe(5000)
    })

    it('should track tools tokens', () => {
      budgeter.setToolsTokens(8000)
      expect(budgeter.getUsage().tools).toBe(8000)
    })

    it('should track messages tokens', () => {
      budgeter.setMessagesTokens(20000)
      expect(budgeter.getUsage().messages).toBe(20000)
    })

    it('should calculate total and remaining correctly', () => {
      budgeter.setSystemTokens(5000)
      budgeter.setToolsTokens(8000)
      budgeter.setMessagesTokens(20000)

      const usage = budgeter.getUsage()
      expect(usage.total).toBe(33000)
      expect(usage.remaining).toBe(budgeter.getAvailableBudget() - 33000)
    })

    it('should reset usage', () => {
      budgeter.setSystemTokens(5000)
      budgeter.setToolsTokens(8000)
      budgeter.reset()

      const usage = budgeter.getUsage()
      expect(usage.total).toBe(0)
      expect(usage.remaining).toBe(budgeter.getAvailableBudget())
    })
  })

  describe('evaluate()', () => {
    it('should return normal level when under budget', () => {
      const decision = budgeter.evaluate(5000, 10000, 30000)

      expect(decision.level).toBe('normal')
      expect(decision.canProceed).toBe(true)
      expect(decision.actions).toHaveLength(0)
      expect(decision.warning).toBeUndefined()
    })

    it('should return reduced level when near threshold', () => {
      // Default threshold is 85%
      const available = budgeter.getAvailableBudget()
      const targetUsage = Math.floor(available * 0.90) // 90% usage

      const decision = budgeter.evaluate(
        Math.floor(targetUsage * 0.15),
        Math.floor(targetUsage * 0.25),
        Math.floor(targetUsage * 0.60)
      )

      expect(decision.level).toBe('reduced')
      expect(decision.warning).toBeDefined()
    })

    it('should return minimal level when over budget', () => {
      const available = budgeter.getAvailableBudget()
      const overBudget = Math.floor(available * 1.2) // 120% usage

      const decision = budgeter.evaluate(
        Math.floor(overBudget * 0.15),
        Math.floor(overBudget * 0.25),
        Math.floor(overBudget * 0.60)
      )

      expect(decision.level).toBe('minimal')
      expect(decision.actions.length).toBeGreaterThan(0)
    })

    it('should suggest reducing messages first when over budget', () => {
      const available = budgeter.getAvailableBudget()
      const overBudget = available + 10000

      const decision = budgeter.evaluate(5000, 10000, overBudget - 15000 + 20000)

      const hasMessageReduction = decision.actions.some(
        a => a.type === 'reduce_messages'
      )
      expect(hasMessageReduction).toBe(true)
    })
  })

  describe('tool schema caching', () => {
    it('should cache tool schema token counts', () => {
      const schema = { name: 'test-tool', description: 'A test tool' }

      const tokens1 = budgeter.countToolSchemaTokens('test-tool', schema)
      const tokens2 = budgeter.countToolSchemaTokens('test-tool', schema)

      expect(tokens1).toBe(tokens2)
      expect(budgeter.getCachedToolTokens('test-tool')).toBe(tokens1)
    })

    it('should recalculate when schema changes', () => {
      const schema1 = { name: 'test-tool', description: 'Short' }
      const schema2 = { name: 'test-tool', description: 'A much longer description' }

      const tokens1 = budgeter.countToolSchemaTokens('test-tool', schema1)
      const tokens2 = budgeter.countToolSchemaTokens('test-tool', schema2)

      expect(tokens1).not.toBe(tokens2)
    })

    it('should clear tool cache', () => {
      const schema = { name: 'test-tool' }
      budgeter.countToolSchemaTokens('test-tool', schema)

      budgeter.clearToolCache()

      expect(budgeter.getCachedToolTokens('test-tool')).toBeUndefined()
    })

    it('should calculate total tool tokens', () => {
      const schemas = [
        { name: 'tool1', schema: { description: 'Tool 1' } },
        { name: 'tool2', schema: { description: 'Tool 2' } }
      ]

      const total = budgeter.calculateTotalToolTokens(schemas)
      expect(total).toBeGreaterThan(0)
    })
  })

  describe('canAfford()', () => {
    it('should return true when tokens fit', () => {
      budgeter.setSystemTokens(5000)
      expect(budgeter.canAfford(1000)).toBe(true)
    })

    it('should return false when tokens exceed remaining', () => {
      const available = budgeter.getAvailableBudget()
      budgeter.setSystemTokens(available - 100)
      expect(budgeter.canAfford(200)).toBe(false)
    })
  })

  describe('updateConfig()', () => {
    it('should update context window', () => {
      budgeter.updateConfig({ contextWindow: 200000 })

      const allocation = budgeter.getAllocation()
      expect(allocation.contextWindow).toBe(200000)
    })

    it('should recalculate allocation after config update', () => {
      const oldAllocation = budgeter.getAllocation()
      budgeter.updateConfig({ contextWindow: 200000 })
      const newAllocation = budgeter.getAllocation()

      expect(newAllocation.systemBudget).toBeGreaterThan(oldAllocation.systemBudget)
    })
  })

  describe('snapshot()', () => {
    it('should return current state snapshot', () => {
      budgeter.setSystemTokens(5000)
      budgeter.countToolSchemaTokens('test', { name: 'test' })

      const snapshot = budgeter.snapshot()

      expect(snapshot.usage.system).toBe(5000)
      expect(snapshot.cachedTools).toBe(1)
      expect(snapshot.config.contextWindow).toBe(128000)
    })
  })
})

describe('createBudgeterForModel', () => {
  it('should create budgeter with GPT-4 context window', () => {
    const b = createBudgeterForModel('gpt-4')
    expect(b.getAllocation().contextWindow).toBe(8192)
  })

  it('should create budgeter with Claude 3.5 context window', () => {
    const b = createBudgeterForModel('claude-3.5-sonnet')
    expect(b.getAllocation().contextWindow).toBe(200000)
  })

  it('should create budgeter with Claude context window', () => {
    const b = createBudgeterForModel('claude-3-sonnet')
    expect(b.getAllocation().contextWindow).toBe(200000)
  })

  it('should use default for unknown model', () => {
    const b = createBudgeterForModel('unknown-model')
    expect(b.getAllocation().contextWindow).toBe(128000)
  })
})
