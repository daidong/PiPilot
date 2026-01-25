/**
 * Extended Executor Tests - Branch, Noop, Select, Mapped Inputs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { executeFlow } from '../../src/team/flow/executor.js'
import { seq, loop } from '../../src/team/flow/combinators.js'
import { branch, noop, namedNoop, select } from '../../src/team/flow/edges.js'
import { until } from '../../src/team/flow/until.js'
import { Blackboard } from '../../src/team/state/blackboard.js'
import { createReducerRegistry, mergeReducer } from '../../src/team/flow/reducers.js'
import type { ExecutionContext, AgentInvoker } from '../../src/team/flow/executor.js'
import type { FlowSpec, BranchSpec, NoopSpec, SelectSpec, MappedInputRef, InvokeSpec, InputRef } from '../../src/team/flow/ast.js'

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
  state: (path: string): InputRef => ({ ref: 'state', path }),
  const: (value: unknown): InputRef => ({ ref: 'const', value })
}

// Helper to create mock context
function createMockContext(
  initialInput: unknown = {},
  agents: Record<string, (input: unknown) => unknown> = {}
): ExecutionContext {
  const state = new Blackboard({ namespace: 'test', storage: 'memory' })
  const reducerRegistry = createReducerRegistry()
  reducerRegistry.register('merge', mergeReducer)

  const invokeAgent: AgentInvoker = async (agentId, agentInput) => {
    const handler = agents[agentId]
    if (!handler) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    return handler(agentInput)
  }

  return {
    runId: 'test-run',
    step: 0,
    agentRegistry: { get: () => undefined, list: () => [] } as any,
    reducerRegistry,
    state,
    initialInput,
    prevOutput: initialInput,
    trace: { record: vi.fn() },
    invokeAgent,
    concurrency: 3
  }
}

describe('executeBranch', () => {
  it('should execute then branch when condition is true', async () => {
    const thenAgent = vi.fn().mockReturnValue({ result: 'then-executed' })
    const elseAgent = vi.fn().mockReturnValue({ result: 'else-executed' })

    const ctx = createMockContext({ value: 10 }, {
      'then-agent': thenAgent,
      'else-agent': elseAgent
    })

    // Set state that the condition will check
    ctx.state.put('check.value', 10, { runId: ctx.runId, trace: ctx.trace })

    const branchSpec: BranchSpec = {
      kind: 'branch',
      condition: (state: any) => state.check?.value > 5,
      then: buildInvoke('then-agent', inputRef.prev()),
      else: buildInvoke('else-agent', inputRef.prev())
    }

    const result = await executeFlow(branchSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ result: 'then-executed' })
    expect(thenAgent).toHaveBeenCalled()
    expect(elseAgent).not.toHaveBeenCalled()
  })

  it('should execute else branch when condition is false', async () => {
    const thenAgent = vi.fn().mockReturnValue({ result: 'then-executed' })
    const elseAgent = vi.fn().mockReturnValue({ result: 'else-executed' })

    const ctx = createMockContext({ value: 3 }, {
      'then-agent': thenAgent,
      'else-agent': elseAgent
    })

    ctx.state.put('check.value', 3, { runId: ctx.runId, trace: ctx.trace })

    const branchSpec: BranchSpec = {
      kind: 'branch',
      condition: (state: any) => state.check?.value > 5,
      then: buildInvoke('then-agent', inputRef.prev()),
      else: buildInvoke('else-agent', inputRef.prev())
    }

    const result = await executeFlow(branchSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ result: 'else-executed' })
    expect(thenAgent).not.toHaveBeenCalled()
    expect(elseAgent).toHaveBeenCalled()
  })

  it('should handle condition using _prev', async () => {
    const thenAgent = vi.fn().mockReturnValue({ selected: true })

    const ctx = createMockContext({}, { 'then-agent': thenAgent })
    ctx.prevOutput = { approved: true }

    const branchSpec: BranchSpec = {
      kind: 'branch',
      condition: (state: any) => state._prev?.approved === true,
      then: buildInvoke('then-agent', inputRef.prev()),
      else: { kind: 'noop' }
    }

    const result = await executeFlow(branchSpec, ctx)

    expect(result.success).toBe(true)
    expect(thenAgent).toHaveBeenCalled()
  })

  it('should record router decision trace event', async () => {
    const ctx = createMockContext({}, { 'agent': () => ({}) })
    ctx.state.put('flag', true, { runId: ctx.runId, trace: ctx.trace })

    const branchSpec: BranchSpec = {
      kind: 'branch',
      condition: (state: any) => state.flag === true,
      then: buildInvoke('agent', inputRef.prev()),
      else: { kind: 'noop' }
    }

    await executeFlow(branchSpec, ctx)

    expect(ctx.trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'router.decision',
        routerType: 'branch',
        chosen: 'then'
      })
    )
  })
})

describe('executeNoop', () => {
  it('should pass through previous output', async () => {
    const ctx = createMockContext({})
    ctx.prevOutput = { data: 'preserved' }

    const noopSpec: NoopSpec = { kind: 'noop' }

    const result = await executeFlow(noopSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ data: 'preserved' })
  })

  it('should work with named noop', async () => {
    const ctx = createMockContext({})
    ctx.prevOutput = { value: 42 }

    const noopSpec: NoopSpec = { kind: 'noop', name: 'skip-refinement' }

    const result = await executeFlow(noopSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ value: 42 })
  })

  it('should work in a branch else clause', async () => {
    const thenAgent = vi.fn().mockReturnValue({ modified: true })

    const ctx = createMockContext({}, { 'then-agent': thenAgent })
    ctx.prevOutput = { original: true }
    ctx.state.put('shouldSkip', true, { runId: ctx.runId, trace: ctx.trace })

    const branchSpec: BranchSpec = {
      kind: 'branch',
      condition: (state: any) => !state.shouldSkip,
      then: buildInvoke('then-agent', inputRef.prev()),
      else: { kind: 'noop' }
    }

    const result = await executeFlow(branchSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ original: true })
    expect(thenAgent).not.toHaveBeenCalled()
  })
})

describe('executeSelect', () => {
  it('should execute correct branch based on selector', async () => {
    const searchAgent = vi.fn().mockReturnValue({ type: 'search-result' })
    const summarizeAgent = vi.fn().mockReturnValue({ type: 'summary-result' })
    const reviewAgent = vi.fn().mockReturnValue({ type: 'review-result' })

    const ctx = createMockContext({}, {
      'search-agent': searchAgent,
      'summarize-agent': summarizeAgent,
      'review-agent': reviewAgent
    })
    ctx.state.put('taskType', 'summarize', { runId: ctx.runId, trace: ctx.trace })

    const selectSpec: SelectSpec = {
      kind: 'select',
      selector: (state: any) => state.taskType,
      branches: {
        search: buildInvoke('search-agent', inputRef.prev()),
        summarize: buildInvoke('summarize-agent', inputRef.prev()),
        review: buildInvoke('review-agent', inputRef.prev())
      }
    }

    const result = await executeFlow(selectSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ type: 'summary-result' })
    expect(summarizeAgent).toHaveBeenCalled()
    expect(searchAgent).not.toHaveBeenCalled()
    expect(reviewAgent).not.toHaveBeenCalled()
  })

  it('should use default branch when key not found', async () => {
    const defaultAgent = vi.fn().mockReturnValue({ type: 'default-result' })

    const ctx = createMockContext({}, { 'default-agent': defaultAgent })
    ctx.state.put('taskType', 'unknown', { runId: ctx.runId, trace: ctx.trace })

    const selectSpec: SelectSpec = {
      kind: 'select',
      selector: (state: any) => state.taskType,
      branches: {
        search: buildInvoke('search-agent', inputRef.prev())
      },
      default: buildInvoke('default-agent', inputRef.prev())
    }

    const result = await executeFlow(selectSpec, ctx)

    expect(result.success).toBe(true)
    expect(result.output).toEqual({ type: 'default-result' })
    expect(defaultAgent).toHaveBeenCalled()
  })

  it('should fail when key not found and no default', async () => {
    const ctx = createMockContext({})
    ctx.state.put('taskType', 'unknown', { runId: ctx.runId, trace: ctx.trace })

    const selectSpec: SelectSpec = {
      kind: 'select',
      selector: (state: any) => state.taskType,
      branches: {
        search: buildInvoke('search-agent', inputRef.prev())
      }
    }

    const result = await executeFlow(selectSpec, ctx)

    expect(result.success).toBe(false)
    expect(result.error).toContain("No branch found for selector value 'unknown'")
  })

  it('should record router decision trace event', async () => {
    const ctx = createMockContext({}, { 'agent': () => ({}) })
    ctx.state.put('mode', 'fast', { runId: ctx.runId, trace: ctx.trace })

    const selectSpec: SelectSpec = {
      kind: 'select',
      selector: (state: any) => state.mode,
      branches: {
        fast: buildInvoke('agent', inputRef.prev()),
        slow: buildInvoke('agent', inputRef.prev())
      }
    }

    await executeFlow(selectSpec, ctx)

    expect(ctx.trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'router.decision',
        routerType: 'select',
        chosen: 'fast'
      })
    )
  })
})

describe('mapped input refs', () => {
  it('should transform input from state ref', async () => {
    const agent = vi.fn().mockReturnValue({ processed: true })

    const ctx = createMockContext({}, { 'processor': agent })
    ctx.state.put('plan', { queries: ['q1', 'q2'], strategy: 'broad' }, { runId: ctx.runId, trace: ctx.trace })

    const mappedInput: MappedInputRef = {
      ref: 'mapped',
      source: { ref: 'state', path: 'plan' },
      transform: (plan: any) => ({ searchTerms: plan.queries })
    }

    const invokeSpec: FlowSpec = {
      kind: 'invoke',
      agent: 'processor',
      input: mappedInput
    }

    const result = await executeFlow(invokeSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledWith({ searchTerms: ['q1', 'q2'] })
  })

  it('should transform input from prev ref', async () => {
    const agent = vi.fn().mockReturnValue({ doubled: true })

    const ctx = createMockContext({}, { 'doubler': agent })
    ctx.prevOutput = { value: 5 }

    const mappedInput: MappedInputRef = {
      ref: 'mapped',
      source: { ref: 'prev' },
      transform: (prev: any) => ({ value: prev.value * 2 })
    }

    const invokeSpec: FlowSpec = {
      kind: 'invoke',
      agent: 'doubler',
      input: mappedInput
    }

    const result = await executeFlow(invokeSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledWith({ value: 10 })
  })

  it('should transform input from initial ref', async () => {
    const agent = vi.fn().mockReturnValue({ extracted: true })

    const ctx = createMockContext({ nested: { data: 'hello' } }, { 'extractor': agent })

    const mappedInput: MappedInputRef = {
      ref: 'mapped',
      source: { ref: 'initial' },
      transform: (initial: any) => ({ text: initial.nested.data })
    }

    const invokeSpec: FlowSpec = {
      kind: 'invoke',
      agent: 'extractor',
      input: mappedInput
    }

    const result = await executeFlow(invokeSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledWith({ text: 'hello' })
  })

  it('should chain with const ref', async () => {
    const agent = vi.fn().mockReturnValue({ merged: true })

    const ctx = createMockContext({}, { 'merger': agent })

    const mappedInput: MappedInputRef = {
      ref: 'mapped',
      source: { ref: 'const', value: { base: 100 } },
      transform: (val: any) => ({ ...val, extra: 'added' })
    }

    const invokeSpec: FlowSpec = {
      kind: 'invoke',
      agent: 'merger',
      input: mappedInput
    }

    const result = await executeFlow(invokeSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledWith({ base: 100, extra: 'added' })
  })
})

describe('business-semantic until conditions in loop', () => {
  it('should stop loop when field-eq condition is met', async () => {
    let iteration = 0
    const agent = vi.fn().mockImplementation(() => {
      iteration++
      return { iteration, approved: iteration >= 2 }
    })

    const ctx = createMockContext({}, { 'processor': agent })

    const loopSpec: FlowSpec = {
      kind: 'loop',
      body: {
        kind: 'invoke',
        agent: 'processor',
        input: { ref: 'prev' },
        outputAs: { path: 'result' }
      },
      until: { type: 'field-eq', path: 'result.approved', value: true },
      maxIters: 5
    }

    const result = await executeFlow(loopSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledTimes(2)
    expect(ctx.state.getTree('result')).toEqual({ iteration: 2, approved: true })
  })

  it('should stop loop when max-iterations is reached', async () => {
    const agent = vi.fn().mockReturnValue({ done: false })

    const ctx = createMockContext({}, { 'processor': agent })

    const loopSpec: FlowSpec = {
      kind: 'loop',
      body: {
        kind: 'invoke',
        agent: 'processor',
        input: { ref: 'prev' }
      },
      until: { type: 'max-iterations', count: 3 },
      maxIters: 10
    }

    const result = await executeFlow(loopSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledTimes(3)
  })

  it('should stop loop when any condition in until.any is met', async () => {
    let iteration = 0
    const agent = vi.fn().mockImplementation(() => {
      iteration++
      return { iteration, done: false }
    })

    const ctx = createMockContext({}, { 'processor': agent })

    const loopSpec: FlowSpec = {
      kind: 'loop',
      body: {
        kind: 'invoke',
        agent: 'processor',
        input: { ref: 'prev' },
        outputAs: { path: 'result' }
      },
      until: {
        type: 'any',
        conditions: [
          { type: 'field-eq', path: 'result.done', value: true },
          { type: 'max-iterations', count: 2 }
        ]
      },
      maxIters: 10
    }

    const result = await executeFlow(loopSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledTimes(2)
  })

  it('should continue loop until all conditions in until.all are met', async () => {
    let iteration = 0
    const agent = vi.fn().mockImplementation(() => {
      iteration++
      return {
        iteration,
        approved: iteration >= 2,
        confidence: 0.5 + (iteration * 0.2)
      }
    })

    const ctx = createMockContext({}, { 'processor': agent })

    const loopSpec: FlowSpec = {
      kind: 'loop',
      body: {
        kind: 'invoke',
        agent: 'processor',
        input: { ref: 'prev' },
        outputAs: { path: 'result' }
      },
      until: {
        type: 'all',
        conditions: [
          { type: 'field-eq', path: 'result.approved', value: true },
          { type: 'field-compare', path: 'result.confidence', comparator: 'gte', value: 0.8 }
        ]
      },
      maxIters: 10
    }

    const result = await executeFlow(loopSpec, ctx)

    expect(result.success).toBe(true)
    // iteration 2: approved=true, confidence=0.9 (both conditions met)
    expect(agent).toHaveBeenCalledTimes(2)
  })

  it('should use validator until condition', async () => {
    let iteration = 0
    const agent = vi.fn().mockImplementation(() => {
      iteration++
      return {
        issues: iteration >= 3 ? [] : [{ id: 1, resolved: false }]
      }
    })

    const ctx = createMockContext({}, { 'processor': agent })

    const issuesSchema = z.array(z.object({ id: z.number(), resolved: z.boolean() }))

    const loopSpec: FlowSpec = {
      kind: 'loop',
      body: {
        kind: 'invoke',
        agent: 'processor',
        input: { ref: 'prev' },
        outputAs: { path: 'result' }
      },
      until: {
        type: 'validator',
        path: 'result.issues',
        schema: issuesSchema,
        check: (issues: Array<{ id: number; resolved: boolean }>) => issues.length === 0
      },
      maxIters: 10
    }

    const result = await executeFlow(loopSpec, ctx)

    expect(result.success).toBe(true)
    expect(agent).toHaveBeenCalledTimes(3)
  })
})

describe('integration: branch with noop in complex flow', () => {
  it('should handle branch-noop pattern in seq', async () => {
    const searchAgent = vi.fn().mockReturnValue({ results: ['r1', 'r2'] })
    const reviewAgent = vi.fn().mockReturnValue({ approved: true })
    const refineAgent = vi.fn().mockReturnValue({ refined: true })

    const ctx = createMockContext({}, {
      'searcher': searchAgent,
      'reviewer': reviewAgent,
      'refiner': refineAgent
    })

    // Simulate a flow where we search, review, and optionally refine
    const flow: FlowSpec = seq(
      buildInvoke('searcher', inputRef.initial(), { outputAs: { path: 'search' } }),
      buildInvoke('reviewer', inputRef.state('search'), { outputAs: { path: 'review' } }),
      // Only refine if not approved
      {
        kind: 'branch',
        condition: (state: any) => state.review?.approved === false,
        then: buildInvoke('refiner', inputRef.state('search'), { outputAs: { path: 'search' } }),
        else: { kind: 'noop' }
      }
    )

    const result = await executeFlow(flow, ctx)

    expect(result.success).toBe(true)
    expect(searchAgent).toHaveBeenCalledTimes(1)
    expect(reviewAgent).toHaveBeenCalledTimes(1)
    expect(refineAgent).not.toHaveBeenCalled() // approved was true, so refine skipped
  })

  it('should execute refine when not approved', async () => {
    const searchAgent = vi.fn().mockReturnValue({ results: ['r1'] })
    const reviewAgent = vi.fn().mockReturnValue({ approved: false })
    const refineAgent = vi.fn().mockReturnValue({ refined: true })

    const ctx = createMockContext({}, {
      'searcher': searchAgent,
      'reviewer': reviewAgent,
      'refiner': refineAgent
    })

    const flow: FlowSpec = seq(
      buildInvoke('searcher', inputRef.initial(), { outputAs: { path: 'search' } }),
      buildInvoke('reviewer', inputRef.state('search'), { outputAs: { path: 'review' } }),
      {
        kind: 'branch',
        condition: (state: any) => state.review?.approved === false,
        then: buildInvoke('refiner', inputRef.state('search'), { outputAs: { path: 'search' } }),
        else: { kind: 'noop' }
      }
    )

    const result = await executeFlow(flow, ctx)

    expect(result.success).toBe(true)
    expect(refineAgent).toHaveBeenCalled()
  })
})
