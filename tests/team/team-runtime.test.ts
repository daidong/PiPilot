/**
 * Team Runtime Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  TeamRuntime,
  createTeamRuntime,
  createMockInvoker,
  createPassthroughInvoker
} from '../../src/team/team-runtime.js'
import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import { seq, par, join } from '../../src/team/flow/combinators.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// Local helpers for building AST nodes (since invoke/input are internal now)
function buildInvoke(
  agent: string,
  inputRef: InputRef,
  options?: { outputAs?: { path: string } }
): InvokeSpec {
  return {
    kind: 'invoke',
    agent,
    input: inputRef,
    outputAs: options?.outputAs
  }
}

const inputRef = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

describe('TeamRuntime', () => {
  describe('createTeamRuntime', () => {
    it('should create runtime from team definition', () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          researcher: agentHandle('researcher', { name: 'research-agent' }, { role: 'Research agent' }),
          writer: agentHandle('writer', { name: 'writer-agent' }, { role: 'Writer agent' })
        },
        flow: seq(
          buildInvoke('researcher', inputRef.initial()),
          buildInvoke('writer', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ researcher: { data: 'research' }, writer: { data: 'written' } })
      })

      expect(runtime).toBeInstanceOf(TeamRuntime)
    })
  })

  describe('createMockInvoker', () => {
    it('should return mocked responses', async () => {
      const invoker = createMockInvoker({
        'agent1': { response: 'mocked' },
        'agent2': (input) => ({ echoed: input })
      })

      const mockCtx = {} as any
      const result1 = await invoker('agent1', { input: 'test' }, mockCtx)
      expect(result1).toEqual({ response: 'mocked' })

      const result2 = await invoker('agent2', { data: 'hello' }, mockCtx)
      expect(result2).toEqual({ echoed: { data: 'hello' } })
    })

    it('should throw for unmocked agents', async () => {
      const invoker = createMockInvoker({})
      const mockCtx = {} as any

      await expect(invoker('unknown', { input: 'test' }, mockCtx)).rejects.toThrow('No mock response for agent: unknown')
    })
  })

  describe('createPassthroughInvoker', () => {
    it('should pass through input as output', async () => {
      const invoker = createPassthroughInvoker()
      const mockCtx = {} as any

      const input = { some: 'data' }
      const result = await invoker('any-agent', input, mockCtx)

      expect(result).toEqual(input)
    })
  })

  describe('run', () => {
    it('should execute team flow', async () => {
      const invocations: Array<{ agentId: string; input: unknown }> = []

      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          researcher: agentHandle('researcher', {}, { role: 'Research' }),
          writer: agentHandle('writer', {}, { role: 'Write' })
        },
        flow: seq(
          buildInvoke('researcher', inputRef.initial()),
          buildInvoke('writer', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId, agentInput) => {
          invocations.push({ agentId, input: agentInput })
          if (agentId === 'researcher') {
            return { research: 'findings' }
          }
          return { draft: 'article' }
        }
      })

      const result = await runtime.run({ topic: 'AI' })

      expect(invocations.length).toBe(2)
      expect(invocations[0].agentId).toBe('researcher')
      expect(invocations[0].input).toEqual({ topic: 'AI' })
      expect(invocations[1].agentId).toBe('writer')
      expect(invocations[1].input).toEqual({ research: 'findings' })
      expect(result.output).toEqual({ draft: 'article' })
    })

    it('should generate unique run IDs', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          echo: agentHandle('echo', {})
        },
        flow: buildInvoke('echo', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => ({ result: 'ok' })
      })

      const result1 = await runtime.run({})
      const result2 = await runtime.run({})

      expect(result1.runId).toBeDefined()
      expect(result2.runId).toBeDefined()
      expect(result1.runId).not.toBe(result2.runId)
    })

    it('should track execution time', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          slow: agentHandle('slow', {})
        },
        flow: buildInvoke('slow', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          await new Promise(r => setTimeout(r, 50))
          return { done: true }
        }
      })

      const result = await runtime.run({})

      expect(result.durationMs).toBeGreaterThanOrEqual(50)
    })

    it('should handle parallel execution', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          a: agentHandle('a', {}),
          b: agentHandle('b', {})
        },
        flow: par(
          [
            buildInvoke('a', inputRef.initial()),
            buildInvoke('b', inputRef.initial())
          ],
          join('merge')
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId) => {
          return { from: agentId }
        }
      })

      const result = await runtime.run({ data: 'test' })

      expect(result.success).toBe(true)
      expect(result.output).toMatchObject({
        from: expect.any(String)
      })
    })

    it('should provide final state in result', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        state: {
          storage: 'memory',
          namespace: 'test'
        },
        agents: {
          incrementer: agentHandle('incrementer', {})
        },
        flow: buildInvoke('incrementer', inputRef.initial(), { outputAs: { path: 'result' } })
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          return { incremented: true, value: 42 }
        }
      })

      const result = await runtime.run({})

      expect(result.finalState).toBeDefined()
    })

    it('should record trace events', async () => {
      const traceEvents: unknown[] = []

      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          agent: agentHandle('agent', {})
        },
        flow: buildInvoke('agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => ({ result: 'done' }),
        onTrace: (event) => traceEvents.push(event)
      })

      await runtime.run({})

      expect(traceEvents.length).toBeGreaterThan(0)
      expect(traceEvents.some(e => (e as any).type === 'team.start')).toBe(true)
      expect(traceEvents.some(e => (e as any).type === 'team.complete')).toBe(true)
    })
  })

  describe('error handling', () => {
    it('should return error result when agent fails', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          failing: agentHandle('failing', {})
        },
        flow: buildInvoke('failing', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          throw new Error('Agent failed')
        }
      })

      const result = await runtime.run({})

      expect(result.success).toBe(false)
      expect(result.error).toBe('Agent failed')
    })
  })

  describe('state management', () => {
    it('should allow access to runtime state', () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          agent: agentHandle('agent', {})
        },
        flow: buildInvoke('agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => ({})
      })

      expect(runtime.getState()).toBeDefined()
      expect(runtime.getAgentRegistry()).toBeDefined()
      expect(runtime.getReducerRegistry()).toBeDefined()
      expect(runtime.getTeam()).toBe(team)
    })

    it('should reset state on reset()', async () => {
      const team = defineTeam({
        id: 'test-team',
        name: 'Test Team',
        agents: {
          agent: agentHandle('agent', {})
        },
        flow: buildInvoke('agent', inputRef.initial(), { outputAs: { path: 'result' } })
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => ({ value: 42 })
      })

      await runtime.run({})
      expect(runtime.getState().has('result')).toBe(true)

      runtime.reset()
      expect(runtime.getState().has('result')).toBe(false)
    })
  })
})

describe('defineTeam', () => {
  it('should create team definition with valid input', () => {
    const team = defineTeam({
      id: 'test-team',
      name: 'Test Team',
      agents: {
        agent1: agentHandle('agent1', {})
      },
      flow: buildInvoke('agent1', inputRef.initial())
    })

    expect(team.id).toBe('test-team')
    expect(team.name).toBe('Test Team')
  })

  it('should throw without id', () => {
    expect(() => defineTeam({
      id: '',
      agents: { agent1: agentHandle('agent1', {}) },
      flow: buildInvoke('agent1', inputRef.initial())
    })).toThrow()
  })

  it('should throw without agents', () => {
    expect(() => defineTeam({
      id: 'test-team',
      agents: {},
      flow: buildInvoke('agent1', inputRef.initial())
    })).toThrow()
  })
})

describe('agentHandle', () => {
  it('should create agent handle with minimal config', () => {
    const handle = agentHandle('my-agent', { name: 'test-agent' })
    expect(handle).toMatchObject({
      id: 'my-agent',
      agent: { name: 'test-agent' }
    })
  })

  it('should create agent handle with role and capabilities', () => {
    const handle = agentHandle('my-agent', { name: 'test-agent' }, {
      role: 'Research role',
      capabilities: ['research', 'write']
    })

    expect(handle).toMatchObject({
      id: 'my-agent',
      agent: { name: 'test-agent' },
      role: 'Research role',
      capabilities: ['research', 'write']
    })
  })
})
