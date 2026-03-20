/**
 * definePolicy Factory Tests
 */

import { describe, it, expect } from 'vitest'
import {
  definePolicy,
  defineGuardPolicy,
  defineDenyPolicy,
  defineApprovalPolicy,
  defineMutatePolicy,
  defineObservePolicy,
  defineAuditPolicy,
  defineAlertPolicy
} from '../../src/factories/define-policy.js'
import type { PolicyContext } from '../../src/types/policy.js'

// Helper: minimal policy context
function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: 'read',
    input: { path: '/test/file.txt' },
    agentId: 'test-agent',
    sessionId: 'test-session',
    step: 1,
    ...overrides
  }
}

describe('definePolicy', () => {
  it('should create a valid policy with all fields', () => {
    const policy = definePolicy({
      id: 'test-policy',
      description: 'A test policy',
      priority: 50,
      phase: 'guard',
      match: () => true,
      decide: () => ({ action: 'allow' })
    })

    expect(policy.id).toBe('test-policy')
    expect(policy.description).toBe('A test policy')
    expect(policy.priority).toBe(50)
    expect(policy.phase).toBe('guard')
    expect(typeof policy.match).toBe('function')
    expect(typeof policy.decide).toBe('function')
  })

  it('should default priority to 100', () => {
    const policy = definePolicy({
      id: 'default-priority',
      phase: 'guard',
      match: () => true,
      decide: () => ({ action: 'allow' })
    })

    expect(policy.priority).toBe(100)
  })

  it('should throw when id is missing', () => {
    expect(() => definePolicy({
      id: '',
      phase: 'guard',
      match: () => true,
      decide: () => ({ action: 'allow' })
    })).toThrow('Policy id is required')
  })

  it('should throw when phase is missing', () => {
    expect(() => definePolicy({
      id: 'test',
      phase: '' as any,
      match: () => true,
      decide: () => ({ action: 'allow' })
    })).toThrow('Policy phase is required')
  })

  it('should throw on invalid phase', () => {
    expect(() => definePolicy({
      id: 'test',
      phase: 'invalid' as any,
      match: () => true,
      decide: () => ({ action: 'allow' })
    })).toThrow('Invalid policy phase: invalid')
  })

  it('should throw when match is missing', () => {
    expect(() => definePolicy({
      id: 'test',
      phase: 'guard',
      match: undefined as any,
      decide: () => ({ action: 'allow' })
    })).toThrow('Policy match function is required')
  })

  it('should throw when decide is missing', () => {
    expect(() => definePolicy({
      id: 'test',
      phase: 'guard',
      match: () => true,
      decide: undefined as any
    })).toThrow('Policy decide function is required')
  })

  it('should accept all three valid phases', () => {
    for (const phase of ['guard', 'mutate', 'observe'] as const) {
      const policy = definePolicy({
        id: `${phase}-policy`,
        phase,
        match: () => true,
        decide: () => ({ action: 'allow' })
      })
      expect(policy.phase).toBe(phase)
    }
  })
})

describe('defineGuardPolicy', () => {
  it('should create a guard phase policy', () => {
    const policy = defineGuardPolicy({
      id: 'guard-test',
      match: () => true,
      decide: () => ({ action: 'allow' })
    })

    expect(policy.phase).toBe('guard')
    expect(policy.id).toBe('guard-test')
  })

  it('should execute decide function correctly', async () => {
    const policy = defineGuardPolicy({
      id: 'guard-decide',
      match: (ctx) => ctx.tool === 'write',
      decide: () => ({ action: 'deny', reason: 'Read-only mode' })
    })

    expect(policy.match(makeContext({ tool: 'write' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'read' }))).toBe(false)

    const decision = await policy.decide(makeContext({ tool: 'write' }))
    expect(decision).toEqual({ action: 'deny', reason: 'Read-only mode' })
  })

  it('should forward description and priority', () => {
    const policy = defineGuardPolicy({
      id: 'guard-full',
      description: 'Full guard',
      priority: 10,
      match: () => true,
      decide: () => ({ action: 'allow' })
    })

    expect(policy.description).toBe('Full guard')
    expect(policy.priority).toBe(10)
  })
})

