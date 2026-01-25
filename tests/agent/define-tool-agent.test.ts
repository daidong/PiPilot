/**
 * Tool Agent Definition Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import {
  defineToolAgent,
  isToolAgent,
  createSimpleToolAgentContext,
  definePassthroughToolAgent,
  type ToolAgentContext
} from '../../src/agent/define-tool-agent.js'
import type { Tool, ToolContext, ToolResult } from '../../src/types/tool.js'

describe('defineToolAgent', () => {
  const inputSchema = z.object({
    queries: z.array(z.string()),
    limit: z.number().optional()
  })

  const outputSchema = z.object({
    results: z.array(z.object({
      title: z.string(),
      score: z.number()
    })),
    total: z.number()
  })

  // Mock tool
  const mockTool: Tool = {
    name: 'search',
    description: 'Search tool',
    parameters: {},
    execute: vi.fn()
  }

  const mockToolContext: ToolContext = {
    runtime: {} as any,
    sessionId: 'test-session',
    step: 1,
    agentId: 'test-agent'
  }

  const createMockContext = (tool?: Tool): ToolAgentContext => ({
    getTool: (id) => (id === 'search' ? (tool ?? mockTool) : undefined),
    toolContext: mockToolContext
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('agent creation', () => {
    it('should create a tool agent with correct properties', () => {
      const agent = defineToolAgent({
        id: 'searcher',
        description: 'Search agent',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      expect(agent.id).toBe('searcher')
      expect(agent.kind).toBe('tool-agent')
      expect(agent.description).toBe('Search agent')
      expect(agent.toolId).toBe('search')
      expect(agent.inputSchema).toBe(inputSchema)
      expect(agent.outputSchema).toBe(outputSchema)
      expect(typeof agent.run).toBe('function')
    })

    it('should create agent without description', () => {
      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      expect(agent.description).toBeUndefined()
    })
  })

  describe('agent execution', () => {
    it('should execute tool and return typed output', async () => {
      const toolOutput = {
        results: [{ title: 'Result 1', score: 0.9 }],
        total: 1
      }

      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: toolOutput
      })

      const agent = defineToolAgent({
        id: 'searcher',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      const result = await agent.run(
        { queries: ['test query'] },
        createMockContext()
      )

      expect(result.success).toBe(true)
      expect(result.output).toEqual(toolOutput)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should validate input with Zod schema', async () => {
      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      // Invalid input - queries should be array of strings
      await expect(
        agent.run({ queries: 'not-an-array' } as any, createMockContext())
      ).rejects.toThrow()
    })

    it('should handle tool not found', async () => {
      const agent = defineToolAgent({
        id: 'test',
        tool: 'nonexistent-tool',
        inputSchema,
        outputSchema
      })

      const result = await agent.run(
        { queries: ['test'] },
        createMockContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Tool not found')
    })

    it('should handle tool execution failure', async () => {
      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: false,
        error: 'Tool execution failed'
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      const result = await agent.run(
        { queries: ['test'] },
        createMockContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe('Tool execution failed')
    })

    it('should handle tool execution exception', async () => {
      vi.mocked(mockTool.execute).mockRejectedValueOnce(new Error('Unexpected error'))

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema
      })

      const result = await agent.run(
        { queries: ['test'] },
        createMockContext()
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe('Unexpected error')
    })
  })

  describe('input/output transformation', () => {
    it('should transform input with buildToolInput', async () => {
      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: { results: [], total: 0 }
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema,
        buildToolInput: (input) => ({
          query: input.queries.join(' OR '),
          maxResults: input.limit ?? 10
        })
      })

      await agent.run(
        { queries: ['a', 'b'], limit: 5 },
        createMockContext()
      )

      expect(mockTool.execute).toHaveBeenCalledWith(
        { query: 'a OR b', maxResults: 5 },
        mockToolContext
      )
    })

    it('should transform output with transformOutput', async () => {
      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: {
          items: [{ name: 'Item 1', relevance: 0.9 }],
          count: 1
        }
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema,
        transformOutput: (toolOutput: any) => ({
          results: toolOutput.items.map((item: any) => ({
            title: item.name,
            score: item.relevance
          })),
          total: toolOutput.count
        })
      })

      const result = await agent.run(
        { queries: ['test'] },
        createMockContext()
      )

      expect(result.output).toEqual({
        results: [{ title: 'Item 1', score: 0.9 }],
        total: 1
      })
    })

    it('should validate transformed output against schema', async () => {
      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: { invalid: 'data' }
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema,
        transformOutput: () => ({ invalid: 'output' }) as any
      })

      await expect(
        agent.run({ queries: ['test'] }, createMockContext())
      ).rejects.toThrow()
    })
  })

  describe('pre and post processing', () => {
    it('should apply preProcess hook', async () => {
      const preProcess = vi.fn((input) => ({
        ...input,
        queries: input.queries.map((q: string) => q.toLowerCase())
      }))

      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: { results: [], total: 0 }
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema,
        preProcess
      })

      await agent.run(
        { queries: ['HELLO', 'WORLD'] },
        createMockContext()
      )

      expect(preProcess).toHaveBeenCalledWith({ queries: ['HELLO', 'WORLD'] })
      expect(mockTool.execute).toHaveBeenCalledWith(
        { queries: ['hello', 'world'] },
        mockToolContext
      )
    })

    it('should apply postProcess hook', async () => {
      const postProcess = vi.fn((output) => ({
        ...output,
        total: output.total * 2
      }))

      vi.mocked(mockTool.execute).mockResolvedValueOnce({
        success: true,
        data: { results: [], total: 5 }
      })

      const agent = defineToolAgent({
        id: 'test',
        tool: 'search',
        inputSchema,
        outputSchema,
        postProcess
      })

      const result = await agent.run(
        { queries: ['test'] },
        createMockContext()
      )

      expect(postProcess).toHaveBeenCalled()
      expect(result.output.total).toBe(10)
    })
  })
})

describe('isToolAgent', () => {
  it('should return true for tool agents', () => {
    const agent = defineToolAgent({
      id: 'test',
      tool: 'search',
      inputSchema: z.object({ input: z.string() }),
      outputSchema: z.object({ output: z.string() })
    })

    expect(isToolAgent(agent)).toBe(true)
  })

  it('should return false for non-agents', () => {
    expect(isToolAgent(null)).toBe(false)
    expect(isToolAgent(undefined)).toBe(false)
    expect(isToolAgent({})).toBe(false)
    expect(isToolAgent({ kind: 'other' })).toBe(false)
    expect(isToolAgent({ kind: 'tool-agent', id: 'test' })).toBe(false) // missing toolId
  })

  it('should return false for LLM agents', () => {
    const fakeLLMAgent = {
      kind: 'llm-agent',
      id: 'test',
      run: () => {}
    }

    expect(isToolAgent(fakeLLMAgent)).toBe(false)
  })
})

describe('createSimpleToolAgentContext', () => {
  it('should create a valid context', () => {
    const getTool = vi.fn()
    const toolContext = {} as ToolContext

    const context = createSimpleToolAgentContext(getTool, toolContext)

    expect(context.getTool).toBe(getTool)
    expect(context.toolContext).toBe(toolContext)
    expect(context.abortSignal).toBeUndefined()
  })

  it('should accept options', () => {
    const getTool = vi.fn()
    const toolContext = {} as ToolContext
    const controller = new AbortController()

    const context = createSimpleToolAgentContext(getTool, toolContext, {
      abortSignal: controller.signal
    })

    expect(context.abortSignal).toBe(controller.signal)
  })
})

describe('definePassthroughToolAgent', () => {
  it('should create a passthrough agent', () => {
    const schema = z.object({
      data: z.string()
    })

    const agent = definePassthroughToolAgent(
      'passthrough',
      'my-tool',
      schema,
      'A passthrough agent'
    )

    expect(agent.id).toBe('passthrough')
    expect(agent.toolId).toBe('my-tool')
    expect(agent.description).toBe('A passthrough agent')
    expect(agent.inputSchema).toBe(schema)
    expect(agent.outputSchema).toBe(schema)
  })

  it('should work without description', () => {
    const schema = z.object({ value: z.number() })

    const agent = definePassthroughToolAgent('test', 'tool', schema)

    expect(agent.description).toBeUndefined()
  })
})
