/**
 * Step Builder Tests
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  step,
  isTypedInvokeSpec,
  hasSchemaInfo,
  passthrough as passthroughStep,
  pipeline as pipelineSteps
} from '../../src/team/flow/step.js'
import { state } from '../../src/team/state/typed-blackboard.js'
import { mapInput } from '../../src/team/flow/edges.js'
import type { LLMAgent } from '../../src/agent/define-llm-agent.js'
import type { ToolAgent } from '../../src/agent/define-tool-agent.js'

// Mock agents for testing
const inputSchema = z.object({ query: z.string() })
const outputSchema = z.object({ result: z.string() })

const mockLLMAgent: LLMAgent<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  id: 'test-llm-agent',
  kind: 'llm-agent',
  inputSchema,
  outputSchema,
  run: async () => ({ output: { result: 'test' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, durationMs: 0, attempts: 1 })
}

const mockToolAgent: ToolAgent<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  id: 'test-tool-agent',
  kind: 'tool-agent',
  toolId: 'test-tool',
  inputSchema,
  outputSchema,
  run: async () => ({ output: { result: 'test' }, success: true, durationMs: 0 })
}

describe('step builder', () => {
  describe('basic usage', () => {
    it('should create step with state input and output', () => {
      const spec = step(mockLLMAgent)
        .in(state.path<{ query: string }>('input'))
        .out(state.path<{ result: string }>('output'))

      expect(spec.kind).toBe('invoke')
      expect(spec.agent).toBe('test-llm-agent')
      expect(spec.input).toEqual({ ref: 'state', path: 'input' })
      expect(spec.outputAs).toEqual({ path: 'output' })
    })

    it('should create step with initial input', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial<{ query: string }>())
        .out(state.path('result'))

      expect(spec.input).toEqual({ ref: 'initial' })
    })

    it('should create step with prev input', () => {
      const spec = step(mockLLMAgent)
        .in(state.prev<{ query: string }>())
        .out(state.path('result'))

      expect(spec.input).toEqual({ ref: 'prev' })
    })

    it('should create step with const input', () => {
      const spec = step(mockLLMAgent)
        .in(state.const({ query: 'fixed query' }))
        .out(state.path('result'))

      expect(spec.input).toEqual({ ref: 'const', value: { query: 'fixed query' } })
    })
  })

  describe('build without output', () => {
    it('should create step without output storage', () => {
      const spec = step(mockLLMAgent)
        .in(state.path('input'))
        .build()

      expect(spec.kind).toBe('invoke')
      expect(spec.outputAs).toBeUndefined()
    })
  })

  describe('with mapped input', () => {
    it('should handle mapped input reference', () => {
      const mapped = mapInput(
        state.path<{ data: { query: string } }>('complex'),
        (input) => ({ query: input.data.query })
      )

      const spec = step(mockLLMAgent)
        .in(mapped)
        .out(state.path('result'))

      expect(spec.input).toMatchObject({
        ref: 'mapped',
        source: { ref: 'state', path: 'complex' }
      })
    })
  })

  describe('with options', () => {
    it('should include transfer options', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial())
        .transfer({ mode: 'minimal' })
        .out(state.path('result'))

      expect(spec.transfer).toEqual({ mode: 'minimal' })
    })

    it('should include name', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial())
        .name('Process Query')
        .out(state.path('result'))

      expect(spec.name).toBe('Process Query')
    })

    it('should include tags', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial())
        .tags('core', 'processing')
        .out(state.path('result'))

      expect(spec.tags).toEqual(['core', 'processing'])
    })

    it('should chain multiple options', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial())
        .transfer({ mode: 'full' })
        .name('My Step')
        .tags('tag1', 'tag2')
        .out(state.path('result'))

      expect(spec.transfer).toEqual({ mode: 'full' })
      expect(spec.name).toBe('My Step')
      expect(spec.tags).toEqual(['tag1', 'tag2'])
    })
  })

  describe('schema information', () => {
    it('should carry schema info from LLM agent', () => {
      const spec = step(mockLLMAgent)
        .in(state.initial())
        .out(state.path('result'))

      expect(spec._inputSchema).toBe(inputSchema)
      expect(spec._outputSchema).toBe(outputSchema)
    })

    it('should carry schema info from tool agent', () => {
      const spec = step(mockToolAgent)
        .in(state.initial())
        .out(state.path('result'))

      expect(spec._inputSchema).toBe(inputSchema)
      expect(spec._outputSchema).toBe(outputSchema)
    })
  })

  describe('with tool agent', () => {
    it('should work with tool agent', () => {
      const spec = step(mockToolAgent)
        .in(state.path('toolInput'))
        .out(state.path('toolOutput'))

      expect(spec.kind).toBe('invoke')
      expect(spec.agent).toBe('test-tool-agent')
    })
  })
})

describe('isTypedInvokeSpec', () => {
  it('should return true for typed invoke specs', () => {
    const spec = step(mockLLMAgent)
      .in(state.initial())
      .out(state.path('result'))

    expect(isTypedInvokeSpec(spec)).toBe(true)
  })

  it('should return false for non-invoke specs', () => {
    expect(isTypedInvokeSpec(null)).toBe(false)
    expect(isTypedInvokeSpec({})).toBe(false)
    expect(isTypedInvokeSpec({ kind: 'seq' })).toBe(false)
  })
})

describe('hasSchemaInfo', () => {
  it('should return true when spec has schemas', () => {
    const spec = step(mockLLMAgent)
      .in(state.initial())
      .build()

    expect(hasSchemaInfo(spec)).toBe(true)
  })

  it('should return false when spec has no schemas', () => {
    const spec = {
      kind: 'invoke' as const,
      agent: 'test',
      input: { ref: 'initial' as const }
    }

    expect(hasSchemaInfo(spec)).toBe(false)
  })
})

describe('passthroughStep', () => {
  it('should create a passthrough step', () => {
    const spec = passthroughStep(
      state.path<string>('input'),
      state.path<string>('output')
    )

    expect(spec.kind).toBe('invoke')
    expect(spec.agent).toBe('__passthrough__')
    expect(spec.input).toEqual({ ref: 'state', path: 'input' })
    expect(spec.outputAs).toEqual({ path: 'output' })
  })
})

describe('pipelineSteps', () => {
  it('should create empty array for no agents', () => {
    const steps = pipelineSteps(
      [],
      state.initial<{ query: string }>()
    )

    expect(steps).toEqual([])
  })

  it('should create single step for one agent', () => {
    const steps = pipelineSteps(
      [mockLLMAgent],
      state.initial<{ query: string }>()
    )

    expect(steps.length).toBe(1)
    expect(steps[0].agent).toBe('test-llm-agent')
    expect(steps[0].input).toEqual({ ref: 'initial' })
  })

  it('should create pipeline with prev() connections', () => {
    const agent2 = { ...mockLLMAgent, id: 'agent-2' }
    const agent3 = { ...mockLLMAgent, id: 'agent-3' }

    const steps = pipelineSteps(
      [mockLLMAgent, agent2, agent3],
      state.initial<{ query: string }>()
    )

    expect(steps.length).toBe(3)
    expect(steps[0].input).toEqual({ ref: 'initial' })
    expect(steps[1].input).toEqual({ ref: 'prev' })
    expect(steps[2].input).toEqual({ ref: 'prev' })
  })

  it('should output to final state path when specified', () => {
    const agent2 = { ...mockLLMAgent, id: 'agent-2' }

    const steps = pipelineSteps(
      [mockLLMAgent, agent2],
      state.initial<{ query: string }>(),
      state.path<{ result: string }>('finalResult')
    )

    expect(steps.length).toBe(2)
    expect(steps[0].outputAs).toBeUndefined()
    expect(steps[1].outputAs).toEqual({ path: 'finalResult' })
  })

  it('should output single agent to final state path', () => {
    const steps = pipelineSteps(
      [mockLLMAgent],
      state.initial<{ query: string }>(),
      state.path<{ result: string }>('result')
    )

    expect(steps.length).toBe(1)
    expect(steps[0].outputAs).toEqual({ path: 'result' })
  })
})
