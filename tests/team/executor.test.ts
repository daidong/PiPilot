/**
 * Flow Executor Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { executeFlow } from '../../src/team/flow/executor.js'
import { createReducerRegistry } from '../../src/team/flow/reducers.js'
import { createBlackboard } from '../../src/team/state/blackboard.js'
import { createAgentRegistry } from '../../src/team/agent-registry.js'
import {
  invoke,
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  input,
  pred,
  until,
  join
} from '../../src/team/flow/combinators.js'
import type { ExecutionContext, AgentInvoker } from '../../src/team/flow/executor.js'

describe('Flow Executor', () => {
  let ctx: ExecutionContext
  let invokedAgents: Array<{ agentId: string; input: unknown }>

  const createMockInvoker = (): AgentInvoker => async (agentId, invokeInput) => {
    invokedAgents.push({ agentId, input: invokeInput })

    // Mock responses based on agent ID
    switch (agentId) {
      case 'researcher':
        return { research: 'findings about AI' }
      case 'writer':
        return { draft: 'Article about AI' }
      case 'reviewer':
        return { approved: true, feedback: 'Looks good' }
      case 'critic':
        return { approved: false, feedback: 'Needs work' }
      case 'refiner':
        const iteration = invokedAgents.filter(i => i.agentId === 'refiner').length
        return { content: `refined-${iteration}`, done: iteration >= 2 }
      case 'processor':
        return { processed: invokeInput }
      case 'fast':
        return { winner: 'fast' }
      case 'slow':
        await new Promise(r => setTimeout(r, 100))
        return { winner: 'slow' }
      default:
        return { agentId, received: invokeInput }
    }
  }

  beforeEach(() => {
    invokedAgents = []
    ctx = {
      runId: 'run-001',
      step: 0,
      concurrency: 10,
      agentRegistry: createAgentRegistry({ teamId: 'test-team', agents: {} }),
      reducerRegistry: createReducerRegistry(),
      state: createBlackboard({ storage: 'memory', namespace: 'test' }),
      invokeAgent: createMockInvoker(),
      trace: { record: () => {} },
      initialInput: { topic: 'AI Safety' },
      prevOutput: undefined
    }
  })

  describe('invoke', () => {
    it('should invoke agent with initial input', async () => {
      const spec = invoke('researcher', input.initial())
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0]).toEqual({
        agentId: 'researcher',
        input: { topic: 'AI Safety' }
      })
      expect(result.success).toBe(true)
      expect(result.output).toEqual({ research: 'findings about AI' })
    })

    it('should invoke agent with const input', async () => {
      const spec = invoke('researcher', input.const({ custom: 'data' }))
      await executeFlow(spec, ctx)

      expect(invokedAgents[0].input).toEqual({ custom: 'data' })
    })

    it('should invoke agent with state input', async () => {
      ctx.state.put('myData', { key: 'value' })
      const spec = invoke('researcher', input.state('myData'))
      await executeFlow(spec, ctx)

      expect(invokedAgents[0].input).toEqual({ key: 'value' })
    })

    it('should write output to state when outputAs specified', async () => {
      const spec = invoke('researcher', input.initial(), { outputAs: { path: 'research_result' } })
      await executeFlow(spec, ctx)

      expect(ctx.state.get('research_result')).toEqual({ research: 'findings about AI' })
    })
  })

  describe('seq', () => {
    it('should execute steps sequentially', async () => {
      const spec = seq(
        invoke('researcher', input.initial()),
        invoke('writer', input.prev())
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(2)
      expect(invokedAgents[0].agentId).toBe('researcher')
      expect(invokedAgents[1].agentId).toBe('writer')
      expect(invokedAgents[1].input).toEqual({ research: 'findings about AI' })
      expect(result.success).toBe(true)
      expect(result.output).toEqual({ draft: 'Article about AI' })
    })

    it('should chain multiple steps', async () => {
      const spec = seq(
        invoke('researcher', input.initial()),
        invoke('writer', input.prev()),
        invoke('reviewer', input.prev())
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(3)
      expect(result.success).toBe(true)
      expect(result.output).toEqual({ approved: true, feedback: 'Looks good' })
    })
  })

  describe('par', () => {
    it('should execute branches in parallel', async () => {
      const spec = par(
        [
          invoke('researcher', input.initial()),
          invoke('writer', input.initial())
        ],
        join('merge')
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(2)
      expect(result.success).toBe(true)
      expect(result.output).toMatchObject({
        research: 'findings about AI',
        draft: 'Article about AI'
      })
    })

    it('should use specified reducer', async () => {
      const spec = par(
        [
          invoke('researcher', input.initial()),
          invoke('writer', input.initial())
        ],
        join('collect')
      )
      const result = await executeFlow(spec, ctx)

      expect(Array.isArray(result.output)).toBe(true)
      expect((result.output as unknown[]).length).toBe(2)
    })
  })

  describe('map', () => {
    it('should map over array items', async () => {
      ctx.state.put('items', ['a', 'b', 'c'])

      const spec = map(
        { ref: 'state', path: 'items' },
        invoke('processor', input.prev()),
        join('collect')
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(3)
      expect(result.success).toBe(true)
      expect(Array.isArray(result.output)).toBe(true)
    })
  })

  describe('choose', () => {
    it('should select branch based on rule router', async () => {
      ctx.state.put('type', 'research')

      const spec = choose(
        {
          type: 'rule',
          rules: [
            { when: pred.eq('type', 'research'), route: 'researchBranch' },
            { when: pred.eq('type', 'writing'), route: 'writeBranch' }
          ]
        },
        {
          'researchBranch': invoke('researcher', input.initial()),
          'writeBranch': invoke('writer', input.initial())
        }
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('researcher')
    })

    it('should use default branch when no match', async () => {
      ctx.state.put('type', 'unknown')

      const spec = choose(
        {
          type: 'rule',
          rules: [
            { when: pred.eq('type', 'research'), route: 'researchBranch' }
          ]
        },
        {
          'researchBranch': invoke('researcher', input.initial()),
          'default': invoke('writer', input.initial())
        },
        { defaultBranch: 'default' }
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents[0].agentId).toBe('writer')
    })
  })

  describe('loop', () => {
    it('should loop until condition met', async () => {
      // refiner returns { done: true } after 2 iterations
      const spec = loop(
        invoke('refiner', input.prev()),
        until.predicate(pred.eq('done', true)),
        { maxIters: 10 }
      )

      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.filter(i => i.agentId === 'refiner').length).toBe(2)
      expect(result.success).toBe(true)
    })

    it('should respect maxIters', async () => {
      // Mock a never-ending loop that tracks invocations
      const loopInvocations: number[] = []
      ctx.invokeAgent = async () => {
        loopInvocations.push(loopInvocations.length + 1)
        return { done: false }
      }

      const spec = loop(
        invoke('endless', input.prev()),
        until.predicate(pred.eq('done', true)),
        { maxIters: 3 }
      )

      await executeFlow(spec, ctx)

      expect(loopInvocations.length).toBe(3)
    })
  })

  describe('gate', () => {
    it('should execute onPass when predicate is true', async () => {
      ctx.state.put('approved', true)

      const spec = gate(
        { type: 'predicate', predicate: pred.eq('approved', true) },
        invoke('researcher', input.initial()),
        invoke('notifier', input.initial())
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('researcher')
    })

    it('should execute onFail when predicate is false', async () => {
      ctx.state.put('approved', false)

      const spec = gate(
        { type: 'predicate', predicate: pred.eq('approved', true) },
        invoke('researcher', input.initial()),
        invoke('notifier', input.initial())
      )
      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('notifier')
    })
  })

  describe('nested flows', () => {
    it('should handle nested seq inside par', async () => {
      const spec = par(
        [
          seq(
            invoke('researcher', input.initial()),
            invoke('writer', input.prev())
          ),
          invoke('reviewer', input.initial())
        ],
        join('merge')
      )

      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(3)
      expect(result.success).toBe(true)
    })

    it('should handle complex nested structure', async () => {
      ctx.state.put('mode', 'research')

      const spec = seq(
        choose(
          {
            type: 'rule',
            rules: [
              { when: pred.eq('mode', 'research'), route: 'researchBranch' }
            ]
          },
          {
            'researchBranch': invoke('researcher', input.initial()),
            'writeBranch': invoke('writer', input.initial())
          },
          { defaultBranch: 'writeBranch' }
        ),
        invoke('reviewer', input.prev())
      )

      const result = await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(2)
      expect(invokedAgents[0].agentId).toBe('researcher')
      expect(invokedAgents[1].agentId).toBe('reviewer')
    })
  })

  describe('predicate evaluation', () => {
    it('should evaluate eq predicate', async () => {
      ctx.state.put('value', 42)

      const spec = gate(
        { type: 'predicate', predicate: pred.eq('value', 42) },
        invoke('processor', input.initial()),
        invoke('fallback', input.initial())
      )
      await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('processor')
    })

    it('should evaluate and predicate', async () => {
      ctx.state.put('a', 1)
      ctx.state.put('b', 2)

      const spec = gate(
        {
          type: 'predicate',
          predicate: pred.and(
            pred.eq('a', 1),
            pred.eq('b', 2)
          )
        },
        invoke('processor', input.initial()),
        invoke('fallback', input.initial())
      )
      await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('processor')
    })

    it('should evaluate or predicate', async () => {
      ctx.state.put('a', 99)
      ctx.state.put('b', 2)

      const spec = gate(
        {
          type: 'predicate',
          predicate: pred.or(
            pred.eq('a', 1),
            pred.eq('b', 2)
          )
        },
        invoke('processor', input.initial()),
        invoke('fallback', input.initial())
      )
      await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('processor')
    })

    it('should evaluate not predicate', async () => {
      ctx.state.put('flag', false)

      const spec = gate(
        {
          type: 'predicate',
          predicate: pred.not(pred.eq('flag', true))
        },
        invoke('processor', input.initial()),
        invoke('fallback', input.initial())
      )
      await executeFlow(spec, ctx)

      expect(invokedAgents.length).toBe(1)
      expect(invokedAgents[0].agentId).toBe('processor')
    })
  })

  describe('error handling', () => {
    it('should return error result when agent fails', async () => {
      ctx.invokeAgent = async () => {
        throw new Error('Agent failed')
      }

      const spec = invoke('failing', input.initial())
      const result = await executeFlow(spec, ctx)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Agent failed')
    })
  })
})
