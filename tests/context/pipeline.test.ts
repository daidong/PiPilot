/**
 * Context Pipeline Tests
 *
 * Tests for the context assembly pipeline core functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createContextPipeline,
  createBudget,
  PHASE_PRIORITIES,
  DEFAULT_BUDGETS
} from '../../src/context/pipeline.js'
import type {
  ContextPhase,
  AssemblyContext,
  ContextFragment
} from '../../src/types/context-pipeline.js'
import type { Runtime } from '../../src/types/runtime.js'

describe('createContextPipeline', () => {
  let mockRuntime: Runtime

  beforeEach(() => {
    mockRuntime = {
      projectPath: '/test/project',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 0,
      io: {} as any,
      eventBus: {} as any,
      trace: {} as any,
      tokenBudget: {} as any,
      toolRegistry: {} as any,
      policyEngine: {} as any,
      contextManager: {} as any,
      sessionState: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        has: () => false
      }
    }
  })

  describe('phase registration', () => {
    it('should register phases', () => {
      const pipeline = createContextPipeline()

      const phase: ContextPhase = {
        id: 'test-phase',
        priority: 50,
        budget: createBudget('reserved', 1000),
        assemble: async () => []
      }

      pipeline.registerPhase(phase)

      const phases = pipeline.getPhases()
      expect(phases).toHaveLength(1)
      expect(phases[0]!.id).toBe('test-phase')
    })

    it('should sort phases by priority (descending)', () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'low-priority',
        priority: 10,
        budget: createBudget('fixed', 100),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'high-priority',
        priority: 100,
        budget: createBudget('fixed', 100),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'mid-priority',
        priority: 50,
        budget: createBudget('fixed', 100),
        assemble: async () => []
      })

      const phases = pipeline.getPhases()
      expect(phases[0]!.id).toBe('high-priority')
      expect(phases[1]!.id).toBe('mid-priority')
      expect(phases[2]!.id).toBe('low-priority')
    })

    it('should initialize with phases from config', () => {
      const phases: ContextPhase[] = [
        {
          id: 'phase1',
          priority: 100,
          budget: createBudget('reserved', 1000),
          assemble: async () => []
        },
        {
          id: 'phase2',
          priority: 50,
          budget: createBudget('remaining'),
          assemble: async () => []
        }
      ]

      const pipeline = createContextPipeline({ phases })

      expect(pipeline.getPhases()).toHaveLength(2)
    })
  })

  describe('budget allocation', () => {
    it('should allocate reserved budgets first', () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'reserved-phase',
        priority: 100,
        budget: createBudget('reserved', 2000),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'remaining-phase',
        priority: 50,
        budget: createBudget('remaining'),
        assemble: async () => []
      })

      const allocations = pipeline.calculateAllocations(10000)

      expect(allocations.get('reserved-phase')).toBe(2000)
      expect(allocations.get('remaining-phase')).toBe(8000)
    })

    it('should allocate percentage budgets', () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'reserved-phase',
        priority: 100,
        budget: createBudget('reserved', 2000),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'percentage-phase',
        priority: 80,
        budget: createBudget('percentage', 50),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'remaining-phase',
        priority: 50,
        budget: createBudget('remaining'),
        assemble: async () => []
      })

      const allocations = pipeline.calculateAllocations(10000)

      // Reserved: 2000, Remaining: 8000
      // Percentage: 50% of 8000 = 4000
      // Remaining: 8000 - 4000 = 4000
      expect(allocations.get('reserved-phase')).toBe(2000)
      expect(allocations.get('percentage-phase')).toBe(4000)
      expect(allocations.get('remaining-phase')).toBe(4000)
    })

    it('should allocate fixed budgets', () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'fixed-phase',
        priority: 100,
        budget: createBudget('fixed', 500),
        assemble: async () => []
      })

      const allocations = pipeline.calculateAllocations(10000)

      expect(allocations.get('fixed-phase')).toBe(500)
    })

    it('should handle multiple remaining phases', () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'remaining1',
        priority: 50,
        budget: createBudget('remaining'),
        assemble: async () => []
      })

      pipeline.registerPhase({
        id: 'remaining2',
        priority: 40,
        budget: createBudget('remaining'),
        assemble: async () => []
      })

      const allocations = pipeline.calculateAllocations(10000)

      // Should split evenly
      expect(allocations.get('remaining1')).toBe(5000)
      expect(allocations.get('remaining2')).toBe(5000)
    })
  })

  describe('context assembly', () => {
    it('should assemble context from all phases', async () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'phase1',
        priority: 100,
        budget: createBudget('reserved', 1000),
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'phase1',
          content: 'Content from phase 1',
          tokens: 10
        }]
      })

      pipeline.registerPhase({
        id: 'phase2',
        priority: 50,
        budget: createBudget('remaining'),
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'phase2',
          content: 'Content from phase 2',
          tokens: 10
        }]
      })

      const result = await pipeline.assemble({
        runtime: mockRuntime,
        totalBudget: 10000
      })

      expect(result.phases).toHaveLength(2)
      expect(result.content).toContain('Content from phase 1')
      expect(result.content).toContain('Content from phase 2')
    })

    it('should skip disabled phases', async () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'enabled-phase',
        priority: 100,
        budget: createBudget('reserved', 1000),
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'enabled',
          content: 'Enabled content',
          tokens: 10
        }]
      })

      pipeline.registerPhase({
        id: 'disabled-phase',
        priority: 50,
        budget: createBudget('remaining'),
        enabled: () => false,
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'disabled',
          content: 'Disabled content',
          tokens: 10
        }]
      })

      const result = await pipeline.assemble({
        runtime: mockRuntime,
        totalBudget: 10000
      })

      expect(result.content).toContain('Enabled content')
      expect(result.content).not.toContain('Disabled content')
    })

    it('should truncate fragments that exceed budget', async () => {
      const pipeline = createContextPipeline()

      // A very small budget
      pipeline.registerPhase({
        id: 'large-phase',
        priority: 100,
        budget: createBudget('fixed', 50), // Only 50 tokens allowed
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'large',
          content: 'A'.repeat(500), // ~167 tokens
          tokens: 167
        }]
      })

      const result = await pipeline.assemble({
        runtime: mockRuntime,
        totalBudget: 100
      })

      // Should be truncated
      const phase = result.phases.find(p => p.phaseId === 'large-phase')
      expect(phase!.tokens).toBeLessThanOrEqual(50)
    })

    it('should handle phase errors gracefully', async () => {
      const pipeline = createContextPipeline()

      pipeline.registerPhase({
        id: 'good-phase',
        priority: 100,
        budget: createBudget('reserved', 1000),
        assemble: async (): Promise<ContextFragment[]> => [{
          source: 'good',
          content: 'Good content',
          tokens: 10
        }]
      })

      pipeline.registerPhase({
        id: 'bad-phase',
        priority: 50,
        budget: createBudget('remaining'),
        assemble: async () => {
          throw new Error('Phase failed')
        }
      })

      const result = await pipeline.assemble({
        runtime: mockRuntime,
        totalBudget: 10000
      })

      // Should still have the good phase
      expect(result.content).toContain('Good content')
      // Bad phase should have empty fragments
      const badPhase = result.phases.find(p => p.phaseId === 'bad-phase')
      expect(badPhase!.fragments).toHaveLength(0)
    })

    it('should pass selected context to phases', async () => {
      const pipeline = createContextPipeline()
      let receivedContext: AssemblyContext | undefined

      pipeline.registerPhase({
        id: 'selected-phase',
        priority: 100,
        budget: createBudget('reserved', 1000),
        assemble: async (ctx): Promise<ContextFragment[]> => {
          receivedContext = ctx
          return []
        }
      })

      await pipeline.assemble({
        runtime: mockRuntime,
        totalBudget: 10000,
        selectedContext: [
          { type: 'file', ref: './test.ts' }
        ]
      })

      expect(receivedContext!.selectedContext).toHaveLength(1)
      expect(receivedContext!.selectedContext![0]!.type).toBe('file')
    })
  })

  describe('createBudget helper', () => {
    it('should create reserved budget', () => {
      const budget = createBudget('reserved', 2000)
      expect(budget.type).toBe('reserved')
      expect(budget.tokens).toBe(2000)
    })

    it('should create percentage budget', () => {
      const budget = createBudget('percentage', 30)
      expect(budget.type).toBe('percentage')
      expect(budget.value).toBe(30)
    })

    it('should create remaining budget', () => {
      const budget = createBudget('remaining')
      expect(budget.type).toBe('remaining')
    })

    it('should create fixed budget', () => {
      const budget = createBudget('fixed', 500)
      expect(budget.type).toBe('fixed')
      expect(budget.tokens).toBe(500)
    })
  })

  describe('constants', () => {
    it('should have correct phase priorities', () => {
      expect(PHASE_PRIORITIES.system).toBe(100)
      expect(PHASE_PRIORITIES.pinned).toBe(90)
      expect(PHASE_PRIORITIES.selected).toBe(80)
      expect(PHASE_PRIORITIES.session).toBe(50)
      expect(PHASE_PRIORITIES.index).toBe(30)
    })

    it('should have correct default budgets', () => {
      expect(DEFAULT_BUDGETS.system.type).toBe('reserved')
      expect(DEFAULT_BUDGETS.system.tokens).toBe(2000)
      expect(DEFAULT_BUDGETS.pinned.type).toBe('reserved')
      expect(DEFAULT_BUDGETS.selected.type).toBe('percentage')
      expect(DEFAULT_BUDGETS.session.type).toBe('remaining')
      expect(DEFAULT_BUDGETS.index.type).toBe('fixed')
    })
  })
})
