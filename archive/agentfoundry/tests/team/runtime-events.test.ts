/**
 * Team Runtime Event Integration Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TeamRuntime,
  createTeamRuntime,
  createMockInvoker,
  type TeamRuntimeConfig
} from '../../src/team/team-runtime.js'
import { defineTeam } from '../../src/team/define-team.js'
import { seq, loop } from '../../src/team/flow/combinators.js'
import { branch, noop } from '../../src/team/flow/edges.js'
import type { FlowSpec, InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// Local helpers for building AST nodes (since invoke/input are internal now)
function buildInvoke(
  agent: string,
  inputRef: InputRef,
  options?: { outputAs?: { path: string } }
): InvokeSpec {
  return { kind: 'invoke', agent, input: inputRef, outputAs: options?.outputAs }
}

const inputRef = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

describe('TeamRuntime Event Integration', () => {
  // All tests need at least one agent in the team definition
  // Agent handles require both id and agent properties
  const dummyAgent = { id: 'stub-agent', name: 'Stub Agent' }
  const dummyAgents = { dummy: { id: 'dummy', agent: dummyAgent } }

  describe('on() method', () => {
    it('should subscribe to team.started event', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const handler = vi.fn()
      runtime.on('team.started', handler)

      await runtime.run({ query: 'test' })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'test-team',
          input: { query: 'test' }
        })
      )
    })

    it('should subscribe to team.completed event', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const handler = vi.fn()
      runtime.on('team.completed', handler)

      await runtime.run({ query: 'test' })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'test-team',
          steps: expect.any(Number),
          durationMs: expect.any(Number)
        })
      )
    })

    it('should subscribe to team.failed event', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: buildInvoke('failing-agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'failing-agent': () => { throw new Error('Agent error') }
        })
      })

      const handler = vi.fn()
      runtime.on('team.failed', handler)

      await runtime.run({ query: 'test' })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'test-team',
          error: expect.any(Error)
        })
      )
    })

    it('should unsubscribe from events', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const handler = vi.fn()
      const unsubscribe = runtime.on('team.started', handler)

      await runtime.run({ query: 'first' })
      expect(handler).toHaveBeenCalledTimes(1)

      unsubscribe()

      await runtime.run({ query: 'second' })
      expect(handler).toHaveBeenCalledTimes(1) // Still 1
    })
  })

  describe('agent events', () => {
    it('should emit agent.started and agent.completed events', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: seq(
          buildInvoke('agent1', inputRef.initial()),
          buildInvoke('agent2', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'agent1': () => ({ result: 'from-agent1' }),
          'agent2': () => ({ result: 'from-agent2' })
        })
      })

      const startedHandler = vi.fn()
      const completedHandler = vi.fn()

      runtime.on('agent.started', startedHandler)
      runtime.on('agent.completed', completedHandler)

      await runtime.run({ query: 'test' })

      expect(startedHandler).toHaveBeenCalledTimes(2)
      expect(completedHandler).toHaveBeenCalledTimes(2)

      // Check agent1 events
      expect(startedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent1', step: 1 })
      )
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent1',
          step: 1,
          output: { result: 'from-agent1' }
        })
      )

      // Check agent2 events
      expect(startedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent2', step: 2 })
      )
      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent2',
          step: 2,
          output: { result: 'from-agent2' }
        })
      )
    })

    it('should emit agent.failed event on agent error', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: buildInvoke('failing-agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'failing-agent': () => { throw new Error('Agent crashed') }
        })
      })

      const failedHandler = vi.fn()
      runtime.on('agent.failed', failedHandler)

      await runtime.run({ query: 'test' })

      expect(failedHandler).toHaveBeenCalledTimes(1)
      expect(failedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'failing-agent',
          error: expect.objectContaining({ message: 'Agent crashed' })
        })
      )
    })

    it('should include token usage when available', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: buildInvoke('llm-agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'llm-agent': () => ({
            output: 'response',
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150
            }
          })
        })
      })

      const completedHandler = vi.fn()
      runtime.on('agent.completed', completedHandler)

      await runtime.run({ query: 'test' })

      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          }
        })
      )
    })
  })

  describe('step events', () => {
    it('should emit step.started and step.completed events', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: seq(
          buildInvoke('agent1', inputRef.initial()),
          buildInvoke('agent2', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'agent1': () => ({ result: 1 }),
          'agent2': () => ({ result: 2 })
        })
      })

      const stepStartedHandler = vi.fn()
      const stepCompletedHandler = vi.fn()

      runtime.on('step.started', stepStartedHandler)
      runtime.on('step.completed', stepCompletedHandler)

      await runtime.run({ query: 'test' })

      // Should have events for seq, invoke(agent1), invoke(agent2)
      expect(stepStartedHandler.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(stepCompletedHandler.mock.calls.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('branch events', () => {
    it('should emit branch.decision event', async () => {
      const branchFlow: FlowSpec = {
        kind: 'branch',
        condition: (state: any) => state._prev?.approved === true,
        then: buildInvoke('then-agent', inputRef.prev()),
        else: { kind: 'noop' }
      }

      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: seq(
          buildInvoke('checker', inputRef.initial()),
          branchFlow
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'checker': () => ({ approved: true }),
          'then-agent': () => ({ result: 'then-executed' })
        })
      })

      const branchHandler = vi.fn()
      runtime.on('branch.decision', branchHandler)

      await runtime.run({ query: 'test' })

      expect(branchHandler).toHaveBeenCalledTimes(1)
      expect(branchHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          taken: 'then'
        })
      )
    })
  })

  describe('once() method', () => {
    it('should only fire handler once', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const handler = vi.fn()
      runtime.once('team.started', handler)

      await runtime.run({ query: 'first' })
      await runtime.run({ query: 'second' })
      await runtime.run({ query: 'third' })

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('getEventEmitter()', () => {
    it('should return the event emitter', () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const emitter = runtime.getEventEmitter()

      expect(emitter).toBeDefined()
      expect(typeof emitter.on).toBe('function')
      expect(typeof emitter.emit).toBe('function')
    })

    it('should allow direct emitter access', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: { kind: 'noop' }
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({})
      })

      const emitter = runtime.getEventEmitter()
      const handler = vi.fn()

      emitter.on('team.started', handler)

      await runtime.run({ query: 'test' })

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('event order', () => {
    it('should emit events in correct order', async () => {
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: buildInvoke('agent1', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'agent1': () => ({ result: 'done' })
        })
      })

      const events: string[] = []

      runtime.on('team.started', () => events.push('team.started'))
      runtime.on('agent.started', () => events.push('agent.started'))
      runtime.on('agent.completed', () => events.push('agent.completed'))
      runtime.on('team.completed', () => events.push('team.completed'))

      await runtime.run({ query: 'test' })

      expect(events).toEqual([
        'team.started',
        'agent.started',
        'agent.completed',
        'team.completed'
      ])
    })
  })

  describe('loop events', () => {
    it('should emit loop.iteration events', async () => {
      let iteration = 0
      const team = defineTeam({
        id: 'test-team',
        agents: dummyAgents,
        flow: loop(
          buildInvoke('processor', inputRef.prev(), { outputAs: { path: 'result' } }),
          { type: 'field-eq', path: 'result.done', value: true },
          { maxIters: 5 }
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          'processor': () => {
            iteration++
            return { done: iteration >= 3, count: iteration }
          }
        })
      })

      const loopHandler = vi.fn()
      runtime.on('loop.iteration', loopHandler)

      await runtime.run({ start: true })

      expect(loopHandler).toHaveBeenCalledTimes(3)
    })
  })
})