describe('defineDenyPolicy', () => {
  it('should create a deny-all policy with a string reason', async () => {
    const policy = defineDenyPolicy({
      id: 'deny-all',
      match: () => true,
      reason: 'Operation not permitted'
    })

    expect(policy.phase).toBe('guard')
    const decision = await policy.decide(makeContext())
    expect(decision).toEqual({ action: 'deny', reason: 'Operation not permitted' })
  })

  it('should create a deny policy with a function reason', async () => {
    const policy = defineDenyPolicy({
      id: 'deny-dynamic',
      match: () => true,
      reason: (ctx) => `Tool ${ctx.tool} is blocked`
    })

    const decision = await policy.decide(makeContext({ tool: 'bash' }))
    expect(decision).toEqual({ action: 'deny', reason: 'Tool bash is blocked' })
  })

  it('should respect the match function', () => {
    const policy = defineDenyPolicy({
      id: 'deny-bash',
      match: (ctx) => ctx.tool === 'bash',
      reason: 'No shell access'
    })

    expect(policy.match(makeContext({ tool: 'bash' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'read' }))).toBe(false)
  })
})

describe('defineApprovalPolicy', () => {
  it('should create a require_approval policy with string message', async () => {
    const policy = defineApprovalPolicy({
      id: 'approval-write',
      match: (ctx) => ctx.tool === 'write',
      message: 'Confirm write operation'
    })

    expect(policy.phase).toBe('guard')

    const decision = await policy.decide(makeContext({ tool: 'write' }))
    expect(decision).toEqual({
      action: 'require_approval',
      message: 'Confirm write operation',
      timeout: undefined
    })
  })

  it('should create a require_approval policy with function message', async () => {
    const policy = defineApprovalPolicy({
      id: 'approval-dynamic',
      match: () => true,
      message: (ctx) => `Approve ${ctx.tool}?`
    })

    const decision = await policy.decide(makeContext({ tool: 'bash' }))
    expect(decision).toEqual({
      action: 'require_approval',
      message: 'Approve bash?',
      timeout: undefined
    })
  })

  it('should include timeout when specified', async () => {
    const policy = defineApprovalPolicy({
      id: 'approval-timeout',
      match: () => true,
      message: 'Approve?',
      timeout: 30000
    })

    const decision = await policy.decide(makeContext())
    expect(decision).toEqual({
      action: 'require_approval',
      message: 'Approve?',
      timeout: 30000
    })
  })
})

describe('defineMutatePolicy', () => {
  it('should create a mutate phase policy with static transforms', async () => {
    const policy = defineMutatePolicy({
      id: 'mutate-encoding',
      match: () => true,
      transforms: [
        { op: 'set', path: 'encoding', value: 'utf-8' }
      ]
    })

    expect(policy.phase).toBe('mutate')

    const decision = await policy.decide(makeContext())
    expect(decision).toEqual({
      action: 'transform',
      transforms: [{ op: 'set', path: 'encoding', value: 'utf-8' }]
    })
  })

  it('should create a mutate policy with dynamic transforms', async () => {
    const policy = defineMutatePolicy({
      id: 'mutate-dynamic',
      match: () => true,
      transforms: (ctx) => [
        { op: 'set', path: 'tool', value: ctx.tool }
      ]
    })

    const decision = await policy.decide(makeContext({ tool: 'grep' }))
    expect(decision).toEqual({
      action: 'transform',
      transforms: [{ op: 'set', path: 'tool', value: 'grep' }]
    })
  })

  it('should support multiple transforms', async () => {
    const policy = defineMutatePolicy({
      id: 'mutate-multi',
      match: () => true,
      transforms: [
        { op: 'set', path: 'limit', value: 100 },
        { op: 'delete', path: 'debug' },
        { op: 'clamp', path: 'timeout', min: 1000, max: 30000 }
      ]
    })

    const decision = await policy.decide(makeContext())
    expect((decision as any).transforms).toHaveLength(3)
  })
})

