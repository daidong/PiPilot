/**
 * PolicyEngine 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import type { Policy, PolicyContext } from '../../src/types/policy.js'

describe('PolicyEngine', () => {
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
    trace = new TraceCollector('test-session')
    policyEngine = new PolicyEngine({ trace, eventBus })
  })

  describe('register', () => {
    it('should register guard policy', () => {
      const policy: Policy = {
        id: 'test-policy',
        description: 'A test policy',
        phase: 'guard',
        match: () => true,
        decide: () => ({ action: 'allow' })
      }

      policyEngine.register(policy)

      expect(policyEngine.getPoliciesByPhase('guard')).toHaveLength(1)
    })

    it('should register multiple policies', () => {
      policyEngine.registerAll([
        {
          id: 'policy1',
          phase: 'guard',
          match: () => true,
          decide: () => ({ action: 'allow' })
        },
        {
          id: 'policy2',
          phase: 'guard',
          match: () => true,
          decide: () => ({ action: 'allow' })
        }
      ])

      expect(policyEngine.getPoliciesByPhase('guard')).toHaveLength(2)
    })
  })

  describe('guard phase', () => {
    it('should allow when all policies allow', async () => {
      policyEngine.register({
        id: 'allow-policy',
        phase: 'guard',
        match: () => true,
        decide: () => ({ action: 'allow' })
      })

      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
    })

    it('should deny when any policy denies', async () => {
      policyEngine.registerAll([
        {
          id: 'allow-policy',
          phase: 'guard',
          match: () => true,
          decide: () => ({ action: 'allow' })
        },
        {
          id: 'deny-policy',
          phase: 'guard',
          match: () => true,
          decide: () => ({ action: 'deny', reason: 'Denied' })
        }
      ])

      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Denied')
    })

    it('should require approval when policy requires it', async () => {
      const onApprovalRequired = vi.fn().mockResolvedValue(true)

      policyEngine = new PolicyEngine({
        trace,
        eventBus,
        onApprovalRequired
      })

      policyEngine.register({
        id: 'approval-policy',
        phase: 'guard',
        match: (ctx) => ctx.tool === 'write',
        decide: () => ({ action: 'require_approval', message: 'Needs approval' })
      })

      const context: PolicyContext = {
        tool: 'write',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(onApprovalRequired).toHaveBeenCalled()
      expect(result.allowed).toBe(true) // Approved by mock
    })

    it('should deny when approval is rejected', async () => {
      const onApprovalRequired = vi.fn().mockResolvedValue(false)

      policyEngine = new PolicyEngine({
        trace,
        eventBus,
        onApprovalRequired
      })

      policyEngine.register({
        id: 'approval-policy',
        phase: 'guard',
        match: (ctx) => ctx.tool === 'write',
        decide: () => ({ action: 'require_approval', message: 'Needs approval' })
      })

      const context: PolicyContext = {
        tool: 'write',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
      expect(result.policyId).toBe('approval-policy')
    })

    it('should include policyId when approval is required but no handler is configured', async () => {
      policyEngine.register({
        id: 'approval-policy',
        phase: 'guard',
        match: (ctx) => ctx.tool === 'write',
        decide: () => ({ action: 'require_approval', message: 'Needs approval' })
      })

      const context: PolicyContext = {
        tool: 'write',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('Approval required but no handler configured')
      expect(result.policyId).toBe('approval-policy')
    })
  })

  describe('mutate phase', () => {
    it('should apply transforms', async () => {
      policyEngine.register({
        id: 'mutate-policy',
        phase: 'mutate',
        match: () => true,
        decide: () => ({
          action: 'transform',
          transforms: [
            { op: 'set', path: 'options.encoding', value: 'utf-8' }
          ]
        })
      })

      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/test/file.txt', options: {} },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect(result.allowed).toBe(true)
      expect(result.transforms).toHaveLength(1)
      expect((result.input as any)?.options?.encoding).toBe('utf-8')
    })

    it('should apply multiple transforms in order', async () => {
      policyEngine.register({
        id: 'mutate-policy',
        phase: 'mutate',
        match: () => true,
        decide: () => ({
          action: 'transform',
          transforms: [
            { op: 'set', path: 'limit', value: 100 },
            { op: 'set', path: 'caseSensitive', value: false }
          ]
        })
      })

      const context: PolicyContext = {
        tool: 'grep',
        input: { pattern: 'foo' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      const result = await policyEngine.evaluateBefore(context)

      expect((result.input as any)?.limit).toBe(100)
      expect((result.input as any)?.caseSensitive).toBe(false)
    })
  })

  describe('observe phase', () => {
    it('should call observe after evaluation', async () => {
      const observeFn = vi.fn()

      policyEngine.register({
        id: 'observe-policy',
        phase: 'observe',
        match: () => true,
        decide: (ctx) => {
          observeFn(ctx)
          return { action: 'observe' }
        }
      })

      const context: PolicyContext = {
        tool: 'read',
        input: { path: '/test/file.txt' },
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      }

      await policyEngine.evaluateAfter(context)

      expect(observeFn).toHaveBeenCalledWith(context)
    })
  })

  describe('policy priority', () => {
    it('should evaluate policies in priority order', async () => {
      const order: string[] = []

      policyEngine.registerAll([
        {
          id: 'low-priority',
          phase: 'guard',
          priority: 10,
          match: () => true,
          decide: () => {
            order.push('low')
            return { action: 'allow' }
          }
        },
        {
          id: 'high-priority',
          phase: 'guard',
          priority: 100,
          match: () => true,
          decide: () => {
            order.push('high')
            return { action: 'allow' }
          }
        },
        {
          id: 'medium-priority',
          phase: 'guard',
          priority: 50,
          match: () => true,
          decide: () => {
            order.push('medium')
            return { action: 'allow' }
          }
        }
      ])

      await policyEngine.evaluateBefore({
        tool: 'read',
        input: {},
        agentId: 'test-agent',
        sessionId: 'test-session',
        step: 1
      })

      // PolicyEngine sorts by priority ascending (lower = first)
      expect(order).toEqual(['low', 'medium', 'high'])
    })
  })

  describe('clear', () => {
    it('should clear all policies', () => {
      policyEngine.register({
        id: 'test',
        phase: 'guard',
        match: () => true,
        decide: () => ({ action: 'allow' })
      })

      expect(policyEngine.getPoliciesByPhase('guard')).toHaveLength(1)

      policyEngine.clear()

      expect(policyEngine.getPoliciesByPhase('guard')).toHaveLength(0)
    })
  })
})
