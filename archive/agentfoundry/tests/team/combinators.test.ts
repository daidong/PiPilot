/**
 * Flow Combinator Tests
 *
 * Tests for the low-level flow combinators that build FlowSpec AST nodes.
 * For typed flow building, use the step() builder (see step.test.ts).
 */

import { describe, it, expect } from 'vitest'
import {
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  race,
  supervise,
  transfer,
  join
} from '../../src/team/flow/combinators.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// Helper to build InvokeSpec for testing (not exported from combinators)
function buildInvokeSpec(agent: string, input: InputRef): InvokeSpec {
  return { kind: 'invoke', agent, input }
}

// Helper input refs for testing
const inputRefs = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

describe('Flow Combinators', () => {
  describe('seq', () => {
    it('should create sequence spec', () => {
      const spec = seq(
        buildInvokeSpec('a', inputRefs.initial()),
        buildInvokeSpec('b', inputRefs.prev())
      )
      expect(spec).toMatchObject({
        kind: 'seq',
        steps: [
          { kind: 'invoke', agent: 'a' },
          { kind: 'invoke', agent: 'b' }
        ]
      })
    })

    it('should handle empty sequence', () => {
      const spec = seq()
      expect(spec).toMatchObject({
        kind: 'seq',
        steps: []
      })
    })

    it('should handle single step', () => {
      const spec = seq(buildInvokeSpec('a', inputRefs.initial()))
      expect(spec.steps).toHaveLength(1)
    })
  })

  describe('par', () => {
    it('should create parallel spec with reducer', () => {
      const spec = par(
        [
          buildInvokeSpec('a', inputRefs.initial()),
          buildInvokeSpec('b', inputRefs.initial())
        ],
        join('merge')
      )
      expect(spec).toMatchObject({
        kind: 'par',
        branches: [
          { kind: 'invoke', agent: 'a' },
          { kind: 'invoke', agent: 'b' }
        ],
        join: { reducerId: 'merge' }
      })
    })

    it('should support name and tags options', () => {
      const spec = par(
        [buildInvokeSpec('a', inputRefs.initial())],
        join('merge'),
        { name: 'Parallel Work', tags: ['parallel'] }
      )
      expect(spec.name).toBe('Parallel Work')
      expect(spec.tags).toEqual(['parallel'])
    })
  })

  describe('map', () => {
    it('should create map spec', () => {
      const spec = map(
        { ref: 'state', path: 'items' },
        buildInvokeSpec('processor', inputRefs.prev()),
        join('collect')
      )
      expect(spec).toMatchObject({
        kind: 'map',
        items: { ref: 'state', path: 'items' },
        worker: { kind: 'invoke', agent: 'processor' },
        join: { reducerId: 'collect' }
      })
    })

    it('should support concurrency option', () => {
      const spec = map(
        { ref: 'state', path: 'items' },
        buildInvokeSpec('processor', inputRefs.prev()),
        join('collect'),
        { concurrency: 3 }
      )
      expect(spec.concurrency).toBe(3)
    })

    it('should support name and tags options', () => {
      const spec = map(
        { ref: 'state', path: 'items' },
        buildInvokeSpec('processor', inputRefs.prev()),
        join('collect'),
        { name: 'Map Items', tags: ['map'] }
      )
      expect(spec.name).toBe('Map Items')
      expect(spec.tags).toEqual(['map'])
    })
  })

  describe('choose', () => {
    it('should create choose spec with rule router', () => {
      const spec = choose(
        {
          type: 'rule',
          rules: [
            { when: { op: 'eq', path: 'type', value: 'option1' }, route: 'branch1' }
          ]
        },
        {
          'branch1': buildInvokeSpec('agent1', inputRefs.initial()),
          'branch2': buildInvokeSpec('agent2', inputRefs.initial())
        },
        { defaultBranch: 'branch2' }
      )
      expect(spec).toMatchObject({
        kind: 'choose',
        router: { type: 'rule' },
        branches: {
          branch1: { kind: 'invoke', agent: 'agent1' },
          branch2: { kind: 'invoke', agent: 'agent2' }
        },
        defaultBranch: 'branch2'
      })
    })

    it('should support name and tags options', () => {
      const spec = choose(
        { type: 'rule', rules: [] },
        { 'default': buildInvokeSpec('agent', inputRefs.initial()) },
        { name: 'Router', tags: ['routing'] }
      )
      expect(spec.name).toBe('Router')
      expect(spec.tags).toEqual(['routing'])
    })
  })

  describe('loop', () => {
    it('should create loop spec with field-eq condition', () => {
      const spec = loop(
        buildInvokeSpec('refiner', inputRefs.prev()),
        { type: 'field-eq', path: 'status', value: 'done' },
        { maxIters: 5 }
      )
      expect(spec).toMatchObject({
        kind: 'loop',
        body: { kind: 'invoke', agent: 'refiner' },
        until: { type: 'field-eq', path: 'status', value: 'done' },
        maxIters: 5
      })
    })

    it('should create loop spec with max-iterations condition', () => {
      const spec = loop(
        buildInvokeSpec('worker', inputRefs.prev()),
        { type: 'max-iterations', count: 10 },
        { maxIters: 10 }
      )
      expect(spec.until).toEqual({ type: 'max-iterations', count: 10 })
      expect(spec.maxIters).toBe(10)
    })

    it('should support name and tags options', () => {
      const spec = loop(
        buildInvokeSpec('refiner', inputRefs.prev()),
        { type: 'field-eq', path: 'done', value: true },
        { maxIters: 5, name: 'Refine Loop', tags: ['loop'] }
      )
      expect(spec.name).toBe('Refine Loop')
      expect(spec.tags).toEqual(['loop'])
    })
  })

  describe('gate', () => {
    it('should create gate spec with predicate rule', () => {
      const spec = gate(
        { type: 'predicate', predicate: { op: 'eq', path: 'approved', value: true } },
        buildInvokeSpec('executor', inputRefs.prev()),
        buildInvokeSpec('notifier', inputRefs.prev())
      )
      expect(spec).toMatchObject({
        kind: 'gate',
        gate: { type: 'predicate' },
        onPass: { kind: 'invoke', agent: 'executor' },
        onFail: { kind: 'invoke', agent: 'notifier' }
      })
    })

    it('should support validator gate', () => {
      const spec = gate(
        { type: 'validator', validatorId: 'myValidator', input: inputRefs.prev() },
        buildInvokeSpec('pass', inputRefs.prev()),
        buildInvokeSpec('fail', inputRefs.prev())
      )
      expect(spec.gate).toMatchObject({
        type: 'validator',
        validatorId: 'myValidator'
      })
    })

    it('should support name and tags options', () => {
      const spec = gate(
        { type: 'predicate', predicate: { op: 'eq', path: 'ok', value: true } },
        buildInvokeSpec('pass', inputRefs.prev()),
        buildInvokeSpec('fail', inputRefs.prev()),
        { name: 'Quality Gate', tags: ['gate'] }
      )
      expect(spec.name).toBe('Quality Gate')
      expect(spec.tags).toEqual(['gate'])
    })
  })

  describe('race', () => {
    it('should create race spec with firstSuccess winner', () => {
      const spec = race(
        [
          buildInvokeSpec('fast', inputRefs.initial()),
          buildInvokeSpec('slow', inputRefs.initial())
        ],
        { type: 'firstSuccess' }
      )
      expect(spec).toMatchObject({
        kind: 'race',
        contenders: [
          { kind: 'invoke', agent: 'fast' },
          { kind: 'invoke', agent: 'slow' }
        ],
        winner: { type: 'firstSuccess' }
      })
    })

    it('should support highestScore winner', () => {
      const spec = race(
        [
          buildInvokeSpec('a', inputRefs.initial()),
          buildInvokeSpec('b', inputRefs.initial())
        ],
        { type: 'highestScore', path: 'score' }
      )
      expect(spec.winner).toEqual({ type: 'highestScore', path: 'score' })
    })

    it('should support name and tags options', () => {
      const spec = race(
        [buildInvokeSpec('a', inputRefs.initial())],
        { type: 'firstSuccess' },
        { name: 'Race', tags: ['race'] }
      )
      expect(spec.name).toBe('Race')
      expect(spec.tags).toEqual(['race'])
    })
  })

  describe('supervise', () => {
    it('should create supervise spec', () => {
      const spec = supervise(
        buildInvokeSpec('supervisor', inputRefs.initial()),
        buildInvokeSpec('worker', inputRefs.prev()),
        join('merge'),
        'sequential'
      )
      expect(spec).toMatchObject({
        kind: 'supervise',
        supervisor: { kind: 'invoke', agent: 'supervisor' },
        workers: { kind: 'invoke', agent: 'worker' },
        strategy: 'sequential',
        join: { reducerId: 'merge' }
      })
    })

    it('should support parallel strategy', () => {
      const spec = supervise(
        buildInvokeSpec('supervisor', inputRefs.initial()),
        par([
          buildInvokeSpec('w1', inputRefs.prev()),
          buildInvokeSpec('w2', inputRefs.prev())
        ], join('merge')),
        join('merge'),
        'parallel'
      )
      expect(spec.strategy).toBe('parallel')
    })

    it('should support name and tags options', () => {
      const spec = supervise(
        buildInvokeSpec('supervisor', inputRefs.initial()),
        buildInvokeSpec('worker', inputRefs.prev()),
        join('merge'),
        'sequential',
        { name: 'Supervised Work', tags: ['supervise'] }
      )
      expect(spec.name).toBe('Supervised Work')
      expect(spec.tags).toEqual(['supervise'])
    })
  })
})

