/**
 * Edge Combinators Tests
 */

import { describe, it, expect } from 'vitest'
import {
  mapInput,
  composeMapInput,
  branch,
  noop,
  namedNoop,
  select,
  isMappedInputRef,
  isBranchSpec,
  isNoopSpec,
  isSelectSpec,
  resolveMappedInput,
  passthrough,
  pick,
  omit,
  merge
} from '../../src/team/flow/edges.js'
import type { InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

// Local mock of state helpers for schema-free API
const state = {
  path: <T>(path: string) => ({ type: 'typed-state-ref' as const, path, _phantom: undefined as T | undefined }),
  initial: <T>() => ({ type: 'typed-initial-ref' as const, _phantom: undefined as T | undefined }),
  prev: <T>() => ({ type: 'typed-prev-ref' as const, _phantom: undefined as T | undefined })
}

// Local helpers for building AST nodes (since invoke/input are internal now)
function buildInvoke(
  agent: string,
  inputRef: InputRef,
  options?: { outputAs?: { path: string } }
): InvokeSpec {
  return { kind: 'invoke', agent, input: inputRef, outputAs: options?.outputAs }
}

const input = {
  initial: (): InputRef => ({ ref: 'initial' }),
  prev: (): InputRef => ({ ref: 'prev' }),
  state: (path: string): InputRef => ({ ref: 'state', path })
}

describe('mapInput', () => {
  it('should create a mapped input reference from state ref', () => {
    const mapped = mapInput(
      state.path<{ queries: string[] }>('plan'),
      (plan) => plan.queries
    )

    expect(mapped.type).toBe('mapped-input-ref')
    expect(mapped.source).toEqual({ type: 'typed-state-ref', path: 'plan' })
    expect(typeof mapped.transform).toBe('function')
  })

  it('should create a mapped input reference from initial ref', () => {
    const mapped = mapInput(
      state.initial<{ text: string }>(),
      (input) => input.text
    )

    expect(mapped.type).toBe('mapped-input-ref')
    expect(mapped.source).toEqual({ type: 'typed-initial-ref' })
  })

  it('should create a mapped input reference from prev ref', () => {
    const mapped = mapInput(
      state.prev<{ data: number }>(),
      (prev) => ({ value: prev.data * 2 })
    )

    expect(mapped.type).toBe('mapped-input-ref')
    expect(mapped.source).toEqual({ type: 'typed-prev-ref' })
  })

  it('should create a mapped input reference from InputRef', () => {
    const mapped = mapInput(
      input.state('myPath'),
      (value: any) => value.field
    )

    expect(mapped.type).toBe('mapped-input-ref')
    expect(mapped.source).toEqual({ ref: 'state', path: 'myPath' })
  })

  it('should work with resolveMappedInput', () => {
    const mapped = mapInput(
      state.path<{ x: number; y: number }>('point'),
      (p) => ({ sum: p.x + p.y })
    )

    const result = resolveMappedInput(mapped, () => ({ x: 10, y: 20 }))
    expect(result).toEqual({ sum: 30 })
  })
})

describe('composeMapInput', () => {
  it('should compose a single function', () => {
    const transform = composeMapInput((x: number) => x * 2)
    expect(transform(5)).toBe(10)
  })

  it('should compose two functions', () => {
    const transform = composeMapInput(
      (x: number) => x * 2,
      (x: number) => x + 1
    )
    expect(transform(5)).toBe(11)
  })

  it('should compose three functions', () => {
    const transform = composeMapInput(
      (x: number) => x * 2,
      (x: number) => x + 1,
      (x: number) => x.toString()
    )
    expect(transform(5)).toBe('11')
  })
})

describe('branch', () => {
  it('should create a branch spec', () => {
    const thenFlow = buildInvoke('agent1', input.prev())
    const elseFlow = buildInvoke('agent2', input.prev())

    const branchSpec = branch({
      when: (state: { approved: boolean }) => state.approved,
      then: thenFlow,
      else: elseFlow
    })

    expect(branchSpec.kind).toBe('branch')
    expect(branchSpec.then).toBe(thenFlow)
    expect(branchSpec.else).toBe(elseFlow)
    expect(typeof branchSpec.condition).toBe('function')
  })

  it('should include name and tags', () => {
    const branchSpec = branch({
      when: () => true,
      then: buildInvoke('a', input.prev()),
      else: noop,
      name: 'approval-check',
      tags: ['core', 'approval']
    })

    expect(branchSpec.name).toBe('approval-check')
    expect(branchSpec.tags).toEqual(['core', 'approval'])
  })

  it('should evaluate condition correctly', () => {
    const branchSpec = branch({
      when: (state: { count: number }) => state.count > 5,
      then: buildInvoke('big', input.prev()),
      else: buildInvoke('small', input.prev())
    })

    expect(branchSpec.condition({ count: 10 })).toBe(true)
    expect(branchSpec.condition({ count: 3 })).toBe(false)
  })
})

describe('noop', () => {
  it('should be a noop spec', () => {
    expect(noop.kind).toBe('noop')
    expect(noop.name).toBeUndefined()
  })

  it('namedNoop should include name', () => {
    const named = namedNoop('skip-refinement')
    expect(named.kind).toBe('noop')
    expect(named.name).toBe('skip-refinement')
  })
})

describe('select', () => {
  it('should create a select spec', () => {
    const selectSpec = select({
      selector: (state: { type: string }) => state.type,
      branches: {
        search: buildInvoke('searcher', input.prev()),
        summarize: buildInvoke('summarizer', input.prev()),
        review: buildInvoke('reviewer', input.prev())
      }
    })

    expect(selectSpec.kind).toBe('select')
    expect(Object.keys(selectSpec.branches)).toEqual(['search', 'summarize', 'review'])
    expect(typeof selectSpec.selector).toBe('function')
  })

  it('should include default branch', () => {
    const selectSpec = select({
      selector: () => 'unknown',
      branches: { a: buildInvoke('a', input.prev()) },
      default: buildInvoke('fallback', input.prev())
    })

    expect(selectSpec.default).toBeDefined()
  })

  it('should evaluate selector correctly', () => {
    const selectSpec = select({
      selector: (state: { taskType: string }) => state.taskType,
      branches: {}
    })

    expect(selectSpec.selector({ taskType: 'search' })).toBe('search')
    expect(selectSpec.selector({ taskType: 'review' })).toBe('review')
  })
})

describe('type guards', () => {
  it('isMappedInputRef', () => {
    expect(isMappedInputRef(mapInput(state.path('x'), (x) => x))).toBe(true)
    expect(isMappedInputRef(state.path('x'))).toBe(false)
    expect(isMappedInputRef(null)).toBe(false)
  })

  it('isBranchSpec', () => {
    expect(isBranchSpec(branch({
      when: () => true,
      then: buildInvoke('a', input.prev()),
      else: noop
    }))).toBe(true)
    expect(isBranchSpec(noop)).toBe(false)
    expect(isBranchSpec(null)).toBe(false)
  })

  it('isNoopSpec', () => {
    expect(isNoopSpec(noop)).toBe(true)
    expect(isNoopSpec(namedNoop('test'))).toBe(true)
    expect(isNoopSpec(buildInvoke('a', input.prev()))).toBe(false)
    expect(isNoopSpec(null)).toBe(false)
  })

  it('isSelectSpec', () => {
    expect(isSelectSpec(select({
      selector: () => 'a',
      branches: {}
    }))).toBe(true)
    expect(isSelectSpec(noop)).toBe(false)
    expect(isSelectSpec(null)).toBe(false)
  })
})

describe('transform utilities', () => {
  it('passthrough should return identity function', () => {
    const identity = passthrough<number>()
    expect(identity(42)).toBe(42)
    expect(identity(100)).toBe(100)
  })

  it('pick should select specified fields', () => {
    const picker = pick<{ a: number; b: string; c: boolean }, 'a' | 'c'>('a', 'c')
    const result = picker({ a: 1, b: 'hello', c: true })
    expect(result).toEqual({ a: 1, c: true })
  })

  it('omit should exclude specified fields', () => {
    const omitter = omit<{ a: number; b: string; c: boolean }, 'b'>('b')
    const result = omitter({ a: 1, b: 'hello', c: true })
    expect(result).toEqual({ a: 1, c: true })
  })

  it('merge should add fields', () => {
    const merger = merge({ extra: 'value' })
    const result = merger({ original: 123 })
    expect(result).toEqual({ original: 123, extra: 'value' })
  })

  it('merge should override existing fields', () => {
    const merger = merge({ a: 999 })
    const result = merger({ a: 1, b: 2 })
    expect(result).toEqual({ a: 999, b: 2 })
  })
})
