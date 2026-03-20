/**
 * Integration tests for the team runtime end-to-end.
 *
 * These tests exercise defineTeam + createTeamRuntime with mock invokers,
 * covering seq, par, loop, choose flows, blackboard state passing, and
 * event emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TeamRuntime,
  createTeamRuntime,
  createMockInvoker
} from '../../src/team/team-runtime.js'
import { defineTeam, agentHandle } from '../../src/team/define-team.js'
import {
  seq,
  par,
  loop,
  choose,
  join
} from '../../src/team/flow/combinators.js'
import type { InvokeSpec, InputRef, PredicateSpec } from '../../src/team/flow/ast.js'

// ---------------------------------------------------------------------------
// Helpers (mirror the pattern in tests/team/)
// ---------------------------------------------------------------------------

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
  state: (path: string): InputRef => ({ ref: 'state', path }),
  const: (value: unknown): InputRef => ({ ref: 'const', value })
}

const predicate = {
  eq: (path: string, value: unknown): PredicateSpec => ({ op: 'eq', path, value }),
  and: (...clauses: PredicateSpec[]): PredicateSpec => ({ op: 'and', clauses }),
  or: (...clauses: PredicateSpec[]): PredicateSpec => ({ op: 'or', clauses }),
  not: (clause: PredicateSpec): PredicateSpec => ({ op: 'not', clause })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Team Flow end-to-end', () => {

  // -----------------------------------------------------------------------
  // 1. seq flow completes in order
  // -----------------------------------------------------------------------
  describe('seq flow', () => {
    it('should execute agents sequentially, passing output as next input', async () => {
      const invocations: Array<{ agentId: string; input: unknown }> = []

      const team = defineTeam({
        id: 'seq-team',
        name: 'Sequential Team',
        agents: {
          planner: agentHandle('planner', {}, { role: 'Plan tasks' }),
          executor: agentHandle('executor', {}, { role: 'Execute tasks' }),
          reporter: agentHandle('reporter', {}, { role: 'Report results' })
        },
        flow: seq(
          buildInvoke('planner', inputRef.initial()),
          buildInvoke('executor', inputRef.prev()),
          buildInvoke('reporter', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId, agentInput) => {
          invocations.push({ agentId, input: agentInput })
          switch (agentId) {
            case 'planner': return { plan: ['step1', 'step2'] }
            case 'executor': return { executionResult: 'all steps done' }
            case 'reporter': return { report: 'Execution completed successfully' }
            default: return {}
          }
        }
      })

      const result = await runtime.run({ goal: 'Deploy feature' })

      expect(result.success).toBe(true)
      expect(invocations).toHaveLength(3)
      expect(invocations[0].agentId).toBe('planner')
      expect(invocations[0].input).toEqual({ goal: 'Deploy feature' })
      expect(invocations[1].agentId).toBe('executor')
      expect(invocations[1].input).toEqual({ plan: ['step1', 'step2'] })
      expect(invocations[2].agentId).toBe('reporter')
      expect(invocations[2].input).toEqual({ executionResult: 'all steps done' })
      expect(result.output).toEqual({ report: 'Execution completed successfully' })
    })

    it('should propagate error when a middle agent fails', async () => {
      const team = defineTeam({
        id: 'seq-fail-team',
        name: 'Sequential Fail Team',
        agents: {
          a: agentHandle('a', {}),
          b: agentHandle('b', {}),
          c: agentHandle('c', {})
        },
        flow: seq(
          buildInvoke('a', inputRef.initial()),
          buildInvoke('b', inputRef.prev()),
          buildInvoke('c', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId) => {
          if (agentId === 'b') throw new Error('Agent B exploded')
          return { from: agentId }
        }
      })

      const result = await runtime.run({})

      expect(result.success).toBe(false)
      expect(result.error).toBe('Agent B exploded')
    })
  })

  // -----------------------------------------------------------------------
  // 2. par flow runs branches and joins results
  // -----------------------------------------------------------------------
  describe('par flow', () => {
    it('should execute branches in parallel and merge results', async () => {
      const team = defineTeam({
        id: 'par-team',
        name: 'Parallel Team',
        agents: {
          searcherA: agentHandle('searcherA', {}),
          searcherB: agentHandle('searcherB', {})
        },
        flow: par(
          [
            buildInvoke('searcherA', inputRef.initial()),
            buildInvoke('searcherB', inputRef.initial())
          ],
          join('merge')
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId, input) => {
          if (agentId === 'searcherA') return { sourceA: 'results from A' }
          return { sourceB: 'results from B' }
        }
      })

      const result = await runtime.run({ query: 'find papers' })

      expect(result.success).toBe(true)
      // Merge reducer produces an object with properties from all branches
      expect(result.output).toMatchObject({
        sourceA: 'results from A',
        sourceB: 'results from B'
      })
    })

    it('should collect results into an array with collect reducer', async () => {
      const team = defineTeam({
        id: 'par-collect-team',
        name: 'Parallel Collect Team',
        agents: {
          a: agentHandle('a', {}),
          b: agentHandle('b', {}),
          c: agentHandle('c', {})
        },
        flow: par(
          [
            buildInvoke('a', inputRef.initial()),
            buildInvoke('b', inputRef.initial()),
            buildInvoke('c', inputRef.initial())
          ],
          join('collect')
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId) => ({ from: agentId })
      })

      const result = await runtime.run({})

      expect(result.success).toBe(true)
      expect(Array.isArray(result.output)).toBe(true)
      expect((result.output as unknown[]).length).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // 3. loop flow iterates and exits on condition
  // -----------------------------------------------------------------------
  describe('loop flow', () => {
    it('should loop until predicate is satisfied', async () => {
      let iteration = 0

      const team = defineTeam({
        id: 'loop-team',
        name: 'Loop Team',
        agents: {
          refiner: agentHandle('refiner', {})
        },
        flow: loop(
          buildInvoke('refiner', inputRef.prev()),
          { type: 'predicate', predicate: predicate.eq('quality', 'high') },
          { maxIters: 10 }
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          iteration++
          return {
            content: `draft-v${iteration}`,
            quality: iteration >= 3 ? 'high' : 'low'
          }
        }
      })

      const result = await runtime.run({ content: 'initial draft', quality: 'low' })

      expect(result.success).toBe(true)
      expect(iteration).toBe(3)
      expect(result.output).toMatchObject({ quality: 'high' })
    })

    it('should respect maxIters when condition is never met', async () => {
      let iterations = 0

      const team = defineTeam({
        id: 'loop-max-team',
        name: 'Loop Max Team',
        agents: {
          neverDone: agentHandle('neverDone', {})
        },
        flow: loop(
          buildInvoke('neverDone', inputRef.prev()),
          { type: 'predicate', predicate: predicate.eq('done', true) },
          { maxIters: 4 }
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          iterations++
          return { done: false, iteration: iterations }
        }
      })

      const result = await runtime.run({})

      expect(iterations).toBe(4)
    })
  })

  // -----------------------------------------------------------------------
  // 4. choose flow picks correct branch
  // -----------------------------------------------------------------------
  describe('choose flow', () => {
    it('should route to the correct branch based on state', async () => {
      const invocations: string[] = []

      const team = defineTeam({
        id: 'choose-team',
        name: 'Choose Team',
        state: { storage: 'memory', namespace: 'choose-test' },
        agents: {
          classifier: agentHandle('classifier', {}),
          bugHandler: agentHandle('bugHandler', {}),
          featureHandler: agentHandle('featureHandler', {})
        },
        flow: seq(
          buildInvoke('classifier', inputRef.initial(), { outputAs: { path: 'classification' } }),
          choose(
            {
              type: 'rule',
              rules: [
                { when: predicate.eq('classification.type', 'bug'), route: 'bugBranch' },
                { when: predicate.eq('classification.type', 'feature'), route: 'featureBranch' }
              ]
            },
            {
              'bugBranch': buildInvoke('bugHandler', inputRef.state('classification')),
              'featureBranch': buildInvoke('featureHandler', inputRef.state('classification'))
            }
          )
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId, input) => {
          invocations.push(agentId)
          if (agentId === 'classifier') {
            return { type: 'bug', description: 'Login fails' }
          }
          return { handled: true, by: agentId }
        }
      })

      const result = await runtime.run({ issue: 'Login fails intermittently' })

      expect(result.success).toBe(true)
      expect(invocations).toContain('classifier')
      expect(invocations).toContain('bugHandler')
      expect(invocations).not.toContain('featureHandler')
    })

    it('should use default branch when no rule matches', async () => {
      const invocations: string[] = []

      const team = defineTeam({
        id: 'choose-default-team',
        name: 'Choose Default Team',
        state: { storage: 'memory', namespace: 'choose-default' },
        agents: {
          tagger: agentHandle('tagger', {}),
          specialHandler: agentHandle('specialHandler', {}),
          defaultHandler: agentHandle('defaultHandler', {})
        },
        flow: seq(
          buildInvoke('tagger', inputRef.initial(), { outputAs: { path: 'tag' } }),
          choose(
            {
              type: 'rule',
              rules: [
                { when: predicate.eq('tag.category', 'special'), route: 'specialRoute' }
              ]
            },
            {
              'specialRoute': buildInvoke('specialHandler', inputRef.state('tag')),
              'fallback': buildInvoke('defaultHandler', inputRef.state('tag'))
            },
            { defaultBranch: 'fallback' }
          )
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId) => {
          invocations.push(agentId)
          if (agentId === 'tagger') return { category: 'normal' }
          return { handled: true, by: agentId }
        }
      })

      const result = await runtime.run({ item: 'something' })

      expect(result.success).toBe(true)
      expect(invocations).toContain('defaultHandler')
      expect(invocations).not.toContain('specialHandler')
    })
  })

  // -----------------------------------------------------------------------
  // 5. State passing between agents via blackboard
  // -----------------------------------------------------------------------
  describe('state passing via blackboard', () => {
    it('should share state between agents using outputAs and state input refs', async () => {
      const team = defineTeam({
        id: 'state-team',
        name: 'State Team',
        state: { storage: 'memory', namespace: 'state-test' },
        agents: {
          producer: agentHandle('producer', {}),
          consumer: agentHandle('consumer', {})
        },
        flow: seq(
          buildInvoke('producer', inputRef.initial(), { outputAs: { path: 'shared' } }),
          buildInvoke('consumer', inputRef.state('shared'))
        )
      })

      let consumerInput: unknown = null

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId, input) => {
          if (agentId === 'producer') {
            return { sharedData: 'hello from producer', count: 42 }
          }
          consumerInput = input
          return { consumed: true }
        }
      })

      const result = await runtime.run({ trigger: 'start' })

      expect(result.success).toBe(true)
      expect(consumerInput).toEqual({ sharedData: 'hello from producer', count: 42 })

      // Verify blackboard state
      expect(runtime.getState().get('shared')).toEqual({
        sharedData: 'hello from producer',
        count: 42
      })
    })

    it('should make final state available in result', async () => {
      const team = defineTeam({
        id: 'state-result-team',
        name: 'State Result Team',
        state: { storage: 'memory', namespace: 'result-test' },
        agents: {
          writer: agentHandle('writer', {})
        },
        flow: buildInvoke('writer', inputRef.initial(), { outputAs: { path: 'output' } })
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => ({ value: 99 })
      })

      const result = await runtime.run({})

      expect(result.finalState).toBeDefined()
      expect(runtime.getState().get('output')).toEqual({ value: 99 })
    })
  })

  // -----------------------------------------------------------------------
  // 6. Events are emitted during execution
  // -----------------------------------------------------------------------
  describe('event emission', () => {
    it('should emit team.started and team.completed events', async () => {
      const team = defineTeam({
        id: 'event-team',
        name: 'Event Team',
        agents: {
          agent: agentHandle('agent', {})
        },
        flow: buildInvoke('agent', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ agent: { result: 'done' } })
      })

      const events: string[] = []
      runtime.on('team.started', () => events.push('team.started'))
      runtime.on('team.completed', () => events.push('team.completed'))

      await runtime.run({ input: 'test' })

      expect(events).toContain('team.started')
      expect(events).toContain('team.completed')
    })

    it('should emit agent.started and agent.completed for each agent invocation', async () => {
      const team = defineTeam({
        id: 'agent-event-team',
        name: 'Agent Event Team',
        agents: {
          first: agentHandle('first', {}),
          second: agentHandle('second', {})
        },
        flow: seq(
          buildInvoke('first', inputRef.initial()),
          buildInvoke('second', inputRef.prev())
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          first: { data: 'from-first' },
          second: { data: 'from-second' }
        })
      })

      const agentEvents: Array<{ event: string; agentId: string }> = []
      runtime.on('agent.started', (data: any) =>
        agentEvents.push({ event: 'started', agentId: data.agentId })
      )
      runtime.on('agent.completed', (data: any) =>
        agentEvents.push({ event: 'completed', agentId: data.agentId })
      )

      await runtime.run({})

      expect(agentEvents).toEqual([
        { event: 'started', agentId: 'first' },
        { event: 'completed', agentId: 'first' },
        { event: 'started', agentId: 'second' },
        { event: 'completed', agentId: 'second' }
      ])
    })

    it('should emit team.failed when execution errors', async () => {
      const team = defineTeam({
        id: 'fail-event-team',
        name: 'Fail Event Team',
        agents: {
          failing: agentHandle('failing', {})
        },
        flow: buildInvoke('failing', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({
          failing: () => { throw new Error('Boom') }
        })
      })

      const failHandler = vi.fn()
      runtime.on('team.failed', failHandler)

      await runtime.run({})

      expect(failHandler).toHaveBeenCalledTimes(1)
      expect(failHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'fail-event-team',
          error: expect.any(Error)
        })
      )
    })

    it('should emit events in the correct order', async () => {
      const team = defineTeam({
        id: 'order-team',
        name: 'Order Team',
        agents: {
          worker: agentHandle('worker', {})
        },
        flow: buildInvoke('worker', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ worker: { done: true } })
      })

      const eventOrder: string[] = []
      runtime.on('team.started', () => eventOrder.push('team.started'))
      runtime.on('agent.started', () => eventOrder.push('agent.started'))
      runtime.on('agent.completed', () => eventOrder.push('agent.completed'))
      runtime.on('team.completed', () => eventOrder.push('team.completed'))

      await runtime.run({})

      expect(eventOrder).toEqual([
        'team.started',
        'agent.started',
        'agent.completed',
        'team.completed'
      ])
    })
  })

  // -----------------------------------------------------------------------
  // 7. Trace recording
  // -----------------------------------------------------------------------
  describe('trace recording', () => {
    it('should record trace events via onTrace callback', async () => {
      const traceEvents: unknown[] = []

      const team = defineTeam({
        id: 'trace-team',
        name: 'Trace Team',
        agents: {
          worker: agentHandle('worker', {})
        },
        flow: buildInvoke('worker', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ worker: { result: 'ok' } }),
        onTrace: (event) => traceEvents.push(event)
      })

      await runtime.run({})

      expect(traceEvents.length).toBeGreaterThan(0)
      expect(traceEvents.some(e => (e as any).type === 'team.start')).toBe(true)
      expect(traceEvents.some(e => (e as any).type === 'team.complete')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 8. Unique run IDs and timing
  // -----------------------------------------------------------------------
  describe('run metadata', () => {
    it('should generate unique run IDs', async () => {
      const team = defineTeam({
        id: 'meta-team',
        name: 'Meta Team',
        agents: {
          echo: agentHandle('echo', {})
        },
        flow: buildInvoke('echo', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ echo: { ok: true } })
      })

      const r1 = await runtime.run({})
      const r2 = await runtime.run({})

      expect(r1.runId).toBeDefined()
      expect(r2.runId).toBeDefined()
      expect(r1.runId).not.toBe(r2.runId)
    })

    it('should track execution duration', async () => {
      const team = defineTeam({
        id: 'duration-team',
        name: 'Duration Team',
        agents: {
          slow: agentHandle('slow', {})
        },
        flow: buildInvoke('slow', inputRef.initial())
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async () => {
          await new Promise(r => setTimeout(r, 30))
          return { done: true }
        }
      })

      const result = await runtime.run({})

      expect(result.durationMs).toBeGreaterThanOrEqual(25)
    })
  })

  // -----------------------------------------------------------------------
  // 9. State reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('should clear blackboard state on reset()', async () => {
      const team = defineTeam({
        id: 'reset-team',
        name: 'Reset Team',
        state: { storage: 'memory', namespace: 'reset-test' },
        agents: {
          writer: agentHandle('writer', {})
        },
        flow: buildInvoke('writer', inputRef.initial(), { outputAs: { path: 'data' } })
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: createMockInvoker({ writer: { value: 123 } })
      })

      await runtime.run({})
      expect(runtime.getState().has('data')).toBe(true)

      runtime.reset()
      expect(runtime.getState().has('data')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // 10. Complex nested flow
  // -----------------------------------------------------------------------
  describe('nested flows', () => {
    it('should handle seq inside par', async () => {
      const invocations: string[] = []

      const team = defineTeam({
        id: 'nested-team',
        name: 'Nested Team',
        agents: {
          researcher: agentHandle('researcher', {}),
          writer: agentHandle('writer', {}),
          reviewer: agentHandle('reviewer', {})
        },
        flow: par(
          [
            seq(
              buildInvoke('researcher', inputRef.initial()),
              buildInvoke('writer', inputRef.prev())
            ),
            buildInvoke('reviewer', inputRef.initial())
          ],
          join('merge')
        )
      })

      const runtime = createTeamRuntime({
        team,
        agentInvoker: async (agentId) => {
          invocations.push(agentId)
          switch (agentId) {
            case 'researcher': return { research: 'data' }
            case 'writer': return { draft: 'article' }
            case 'reviewer': return { review: 'approved' }
            default: return {}
          }
        }
      })

      const result = await runtime.run({ topic: 'AI' })

      expect(result.success).toBe(true)
      expect(invocations).toContain('researcher')
      expect(invocations).toContain('writer')
      expect(invocations).toContain('reviewer')
      // researcher must come before writer in the sequential branch
      expect(invocations.indexOf('researcher')).toBeLessThan(invocations.indexOf('writer'))
    })
  })
})
