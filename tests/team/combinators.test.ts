/**
 * Flow Combinator Tests
 */

import { describe, it, expect } from 'vitest'
import {
  invoke,
  seq,
  par,
  map,
  choose,
  loop,
  gate,
  race,
  supervise,
  input,
  transfer,
  until,
  pred,
  join
} from '../../src/team/flow/combinators.js'

describe('Flow Combinators', () => {
  describe('invoke', () => {
    it('should create invoke spec', () => {
      const spec = invoke('agent1', input.initial())
      expect(spec).toMatchObject({
        kind: 'invoke',
        agent: 'agent1',
        input: { ref: 'initial' }
      })
    })

    it('should support transfer option', () => {
      const spec = invoke('agent1', input.initial(), { transfer: transfer.minimal() })
      expect(spec.transfer).toEqual({ mode: 'minimal' })
    })

    it('should support outputAs option', () => {
      const spec = invoke('agent1', input.initial(), { outputAs: { path: 'result' } })
      expect(spec.outputAs).toEqual({ path: 'result' })
    })

    it('should support name and tags options', () => {
      const spec = invoke('agent1', input.initial(), { name: 'My Agent', tags: ['test'] })
      expect(spec.name).toBe('My Agent')
      expect(spec.tags).toEqual(['test'])
    })
  })

  describe('seq', () => {
    it('should create sequence spec', () => {
      const spec = seq(
        invoke('a', input.initial()),
        invoke('b', input.prev())
      )
      expect(spec).toMatchObject({
        kind: 'seq',
        steps: [
          { kind: 'invoke', agent: 'a' },
          { kind: 'invoke', agent: 'b' }
        ]
      })
    })
  })

  describe('par', () => {
    it('should create parallel spec with reducer', () => {
      const spec = par(
        [
          invoke('a', input.initial()),
          invoke('b', input.initial())
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
  })

  describe('map', () => {
    it('should create map spec', () => {
      const spec = map(
        { ref: 'state', path: 'items' },
        invoke('processor', input.prev()),
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
        invoke('processor', input.prev()),
        join('collect'),
        { concurrency: 3 }
      )
      expect(spec.concurrency).toBe(3)
    })
  })

  describe('choose', () => {
    it('should create choose spec with rule router', () => {
      const spec = choose(
        {
          type: 'rule',
          rules: [
            { when: pred.eq('type', 'option1'), route: 'branch1' }
          ]
        },
        {
          'branch1': invoke('agent1', input.initial()),
          'branch2': invoke('agent2', input.initial())
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
  })

  describe('loop', () => {
    it('should create loop spec with until condition', () => {
      const spec = loop(
        invoke('refiner', input.prev()),
        until.predicate(pred.eq('status', 'done')),
        { maxIters: 5 }
      )
      expect(spec).toMatchObject({
        kind: 'loop',
        body: { kind: 'invoke', agent: 'refiner' },
        until: { type: 'predicate' },
        maxIters: 5
      })
    })

    it('should require maxIters option', () => {
      const spec = loop(
        invoke('refiner', input.prev()),
        until.noCriticalIssues('reviews'),
        { maxIters: 10 }
      )
      expect(spec.maxIters).toBe(10)
    })
  })

  describe('gate', () => {
    it('should create gate spec with predicate rule', () => {
      const spec = gate(
        { type: 'predicate', predicate: pred.eq('approved', true) },
        invoke('executor', input.prev()),
        invoke('notifier', input.prev())
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
        { type: 'validator', validatorId: 'myValidator', input: input.prev() },
        invoke('pass', input.prev()),
        invoke('fail', input.prev())
      )
      expect(spec.gate).toMatchObject({
        type: 'validator',
        validatorId: 'myValidator'
      })
    })
  })

  describe('race', () => {
    it('should create race spec with firstSuccess winner', () => {
      const spec = race(
        [
          invoke('fast', input.initial()),
          invoke('slow', input.initial())
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
          invoke('a', input.initial()),
          invoke('b', input.initial())
        ],
        { type: 'highestScore', path: 'score' }
      )
      expect(spec.winner).toEqual({ type: 'highestScore', path: 'score' })
    })
  })

  describe('supervise', () => {
    it('should create supervise spec', () => {
      const spec = supervise(
        invoke('supervisor', input.initial()),
        invoke('worker', input.prev()),
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
  })
})

describe('Input Helpers', () => {
  it('should create initial input ref', () => {
    expect(input.initial()).toEqual({ ref: 'initial' })
  })

  it('should create prev input ref', () => {
    expect(input.prev()).toEqual({ ref: 'prev' })
  })

  it('should create state input ref', () => {
    expect(input.state('path.to.value')).toEqual({
      ref: 'state',
      path: 'path.to.value'
    })
  })

  it('should create const input ref', () => {
    expect(input.const({ key: 'value' })).toEqual({
      ref: 'const',
      value: { key: 'value' }
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

describe('Predicate Helpers', () => {
  it('should create eq predicate', () => {
    const spec = pred.eq('status', 'done')
    expect(spec).toEqual({
      op: 'eq',
      path: 'status',
      value: 'done'
    })
  })

  it('should create neq predicate', () => {
    const spec = pred.neq('status', 'failed')
    expect(spec).toEqual({
      op: 'neq',
      path: 'status',
      value: 'failed'
    })
  })

  it('should create comparison predicates', () => {
    expect(pred.gt('count', 5)).toEqual({ op: 'gt', path: 'count', value: 5 })
    expect(pred.gte('count', 5)).toEqual({ op: 'gte', path: 'count', value: 5 })
    expect(pred.lt('count', 5)).toEqual({ op: 'lt', path: 'count', value: 5 })
    expect(pred.lte('count', 5)).toEqual({ op: 'lte', path: 'count', value: 5 })
  })

  it('should create and predicate', () => {
    const spec = pred.and(
      pred.eq('a', 1),
      pred.eq('b', 2)
    )
    expect(spec).toMatchObject({
      op: 'and',
      clauses: [
        { op: 'eq', path: 'a', value: 1 },
        { op: 'eq', path: 'b', value: 2 }
      ]
    })
  })

  it('should create or predicate', () => {
    const spec = pred.or(
      pred.eq('a', 1),
      pred.eq('b', 2)
    )
    expect(spec).toMatchObject({
      op: 'or',
      clauses: [
        { op: 'eq', path: 'a', value: 1 },
        { op: 'eq', path: 'b', value: 2 }
      ]
    })
  })

  it('should create not predicate', () => {
    const spec = pred.not(pred.eq('flag', true))
    expect(spec).toMatchObject({
      op: 'not',
      clause: { op: 'eq', path: 'flag', value: true }
    })
  })

  it('should create contains predicate', () => {
    const spec = pred.contains('text', 'hello')
    expect(spec).toEqual({ op: 'contains', path: 'text', value: 'hello' })
  })

  it('should create regex predicate', () => {
    const spec = pred.regex('text', '^test.*$')
    expect(spec).toEqual({ op: 'regex', path: 'text', pattern: '^test.*$' })
  })

  it('should create exists predicate', () => {
    const spec = pred.exists('optional')
    expect(spec).toEqual({ op: 'exists', path: 'optional' })
  })

  it('should create empty predicate', () => {
    const spec = pred.empty('list')
    expect(spec).toEqual({ op: 'empty', path: 'list' })
  })
})

describe('Until Helpers', () => {
  it('should create predicate until', () => {
    const spec = until.predicate(pred.eq('done', true))
    expect(spec).toMatchObject({
      type: 'predicate',
      predicate: { op: 'eq', path: 'done', value: true }
    })
  })

  it('should create noCriticalIssues until', () => {
    const spec = until.noCriticalIssues('reviews')
    expect(spec).toEqual({
      type: 'noCriticalIssues',
      path: 'reviews'
    })
  })

  it('should create noProgress until', () => {
    const spec = until.noProgress(3)
    expect(spec).toEqual({
      type: 'noProgress',
      windowSize: 3
    })
  })

  it('should create budgetExceeded until', () => {
    const spec = until.budgetExceeded()
    expect(spec).toEqual({ type: 'budgetExceeded' })
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