describe('Transfer Helpers', () => {
  it('should create minimal transfer', () => {
    const spec = transfer.minimal()
    expect(spec).toEqual({ mode: 'minimal' })
  })

  it('should create scoped transfer', () => {
    const spec = transfer.scoped(['namespace1', 'namespace2'])
    expect(spec).toEqual({
      mode: 'scoped',
      allowNamespaces: ['namespace1', 'namespace2']
    })
  })

  it('should create scoped transfer with maxBytes', () => {
    const spec = transfer.scoped(['ns'], 1000)
    expect(spec).toEqual({
      mode: 'scoped',
      allowNamespaces: ['ns'],
      maxBytes: 1000
    })
  })

  it('should create full transfer', () => {
    const spec = transfer.full()
    expect(spec).toEqual({ mode: 'full' })
  })
})

describe('Join Helper', () => {
  it('should create join spec without options', () => {
    const spec = join('merge')
    expect(spec).toEqual({ reducerId: 'merge' })
  })

  it('should create join spec with args', () => {
    const spec = join('custom', { args: { threshold: 0.5 } })
    expect(spec).toEqual({
      reducerId: 'custom',
      args: { threshold: 0.5 }
    })
  })

  it('should create join spec with outputAs', () => {
    const spec = join('collect', { outputAs: { path: 'results' } })
    expect(spec).toEqual({
      reducerId: 'collect',
      outputAs: { path: 'results' }
    })
  })
})
