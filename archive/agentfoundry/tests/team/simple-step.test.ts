/**
 * Tests for simple step builder (RFC-002)
 */

import { describe, it, expect } from 'vitest'
import {
  simpleStep,
  simpleBranch,
  simpleSeq,
  simpleLoop,
  simpleSelect,
  simplePar
} from '../../src/team/flow/simple-step.js'

describe('simpleStep', () => {
  describe('basic usage', () => {
    it('should create a step with agent ID', () => {
      const step = simpleStep('myAgent').build()

      expect(step.kind).toBe('invoke')
      expect(step.agent).toBe('myAgent')
      expect(step.input).toEqual({ ref: 'prev' })
    })

    it('should create a step with output path', () => {
      const step = simpleStep('myAgent').to('result')

      expect(step.kind).toBe('invoke')
      expect(step.agent).toBe('myAgent')
      expect(step.outputAs).toEqual({ path: 'result' })
    })
  })

  describe('from() input specification', () => {
    it('should read from state path', () => {
      const step = simpleStep('myAgent').from('planner').build()

      expect(step.input).toEqual({ ref: 'state', path: 'planner' })
    })

    it('should read from nested state path', () => {
      const step = simpleStep('myAgent').from('planner.queries').build()

      expect(step.input).toEqual({ ref: 'state', path: 'planner.queries' })
    })

    it('should read from initial input', () => {
      const step = simpleStep('myAgent').from('initial').build()

      expect(step.input).toEqual({ ref: 'initial' })
    })

    it('should read from prev output', () => {
      const step = simpleStep('myAgent').from('prev').build()

      expect(step.input).toEqual({ ref: 'prev' })
    })

    it('should use transform function', () => {
      const transform = (state: any) => ({ query: state.topic })
      const step = simpleStep('myAgent').from(transform).build()

      expect(step.input.ref).toBe('mapped')
    })
  })

  describe('from().to() chain', () => {
    it('should chain from and to', () => {
      const step = simpleStep('myAgent')
        .from('input')
        .to('output')

      expect(step.agent).toBe('myAgent')
      expect(step.input).toEqual({ ref: 'state', path: 'input' })
      expect(step.outputAs).toEqual({ path: 'output' })
    })
  })
})

describe('simpleBranch', () => {
  it('should create a branch with then and else', () => {
    const thenStep = simpleStep('approver').build()
    const elseStep = simpleStep('reviser').build()

    const branch = simpleBranch({
      if: (state: any) => state?.approved === true,
      then: thenStep,
      else: elseStep
    })

    expect(branch.kind).toBe('branch')
    expect(branch.then).toBe(thenStep)
    expect(branch.else).toBe(elseStep)
  })

  it('should default else to noop', () => {
    const thenStep = simpleStep('approver').build()

    const branch = simpleBranch({
      if: (state: any) => state?.approved === true,
      then: thenStep
    })

    expect(branch.else.kind).toBe('noop')
  })

  it('should support optional chaining in condition', () => {
    const branch = simpleBranch({
      if: (state: any) => (state?.review?.score ?? 0) >= 7,
      then: simpleStep('publish').build(),
      else: simpleStep('improve').build()
    })

    expect(branch.kind).toBe('branch')
  })
})

describe('simpleSeq', () => {
  it('should create a sequence of steps', () => {
    const seq = simpleSeq(
      simpleStep('step1').build(),
      simpleStep('step2').build(),
      simpleStep('step3').build()
    )

    expect(seq.kind).toBe('seq')
    expect(seq.steps).toHaveLength(3)
  })

  it('should set first step input to initial if using prev', () => {
    const seq = simpleSeq(
      simpleStep('step1').build()  // Uses prev by default
    )

    expect(seq.steps[0].kind).toBe('invoke')
    const firstStep = seq.steps[0] as any
    expect(firstStep.input).toEqual({ ref: 'initial' })
  })

  it('should preserve explicit input on first step', () => {
    const seq = simpleSeq(
      simpleStep('step1').from('custom').build()
    )

    const firstStep = seq.steps[0] as any
    expect(firstStep.input).toEqual({ ref: 'state', path: 'custom' })
  })
})