describe('defineObservePolicy', () => {
  it('should create an observe phase policy', async () => {
    const policy = defineObservePolicy({
      id: 'observe-test',
      match: () => true,
      decide: () => ({ action: 'observe' })
    })

    expect(policy.phase).toBe('observe')

    const decision = await policy.decide(makeContext())
    expect(decision).toEqual({ action: 'observe' })
  })

  it('should support recording data', async () => {
    const policy = defineObservePolicy({
      id: 'observe-record',
      match: () => true,
      decide: (ctx) => ({
        action: 'observe',
        record: { tool: ctx.tool, step: ctx.step }
      })
    })

    const decision = await policy.decide(makeContext({ tool: 'write', step: 5 }))
    expect(decision).toEqual({
      action: 'observe',
      record: { tool: 'write', step: 5 }
    })
  })

  it('should support emitting events', async () => {
    const policy = defineObservePolicy({
      id: 'observe-emit',
      match: () => true,
      decide: () => ({
        action: 'observe',
        emit: [{ event: 'tool.used', data: { tool: 'read' } }]
      })
    })

    const decision = await policy.decide(makeContext())
    expect((decision as any).emit).toHaveLength(1)
  })
})

describe('defineAuditPolicy', () => {
  it('should create an observe policy that records to trace', async () => {
    const policy = defineAuditPolicy({
      id: 'audit-test',
      record: (ctx) => ({
        tool: ctx.tool,
        agent: ctx.agentId,
        timestamp: Date.now()
      })
    })

    expect(policy.phase).toBe('observe')

    const decision = await policy.decide(makeContext())
    const record = (decision as any).record
    expect(record.tool).toBe('read')
    expect(record.agent).toBe('test-agent')
    expect(typeof record.timestamp).toBe('number')
  })

  it('should match all tools by default', () => {
    const policy = defineAuditPolicy({
      id: 'audit-all',
      record: () => ({})
    })

    expect(policy.match(makeContext({ tool: 'read' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'write' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'bash' }))).toBe(true)
  })

  it('should respect custom match function', () => {
    const policy = defineAuditPolicy({
      id: 'audit-write-only',
      match: (ctx) => ctx.tool === 'write',
      record: (ctx) => ({ tool: ctx.tool })
    })

    expect(policy.match(makeContext({ tool: 'write' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'read' }))).toBe(false)
  })
})

describe('defineAlertPolicy', () => {
  it('should create an alert at info level', async () => {
    const policy = defineAlertPolicy({
      id: 'alert-info',
      match: () => true,
      level: 'info',
      message: 'Tool was used'
    })

    expect(policy.phase).toBe('observe')

    const decision = await policy.decide(makeContext())
    expect((decision as any).alert).toEqual({
      level: 'info',
      message: 'Tool was used'
    })
  })

  it('should create an alert at warn level', async () => {
    const policy = defineAlertPolicy({
      id: 'alert-warn',
      match: () => true,
      level: 'warn',
      message: 'Elevated operation'
    })

    const decision = await policy.decide(makeContext())
    expect((decision as any).alert.level).toBe('warn')
  })

  it('should create an alert at error level', async () => {
    const policy = defineAlertPolicy({
      id: 'alert-error',
      match: () => true,
      level: 'error',
      message: 'Critical operation detected'
    })

    const decision = await policy.decide(makeContext())
    expect((decision as any).alert.level).toBe('error')
  })

  it('should support dynamic message from function', async () => {
    const policy = defineAlertPolicy({
      id: 'alert-dynamic',
      match: () => true,
      level: 'warn',
      message: (ctx) => `Agent ${ctx.agentId} used ${ctx.tool}`
    })

    const decision = await policy.decide(makeContext({ tool: 'bash', agentId: 'agent-1' }))
    expect((decision as any).alert.message).toBe('Agent agent-1 used bash')
  })

  it('should respect match function', () => {
    const policy = defineAlertPolicy({
      id: 'alert-bash-only',
      match: (ctx) => ctx.tool === 'bash',
      level: 'error',
      message: 'Shell access detected'
    })

    expect(policy.match(makeContext({ tool: 'bash' }))).toBe(true)
    expect(policy.match(makeContext({ tool: 'read' }))).toBe(false)
  })
})
