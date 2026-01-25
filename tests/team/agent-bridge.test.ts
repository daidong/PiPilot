/**
 * Agent Bridge Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AgentBridge,
  createAgentBridge,
  createMapBasedResolver,
  createFactoryResolver,
  createBridgedTeamRuntime
} from '../../src/team/agent-bridge.js'
import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import { seq, invoke, input } from '../../src/team/flow/index.js'
import type { Agent, AgentRunResult } from '../../src/types/agent.js'

// Mock agent factory
function createMockAgent(id: string, response: string): Agent {
  return {
    id,
    run: vi.fn().mockResolvedValue({
      success: true,
      output: response,
      steps: 1,
      trace: []
    } as AgentRunResult)
  } as unknown as Agent
}

describe('AgentBridge', () => {
  let team: ReturnType<typeof defineTeam>
  let mockAgent1: Agent
  let mockAgent2: Agent

  beforeEach(() => {
    mockAgent1 = createMockAgent('agent1', 'response from agent1')
    mockAgent2 = createMockAgent('agent2', 'response from agent2')

    team = defineTeam({
      id: 'test-team',
      agents: {
        agent1: agentHandle('agent1', mockAgent1),
        agent2: agentHandle('agent2', mockAgent2)
      },
      flow: seq(
        invoke('agent1', input.initial()),
        invoke('agent2', input.prev())
      )
    })
  })

  describe('createInvoker', () => {
    it('should create an invoker function', () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1
      })

      const invoker = bridge.createInvoker()
      expect(typeof invoker).toBe('function')
    })

    it('should invoke agent and return output', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1
      })

      const invoker = bridge.createInvoker()
      const result = await invoker('agent1', 'test input', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test input',
        state: {},
        trace: []
      })

      expect(result).toBe('response from agent1')
    })

    it('should track invocation count', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async (id) => id === 'agent1' ? mockAgent1 : mockAgent2
      })

      const invoker = bridge.createInvoker()
      const ctx = {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test',
        state: {},
        trace: []
      }

      await invoker('agent1', 'input1', ctx)
      await invoker('agent1', 'input2', ctx)
      await invoker('agent2', 'input3', ctx)

      expect(bridge.getInvocationCount('agent1')).toBe(2)
      expect(bridge.getInvocationCount('agent2')).toBe(1)
      expect(bridge.getInvocationCount('agent3')).toBe(0)
    })

    it('should apply input transform', async () => {
      const inputTransform = vi.fn((input: unknown) => ({ wrapped: input }))

      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1,
        inputTransform
      })

      const invoker = bridge.createInvoker()
      await invoker('agent1', 'original', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'original',
        state: {},
        trace: []
      })

      expect(inputTransform).toHaveBeenCalledWith('original', 'agent1')
    })

    it('should apply output transform', async () => {
      const outputTransform = vi.fn((output: unknown) => ({ result: output }))

      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1,
        outputTransform
      })

      const invoker = bridge.createInvoker()
      const result = await invoker('agent1', 'test', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test',
        state: {},
        trace: []
      })

      expect(outputTransform).toHaveBeenCalledWith('response from agent1', 'agent1')
      expect(result).toEqual({ result: 'response from agent1' })
    })

    it('should call error handler on failure', async () => {
      const errorHandler = vi.fn()
      const failingAgent = {
        id: 'failing',
        run: vi.fn().mockRejectedValue(new Error('Agent failed'))
      } as unknown as Agent

      const bridge = createAgentBridge({
        team: defineTeam({
          id: 'test',
          agents: { failing: agentHandle('failing', failingAgent) },
          flow: invoke('failing', input.initial())
        }),
        agentResolver: async () => failingAgent,
        onError: errorHandler
      })

      const invoker = bridge.createInvoker()

      await expect(invoker('failing', 'test', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test',
        state: {},
        trace: []
      })).rejects.toThrow('Agent failed')

      expect(errorHandler).toHaveBeenCalled()
      expect(errorHandler.mock.calls[0][0].message).toBe('Agent failed')
    })

    it('should detect handoff and call handler', async () => {
      const handoffHandler = vi.fn()
      const handoffAgent = {
        id: 'handoff-agent',
        run: vi.fn().mockResolvedValue({
          success: true,
          output: JSON.stringify({
            type: 'handoff',
            target: 'agent2',
            data: { context: 'handoff data' }
          }),
          steps: 1,
          trace: []
        })
      } as unknown as Agent

      const bridge = createAgentBridge({
        team: defineTeam({
          id: 'test',
          agents: { handoff: agentHandle('handoff', handoffAgent) },
          flow: invoke('handoff', input.initial())
        }),
        agentResolver: async () => handoffAgent,
        onHandoff: handoffHandler
      })

      const invoker = bridge.createInvoker()
      await invoker('handoff', 'test', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test',
        state: {},
        trace: []
      })

      expect(handoffHandler).toHaveBeenCalled()
      expect(handoffHandler.mock.calls[0][0].target).toBe('agent2')
    })
  })

  describe('resolveAgent', () => {
    it('should resolve agent from resolver', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1
      })

      const agent = await bridge.resolveAgent('agent1')
      // Agent should be resolved from handle directly since it's already set
      expect(agent).toBe(mockAgent1)
    })

    it('should cache resolved agents', async () => {
      const resolver = vi.fn(async () => mockAgent1)

      const bridge = createAgentBridge({
        team,
        agentResolver: resolver
      })

      await bridge.resolveAgent('agent1')
      await bridge.resolveAgent('agent1')
      await bridge.resolveAgent('agent1')

      // Since agent is in handle, resolver should not be called
      expect(resolver).not.toHaveBeenCalled()
    })

    it('should throw for unknown agent', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1
      })

      await expect(bridge.resolveAgent('unknown')).rejects.toThrow('Agent not found in team')
    })

    it('should use agent instance from handle directly', async () => {
      const directAgent = createMockAgent('direct', 'direct response')
      const teamWithDirectAgent = defineTeam({
        id: 'test',
        agents: {
          direct: agentHandle('direct', directAgent)
        },
        flow: invoke('direct', input.initial())
      })

      const resolver = vi.fn(async () => null)
      const bridge = createAgentBridge({
        team: teamWithDirectAgent,
        agentResolver: resolver
      })

      const agent = await bridge.resolveAgent('direct')
      expect(agent).toBe(directAgent)
      expect(resolver).not.toHaveBeenCalled()
    })
  })

  describe('getResolvedAgents', () => {
    it('should return all resolved agents', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async (id) => id === 'agent1' ? mockAgent1 : mockAgent2
      })

      await bridge.resolveAgent('agent1')
      await bridge.resolveAgent('agent2')

      const resolved = bridge.getResolvedAgents()
      expect(resolved.size).toBe(2)
      expect(resolved.get('agent1')).toBe(mockAgent1)
      expect(resolved.get('agent2')).toBe(mockAgent2)
    })
  })

  describe('clearCache', () => {
    it('should clear agent cache and invocation counts', async () => {
      const bridge = createAgentBridge({
        team,
        agentResolver: async () => mockAgent1
      })

      // Resolve and invoke
      const invoker = bridge.createInvoker()
      await invoker('agent1', 'test', {
        runId: 'run-1',
        prevOutput: null,
        initial: 'test',
        state: {},
        trace: []
      })

      expect(bridge.getResolvedAgents().size).toBe(1)
      expect(bridge.getInvocationCount('agent1')).toBe(1)

      bridge.clearCache()

      expect(bridge.getResolvedAgents().size).toBe(0)
      expect(bridge.getInvocationCount('agent1')).toBe(0)
    })
  })
})

describe('createMapBasedResolver', () => {
  it('should resolve from Map', async () => {
    const agent = createMockAgent('test', 'response')
    const agentMap = new Map([['test', agent]])

    const resolver = createMapBasedResolver(agentMap)
    const result = await resolver('test', agentHandle('test', agent))

    expect(result).toBe(agent)
  })

  it('should resolve from Record', async () => {
    const agent = createMockAgent('test', 'response')
    const agentRecord = { test: agent }

    const resolver = createMapBasedResolver(agentRecord)
    const result = await resolver('test', agentHandle('test', agent))

    expect(result).toBe(agent)
  })

  it('should return null for unknown agent', async () => {
    const resolver = createMapBasedResolver(new Map())
    const dummyAgent = createMockAgent('dummy', 'dummy')
    const result = await resolver('unknown', agentHandle('unknown', dummyAgent))

    expect(result).toBeNull()
  })
})

describe('createFactoryResolver', () => {
  it('should use factory function', async () => {
    const factory = vi.fn(async (id: string) => createMockAgent(id, `response from ${id}`))

    const resolver = createFactoryResolver(factory)
    const dummyAgent = createMockAgent('agent1', 'dummy')
    const result = await resolver('agent1', agentHandle('agent1', dummyAgent))

    expect(factory).toHaveBeenCalledWith('agent1', expect.any(Object))
    expect(result).toBeDefined()
  })
})

describe('createBridgedTeamRuntime', () => {
  it('should create runtime and bridge', () => {
    const mockAgent1 = createMockAgent('agent1', 'response1')

    const team = defineTeam({
      id: 'test-team',
      agents: {
        agent1: agentHandle('agent1', mockAgent1)
      },
      flow: invoke('agent1', input.initial())
    })

    const { runtime, bridge } = createBridgedTeamRuntime({
      team,
      agentResolver: async () => mockAgent1
    })

    expect(runtime).toBeDefined()
    expect(bridge).toBeDefined()
    expect(typeof runtime.run).toBe('function')
  })

  it('should run team with bridged agents', async () => {
    const mockAgent1 = createMockAgent('agent1', 'step1 output')
    const mockAgent2 = createMockAgent('agent2', 'final output')

    const team = defineTeam({
      id: 'test-team',
      agents: {
        agent1: agentHandle('agent1', mockAgent1),
        agent2: agentHandle('agent2', mockAgent2)
      },
      flow: seq(
        invoke('agent1', input.initial()),
        invoke('agent2', input.prev())
      )
    })

    const { runtime, bridge } = createBridgedTeamRuntime({
      team,
      agentResolver: async (id) => id === 'agent1' ? mockAgent1 : mockAgent2
    })

    const result = await runtime.run('initial input')

    expect(result.success).toBe(true)
    expect(result.output).toBe('final output')
    expect(bridge.getInvocationCount('agent1')).toBe(1)
    expect(bridge.getInvocationCount('agent2')).toBe(1)
  })
})

describe('Input formatting', () => {
  it('should handle string input', async () => {
    const agent = createMockAgent('agent1', 'response')
    const team = defineTeam({
      id: 'test',
      agents: { agent1: agentHandle('agent1', agent) },
      flow: invoke('agent1', input.initial())
    })

    const bridge = createAgentBridge({
      team,
      agentResolver: async () => agent
    })

    const invoker = bridge.createInvoker()
    await invoker('agent1', 'string input', {
      runId: 'run-1',
      prevOutput: null,
      initial: 'string input',
      state: {},
      trace: []
    })

    expect(agent.run).toHaveBeenCalledWith('string input')
  })

  it('should extract message from object with message field', async () => {
    const agent = createMockAgent('agent1', 'response')
    const team = defineTeam({
      id: 'test',
      agents: { agent1: agentHandle('agent1', agent) },
      flow: invoke('agent1', input.initial())
    })

    const bridge = createAgentBridge({
      team,
      agentResolver: async () => agent
    })

    const invoker = bridge.createInvoker()
    await invoker('agent1', { message: 'extracted message' }, {
      runId: 'run-1',
      prevOutput: null,
      initial: { message: 'extracted message' },
      state: {},
      trace: []
    })

    expect(agent.run).toHaveBeenCalledWith('extracted message')
  })

  it('should extract content from object with content field', async () => {
    const agent = createMockAgent('agent1', 'response')
    const team = defineTeam({
      id: 'test',
      agents: { agent1: agentHandle('agent1', agent) },
      flow: invoke('agent1', input.initial())
    })

    const bridge = createAgentBridge({
      team,
      agentResolver: async () => agent
    })

    const invoker = bridge.createInvoker()
    await invoker('agent1', { content: 'extracted content' }, {
      runId: 'run-1',
      prevOutput: null,
      initial: { content: 'extracted content' },
      state: {},
      trace: []
    })

    expect(agent.run).toHaveBeenCalledWith('extracted content')
  })

  it('should stringify object without known fields', async () => {
    const agent = createMockAgent('agent1', 'response')
    const team = defineTeam({
      id: 'test',
      agents: { agent1: agentHandle('agent1', agent) },
      flow: invoke('agent1', input.initial())
    })

    const bridge = createAgentBridge({
      team,
      agentResolver: async () => agent
    })

    const invoker = bridge.createInvoker()
    await invoker('agent1', { custom: 'data', nested: { value: 123 } }, {
      runId: 'run-1',
      prevOutput: null,
      initial: { custom: 'data', nested: { value: 123 } },
      state: {},
      trace: []
    })

    expect(agent.run).toHaveBeenCalledWith(JSON.stringify({ custom: 'data', nested: { value: 123 } }))
  })
})
