/**
 * Structured LLM Output Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  generateStructured,
  defaultRepairStrategy,
  createConsoleTracer,
  combineTracers,
  StructuredOutputError,
  type StructuredTraceEvent
} from '../../src/llm/structured.js'

// Mock the AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn(),
  Output: {
    object: vi.fn(({ schema }) => ({ schema, type: 'object-output' }))
  }
}))

import { generateText, Output } from 'ai'

describe('generateStructured', () => {
  const mockModel = {} as any

  const testSchema = z.object({
    name: z.string(),
    age: z.number()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('successful generation', () => {
    it('should generate structured output', async () => {
      const mockOutput = { name: 'John', age: 30 }

      vi.mocked(generateText).mockResolvedValueOnce({
        experimental_output: mockOutput,
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30
        },
        text: '',
        finishReason: 'stop'
      } as any)

      const result = await generateStructured({
        model: mockModel,
        system: 'You are a helpful assistant.',
        prompt: 'Extract person info',
        schema: testSchema,
        schemaName: 'PersonInfo'
      })

      expect(result.output).toEqual(mockOutput)
      expect(result.usage.totalTokens).toBe(30)
      expect(result.attempts).toBe(1)
    })

    it('should pass correct options to generateText', async () => {
      const mockOutput = { name: 'Jane', age: 25 }

      vi.mocked(generateText).mockResolvedValueOnce({
        experimental_output: mockOutput,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      } as any)

      await generateStructured({
        model: mockModel,
        system: 'System prompt',
        prompt: 'User prompt',
        schema: testSchema,
        temperature: 0.5,
        maxTokens: 1000
      })

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockModel,
          system: 'System prompt',
          prompt: 'User prompt',
          temperature: 0.5,
          maxTokens: 1000,
          experimental_output: expect.anything()
        })
      )
    })
  })

  describe('retry logic', () => {
    it('should retry on failure', async () => {
      const mockOutput = { name: 'John', age: 30 }

      vi.mocked(generateText)
        .mockRejectedValueOnce(new Error('First attempt failed'))
        .mockResolvedValueOnce({
          experimental_output: mockOutput,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
        } as any)

      const result = await generateStructured({
        model: mockModel,
        prompt: 'Test',
        schema: testSchema,
        retries: 2
      })

      expect(result.output).toEqual(mockOutput)
      expect(result.attempts).toBe(2)
      expect(generateText).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting retries', async () => {
      vi.mocked(generateText).mockRejectedValue(new Error('Always fails'))

      await expect(
        generateStructured({
          model: mockModel,
          prompt: 'Test',
          schema: testSchema,
          retries: 2
        })
      ).rejects.toThrow(StructuredOutputError)
    })
  })

  describe('tracing', () => {
    it('should call trace callback', async () => {
      const mockOutput = { name: 'John', age: 30 }
      const traceEvents: StructuredTraceEvent[] = []

      vi.mocked(generateText).mockResolvedValueOnce({
        experimental_output: mockOutput,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      } as any)

      await generateStructured({
        model: mockModel,
        prompt: 'Test',
        schema: testSchema,
        schemaName: 'TestSchema',
        onTrace: (event) => traceEvents.push(event)
      })

      expect(traceEvents.length).toBe(2)
      expect(traceEvents[0].type).toBe('structured.call.start')
      expect(traceEvents[1].type).toBe('structured.call.ok')
    })

    it('should trace failures', async () => {
      const traceEvents: StructuredTraceEvent[] = []

      vi.mocked(generateText).mockRejectedValue(new Error('Failed'))

      await expect(
        generateStructured({
          model: mockModel,
          prompt: 'Test',
          schema: testSchema,
          retries: 0,
          onTrace: (event) => traceEvents.push(event)
        })
      ).rejects.toThrow()

      expect(traceEvents.some((e) => e.type === 'structured.call.fail')).toBe(true)
    })
  })

  describe('abort signal', () => {
    it('should respect abort signal', async () => {
      const controller = new AbortController()
      controller.abort()

      // The abort error gets wrapped in StructuredOutputError
      await expect(
        generateStructured({
          model: mockModel,
          prompt: 'Test',
          schema: testSchema,
          retries: 0,
          abortSignal: controller.signal
        })
      ).rejects.toThrow(StructuredOutputError)
    })
  })
})

describe('defaultRepairStrategy', () => {
  it('should format Zod errors', () => {
    const zodError = new z.ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'number',
        path: ['name'],
        message: 'Expected string, received number'
      }
    ])

    const repair = defaultRepairStrategy.repair(zodError)

    expect(repair.prompt).toContain('Schema validation failed')
    expect(repair.prompt).toContain('"name"')
  })

  it('should handle generic errors', () => {
    const error = new Error('Something went wrong')

    const repair = defaultRepairStrategy.repair(error)

    expect(repair.prompt).toContain('Something went wrong')
  })

  it('should include raw text in repair prompt', () => {
    const error = new Error('Parse error')
    const rawText = '{ "invalid": json }'

    const repair = defaultRepairStrategy.repair(error, rawText)

    expect(repair.prompt).toContain('Your previous response was')
    expect(repair.prompt).toContain('invalid')
  })
})

describe('createConsoleTracer', () => {
  it('should create a tracer function', () => {
    const tracer = createConsoleTracer('[test]')

    expect(typeof tracer).toBe('function')
  })
})

describe('combineTracers', () => {
  it('should combine multiple tracers', () => {
    const events1: StructuredTraceEvent[] = []
    const events2: StructuredTraceEvent[] = []

    const tracer1 = (event: StructuredTraceEvent) => events1.push(event)
    const tracer2 = (event: StructuredTraceEvent) => events2.push(event)

    const combined = combineTracers(tracer1, tracer2)

    const event: StructuredTraceEvent = {
      type: 'structured.call.start',
      timestamp: Date.now(),
      attempt: 0
    }

    combined(event)

    expect(events1).toContain(event)
    expect(events2).toContain(event)
  })

  it('should handle undefined tracers', () => {
    const events: StructuredTraceEvent[] = []
    const tracer = (event: StructuredTraceEvent) => events.push(event)

    const combined = combineTracers(undefined, tracer, undefined)

    const event: StructuredTraceEvent = {
      type: 'structured.call.start',
      timestamp: Date.now(),
      attempt: 0
    }

    combined(event)

    expect(events).toContain(event)
  })
})

describe('StructuredOutputError', () => {
  it('should store cause and schema name', () => {
    const cause = new Error('Original error')
    const error = new StructuredOutputError('Failed', cause, 'TestSchema')

    expect(error.message).toBe('Failed')
    expect(error.cause).toBe(cause)
    expect(error.schemaName).toBe('TestSchema')
    expect(error.name).toBe('StructuredOutputError')
  })
})