describe('simpleLoop', () => {
  it('should create a loop with until condition', () => {
    const loop = simpleLoop({
      body: simpleStep('improver').build(),
      until: (state: any) => state?.approved === true,
      maxIterations: 3
    })

    expect(loop.kind).toBe('loop')
    expect((loop as any).maxIters).toBe(3)
  })

  it('should include body flow', () => {
    const body = simpleSeq(
      simpleStep('improve').build(),
      simpleStep('review').build()
    )

    const loop = simpleLoop({
      body,
      until: (state: any) => state?.done,
      maxIterations: 5
    })

    expect((loop as any).body).toBe(body)
  })
})

describe('simpleSelect', () => {
  it('should create a select with branches', () => {
    const select = simpleSelect({
      select: (state: any) => state?.type ?? 'default',
      branches: {
        'bug': simpleStep('bugfixer').build(),
        'feature': simpleStep('developer').build()
      }
    })

    expect(select.kind).toBe('select')
    expect(Object.keys((select as any).branches)).toContain('bug')
    expect(Object.keys((select as any).branches)).toContain('feature')
  })

  it('should include default branch', () => {
    const defaultStep = simpleStep('triager').build()

    const select = simpleSelect({
      select: (state: any) => state?.type,
      branches: {
        'known': simpleStep('handler').build()
      },
      default: defaultStep
    })

    expect((select as any).default).toBe(defaultStep)
  })
})

describe('simplePar', () => {
  it('should create parallel branches', () => {
    const par = simplePar({
      branches: [
        simpleStep('worker1').build(),
        simpleStep('worker2').build(),
        simpleStep('worker3').build()
      ]
    })

    expect(par.kind).toBe('par')
    expect((par as any).branches).toHaveLength(3)
  })

  it('should use collect reducer by default', () => {
    const par = simplePar({
      branches: [
        simpleStep('worker1').build()
      ]
    })

    expect((par as any).join.reducerId).toBe('collect')
  })

  it('should support custom reducer', () => {
    const par = simplePar({
      branches: [
        simpleStep('worker1').build()
      ],
      reduce: 'merge'
    })

    expect((par as any).join.reducerId).toBe('merge')
  })

  it('should support output path', () => {
    const par = simplePar({
      branches: [
        simpleStep('worker1').build()
      ],
      to: 'results'
    })

    expect((par as any).join.outputAs).toEqual({ path: 'results' })
  })
})

describe('complex flow composition', () => {
  it('should compose a complete workflow', () => {
    const flow = simpleSeq(
      simpleStep('planner'),
      simpleStep('searcher').from('planner'),
      simpleStep('reviewer').from('searcher').to('review'),
      simpleBranch({
        if: (s: any) => s?.review?.approved === true,
        then: simpleStep('publisher').from('review'),
        else: simpleSeq(
          simpleStep('improver').from('review'),
          simpleStep('reviewer').from('improver').to('review')
        )
      }),
      simpleStep('summarizer').from('review')
    )

    expect(flow.kind).toBe('seq')
    expect(flow.steps).toHaveLength(5)
  })

  it('should compose parallel with branching', () => {
    const flow = simpleSeq(
      simplePar({
        branches: [
          simpleStep('researcher1'),
          simpleStep('researcher2')
        ],
        reduce: 'merge',
        to: 'research'
      }),
      simpleBranch({
        if: (s: any) => (s?.research?.confidence ?? 0) > 0.8,
        then: simpleStep('writer').from('research'),
        else: simpleStep('moreResearch').from('research')
      })
    )

    expect(flow.kind).toBe('seq')
    expect(flow.steps).toHaveLength(2)
  })
})
