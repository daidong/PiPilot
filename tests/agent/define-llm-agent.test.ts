/**
 * LLM Agent Definition Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  defineLLMAgent,
  isLLMAgent,
  createSimpleLLMAgentContext,
  createModelContext,
  type LLMAgentContext
} from '../../src/agent/define-llm-agent.js'

// Mock generateStructured
vi.mock('../../src/llm/structured.js', () => ({
  generateStructured: vi.fn()
}))

import { generateStructured } from '../../src/llm/structured.js'

describe('defineLLMAgent', () => {
  const inputSchema = z.object({
    text: z.string(),
    maxLength: z.number().optional()
  })

  const outputSchema = z.object({
    summary: z.string(),
    keyPoints: z.array(z.string())
  })

  const mockModel = {} as any

  const createMockContext = (): LLMAgentContext => ({
    getLanguageModel: () => mockModel
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('agent creation', () => {
    it('should create an LLM agent with correct properties', () => {
      const agent = defineLLMAgent({
        id: 'summarizer',
        description: 'Summarizes text',
        inputSchema,
        outputSchema,
        system: 'You are a text summarizer.',
        buildPrompt: ({ text }) => `Summarize: ${text}`
      })

      expect(agent.id).toBe('summarizer')
      expect(agent.kind).toBe('llm-agent')
      expect(agent.description).toBe('Summarizes text')
      expect(agent.inputSchema).toBe(inputSchema)
      expect(agent.outputSchema).toBe(outputSchema)
      expect(typeof agent.run).toBe('function')
    })

    it('should create agent without description', () => {
      const agent = defineLLMAgent({
        id: 'test-agent',
        inputSchema,
        outputSchema,
        system: 'System prompt',
        buildPrompt: ({ text }) => text
      })

      expect(agent.description).toBeUndefined()
    })
  })

  describe('agent execution', () => {
    it('should execute and return typed output', async () => {
      const mockOutput = {
        summary: 'A short summary',
        keyPoints: ['Point 1', 'Point 2']
      }

      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: mockOutput,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        attempts: 1,
        durationMs: 100
      })

      const agent = defineLLMAgent({
        id: 'summarizer',
        inputSchema,
        outputSchema,
        system: 'You are a summarizer.',
        buildPrompt: ({ text }) => `Summarize: ${text}`
      })

      const result = await agent.run(
        { text: 'Long text to summarize' },
        createMockContext()
      )

      expect(result.output).toEqual(mockOutput)
      expect(result.usage.totalTokens).toBe(30)
      expect(result.attempts).toBe(1)
    })

    it('should validate input with Zod schema', async () => {
      const agent = defineLLMAgent({
        id: 'test',
        inputSchema,
        outputSchema,
        system: 'System',
        buildPrompt: () => 'Prompt'
      })

      // Invalid input - missing required field
      await expect(
        agent.run({ maxLength: 100 } as any, createMockContext())
      ).rejects.toThrow()
    })

    it('should call generateStructured with correct options', async () => {
      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: { summary: 'test', keyPoints: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        attempts: 1,
        durationMs: 0
      })

      const agent = defineLLMAgent({
        id: 'test',
        model: 'gpt-4o',
        temperature: 0.5,
        maxTokens: 1000,
        retries: 3,
        inputSchema,
        outputSchema,
        system: 'System prompt',
        buildPrompt: ({ text }) => `Process: ${text}`
      })

      await agent.run({ text: 'Hello' }, createMockContext())

      expect(generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockModel,
          system: 'System prompt',
          prompt: 'Process: Hello',
          schema: outputSchema,
          schemaName: 'testOutput',
          temperature: 0.5,
          maxTokens: 1000,
          retries: 3
        })
      )
    })
  })

  describe('pre and post processing', () => {
    it('should apply preProcess hook', async () => {
      const preProcess = vi.fn((input) => ({
        ...input,
        text: input.text.toUpperCase()
      }))

      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: { summary: 'test', keyPoints: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        attempts: 1,
        durationMs: 0
      })

      const agent = defineLLMAgent({
        id: 'test',
        inputSchema,
        outputSchema,
        system: 'System',
        buildPrompt: ({ text }) => text,
        preProcess
      })

      await agent.run({ text: 'hello' }, createMockContext())

      expect(preProcess).toHaveBeenCalledWith({ text: 'hello' })
      expect(generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'HELLO'
        })
      )
    })

    it('should apply postProcess hook', async () => {
      const postProcess = vi.fn((output) => ({
        ...output,
        summary: output.summary.toUpperCase()
      }))

      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: { summary: 'test', keyPoints: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        attempts: 1,
        durationMs: 0
      })

      const agent = defineLLMAgent({
        id: 'test',
        inputSchema,
        outputSchema,
        system: 'System',
        buildPrompt: ({ text }) => text,
        postProcess
      })

      const result = await agent.run({ text: 'hello' }, createMockContext())

      expect(postProcess).toHaveBeenCalled()
      expect(result.output.summary).toBe('TEST')
    })
  })

  describe('context usage', () => {
    it('should use model from context', async () => {
      const specificModel = { modelId: 'specific' } as any
      const context: LLMAgentContext = {
        getLanguageModel: (modelId) => {
          if (modelId === 'gpt-4o') return specificModel
          return mockModel
        }
      }

      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: { summary: 'test', keyPoints: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        attempts: 1,
        durationMs: 0
      })

      const agent = defineLLMAgent({
        id: 'test',
        model: 'gpt-4o',
        inputSchema,
        outputSchema,
        system: 'System',
        buildPrompt: () => 'Prompt'
      })

      await agent.run({ text: 'test' }, context)

      expect(generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          model: specificModel
        })
      )
    })

    it('should pass trace and abort signal to generateStructured', async () => {
      const trace = vi.fn()
      const controller = new AbortController()

      vi.mocked(generateStructured).mockResolvedValueOnce({
        output: { summary: 'test', keyPoints: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        attempts: 1,
        durationMs: 0
      })

      const agent = defineLLMAgent({
        id: 'test',
        inputSchema,
        outputSchema,
        system: 'System',
        buildPrompt: () => 'Prompt'
      })

      await agent.run({ text: 'test' }, {
        getLanguageModel: () => mockModel,
        trace,
        abortSignal: controller.signal
      })

      expect(generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          onTrace: trace,
          abortSignal: controller.signal
        })
      )
    })
  })
})

describe('isLLMAgent', () => {
  it('should return true for LLM agents', () => {
    const agent = defineLLMAgent({
      id: 'test',
      inputSchema: z.object({ input: z.string() }),
      outputSchema: z.object({ output: z.string() }),
      system: 'System',
      buildPrompt: ({ input }) => input
    })

    expect(isLLMAgent(agent)).toBe(true)
  })

  it('should return false for non-agents', () => {
    expect(isLLMAgent(null)).toBe(false)
    expect(isLLMAgent(undefined)).toBe(false)
    expect(isLLMAgent({})).toBe(false)
    expect(isLLMAgent({ kind: 'other' })).toBe(false)
    expect(isLLMAgent({ kind: 'llm-agent', id: 'test' })).toBe(false) // missing run
  })

  it('should return false for tool agents', () => {
    const fakeToolAgent = {
      kind: 'tool-agent',
      id: 'test',
      run: () => {}
    }

    expect(isLLMAgent(fakeToolAgent)).toBe(false)
  })
})

describe('createSimpleLLMAgentContext', () => {
  it('should create a valid context', () => {
    const mockModel = {} as any
    const getLanguageModel = () => mockModel

    const context = createSimpleLLMAgentContext(getLanguageModel)

    expect(context.getLanguageModel()).toBe(mockModel)
    expect(context.trace).toBeUndefined()
    expect(context.abortSignal).toBeUndefined()
  })

  it('should accept options', () => {
    const mockModel = {} as any
    const trace = vi.fn()
    const controller = new AbortController()

    const context = createSimpleLLMAgentContext(
      () => mockModel,
      { trace, abortSignal: controller.signal }
    )

    expect(context.trace).toBe(trace)
    expect(context.abortSignal).toBe(controller.signal)
  })
})

describe('createModelContext', () => {
  it('should create a context with a specific model', () => {
    const mockModel = { id: 'test-model' } as any

    const context = createModelContext(mockModel)

    expect(context.getLanguageModel()).toBe(mockModel)
    expect(context.getLanguageModel('any-id')).toBe(mockModel)
  })
})
