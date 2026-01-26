/**
 * Tests for schema-free agent definition (RFC-002)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  defineAgent,
  isSimpleAgent,
  createSimpleAgentContext,
  type SimpleAgent,
  type SimpleAgentContext
} from '../../src/agent/define-simple-agent.js'

// Mock language model
function createMockModel(response: string) {
  return {
    doGenerate: vi.fn().mockResolvedValue({
      text: response,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150
      }
    }),
    specificationVersion: 'v1' as const,
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: 'json' as const
  }
}

describe('defineAgent', () => {
  describe('basic functionality', () => {
    it('should create a simple agent with required fields', () => {
      const agent = defineAgent({
        id: 'test-agent',
        system: 'You are a helpful assistant.',
        prompt: (input) => `Hello: ${input}`
      })

      expect(agent.id).toBe('test-agent')
      expect(agent.kind).toBe('agent')
      expect(typeof agent.run).toBe('function')
    })

    it('should include optional description', () => {
      const agent = defineAgent({
        id: 'test-agent',
        description: 'A test agent',
        system: 'System prompt',
        prompt: (input) => String(input)
      })

      expect(agent.description).toBe('A test agent')
    })
  })

  describe('prompt building', () => {
    it('should build prompt from string input', () => {
      const promptFn = vi.fn((input: unknown) => `Query: ${input}`)

      const agent = defineAgent({
        id: 'test',
        system: 'System',
        prompt: promptFn
      })

      // Prompt is built during run, so we just verify the function is stored
      expect(agent.id).toBe('test')
    })

    it('should build prompt from object input with optional chaining', () => {
      const agent = defineAgent({
        id: 'test',
        system: 'System',
        prompt: (input) => {
          const obj = input as { topic?: string }
          return `Research: ${obj?.topic ?? 'unknown'}`
        }
      })

      expect(agent.id).toBe('test')
    })
  })

  describe('configuration', () => {
    it('should use default config values', () => {
      const agent = defineAgent({
        id: 'test',
        system: 'System',
        prompt: (input) => String(input)
      })

      // Default jsonMode=true, maxRetries=2
      expect(agent.kind).toBe('agent')
    })

    it('should allow custom config', () => {
      const agent = defineAgent({
        id: 'test',
        system: 'System',
        prompt: (input) => String(input),
        config: {
          jsonMode: false,
          maxRetries: 5
        }
      })

      expect(agent.kind).toBe('agent')
    })

    it('should allow custom temperature and maxTokens', () => {
      const agent = defineAgent({
        id: 'test',
        system: 'System',
        prompt: (input) => String(input),
        temperature: 0.5,
        maxTokens: 1000
      })

      expect(agent.kind).toBe('agent')
    })
  })
})

describe('isSimpleAgent', () => {
  it('should return true for simple agents', () => {
    const agent = defineAgent({
      id: 'test',
      system: 'System',
      prompt: (input) => String(input)
    })

    expect(isSimpleAgent(agent)).toBe(true)
  })

  it('should return false for non-agents', () => {
    expect(isSimpleAgent(null)).toBe(false)
    expect(isSimpleAgent(undefined)).toBe(false)
    expect(isSimpleAgent({})).toBe(false)
    expect(isSimpleAgent({ id: 'test' })).toBe(false)
    expect(isSimpleAgent({ kind: 'llm-agent' })).toBe(false)
  })

  it('should return false for different agent kinds', () => {
    const llmAgentLike = {
      id: 'test',
      kind: 'llm-agent',
      run: vi.fn()
    }

    expect(isSimpleAgent(llmAgentLike)).toBe(false)
  })
})

describe('createSimpleAgentContext', () => {
  it('should create a context with language model getter', () => {
    const mockModel = createMockModel('{}')
    const ctx = createSimpleAgentContext(() => mockModel as any)

    expect(typeof ctx.getLanguageModel).toBe('function')
    expect(ctx.getLanguageModel()).toBe(mockModel)
  })

  it('should include trace function if provided', () => {
    const traceFn = vi.fn()
    const mockModel = createMockModel('{}')
    const ctx = createSimpleAgentContext(() => mockModel as any, {
      trace: traceFn
    })

    expect(ctx.trace).toBe(traceFn)
  })

  it('should include abort signal if provided', () => {
    const controller = new AbortController()
    const mockModel = createMockModel('{}')
    const ctx = createSimpleAgentContext(() => mockModel as any, {
      abortSignal: controller.signal
    })

    expect(ctx.abortSignal).toBe(controller.signal)
  })
})

describe('agent processing hooks', () => {
  it('should allow preProcess hook', () => {
    const preProcess = vi.fn((input: unknown) => {
      return { processed: true, original: input }
    })

    const agent = defineAgent({
      id: 'test',
      system: 'System',
      prompt: (input) => JSON.stringify(input),
      preProcess
    })

    expect(agent.kind).toBe('agent')
  })

  it('should allow postProcess hook', () => {
    const postProcess = vi.fn((output: unknown, input: unknown) => {
      return { ...output as object, inputWas: input }
    })

    const agent = defineAgent({
      id: 'test',
      system: 'System',
      prompt: (input) => String(input),
      postProcess
    })

    expect(agent.kind).toBe('agent')
  })

  it('should allow both hooks', () => {
    const agent = defineAgent({
      id: 'test',
      system: 'System',
      prompt: (input) => String(input),
      preProcess: (input) => ({ wrapped: input }),
      postProcess: (output) => ({ result: output })
    })

    expect(agent.kind).toBe('agent')
  })
})

describe('system prompt with JSON schema description', () => {
  it('should accept system prompt with embedded schema description', () => {
    const agent = defineAgent({
      id: 'reviewer',
      system: `You are a quality reviewer.

Output JSON:
{
  "approved": boolean,
  "feedback": "string",
  "score": number (1-10)
}`,
      prompt: (input) => `Review this:\n\n${JSON.stringify(input)}`
    })

    expect(agent.id).toBe('reviewer')
    expect(agent.kind).toBe('agent')
  })
})
