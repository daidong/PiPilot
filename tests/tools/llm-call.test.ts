/**
 * LLM Call Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { llmCall } from '../../src/tools/llm-call.js'
import type { ToolContext } from '../../src/types/tool.js'
import type { Runtime } from '../../src/types/runtime.js'
import { EventBus } from '../../src/core/event-bus.js'
import { TokenBudget } from '../../src/core/token-budget.js'

describe('llmCall', () => {
  let mockRuntime: Partial<Runtime>
  let mockContext: ToolContext
  let mockLLMClient: {
    generate: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    const eventBus = new EventBus()
    const tokenBudget = new TokenBudget({ total: 100000 })

    mockLLMClient = {
      generate: vi.fn().mockResolvedValue({
        text: 'Generated response',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30
        },
        finishReason: 'stop'
      })
    }

    mockRuntime = {
      eventBus,
      tokenBudget,
      projectPath: '/test',
      sessionId: 'test-session',
      agentId: 'test-agent',
      step: 1,
      llmClient: mockLLMClient as any
    }

    mockContext = {
      runtime: mockRuntime as Runtime,
      sessionId: 'test-session',
      step: 1,
      agentId: 'test-agent'
    }
  })

  it('should have correct name and description', () => {
    expect(llmCall.name).toBe('llm-call')
    expect(llmCall.description).toContain('LLM')
  })

  it('should have required parameters', () => {
    expect(llmCall.parameters.prompt).toBeDefined()
    expect(llmCall.parameters.prompt.required).toBe(true)
    expect(llmCall.parameters.systemPrompt).toBeDefined()
    expect(llmCall.parameters.maxTokens).toBeDefined()
  })

  it('should fail when LLM client is not available', async () => {
    const runtimeWithoutLLM = { ...mockRuntime, llmClient: undefined }
    const contextWithoutLLM = {
      ...mockContext,
      runtime: runtimeWithoutLLM as Runtime
    }

    const result = await llmCall.execute(
      { prompt: 'Test prompt' },
      contextWithoutLLM
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('LLM client not available')
  })

  it('should make successful LLM call', async () => {
    const result = await llmCall.execute(
      { prompt: 'Test prompt' },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.data?.text).toBe('Generated response')
    expect(result.data?.usage.totalTokens).toBe(30)
    expect(mockLLMClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Test prompt' }]
      })
    )
  })

  it('should use custom system prompt', async () => {
    await llmCall.execute(
      {
        prompt: 'Test prompt',
        systemPrompt: 'You are a helpful assistant.'
      },
      mockContext
    )

    expect(mockLLMClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'You are a helpful assistant.'
      })
    )
  })

  it('should respect maxTokens parameter', async () => {
    await llmCall.execute(
      { prompt: 'Test prompt', maxTokens: 500 },
      mockContext
    )

    expect(mockLLMClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 500
      })
    )
  })

  it('should add JSON instruction when jsonMode is true', async () => {
    await llmCall.execute(
      { prompt: 'Test prompt', jsonMode: true },
      mockContext
    )

    expect(mockLLMClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('JSON')
      })
    )
  })

  it('should extract JSON from markdown code blocks', async () => {
    mockLLMClient.generate.mockResolvedValueOnce({
      text: '```json\n{"key": "value"}\n```',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop'
    })

    const result = await llmCall.execute(
      { prompt: 'Return JSON', jsonMode: true },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.data?.text).toBe('{"key": "value"}')
  })

  it('should consume token budget', async () => {
    const consumeSpy = vi.spyOn(mockRuntime.tokenBudget!, 'consume')

    await llmCall.execute(
      { prompt: 'Test prompt' },
      mockContext
    )

    expect(consumeSpy).toHaveBeenCalledWith('expensive', 30)
  })

  it('should emit events', async () => {
    const emitSpy = vi.spyOn(mockRuntime.eventBus!, 'emit')

    await llmCall.execute(
      { prompt: 'Test prompt' },
      mockContext
    )

    expect(emitSpy).toHaveBeenCalledWith(
      'tool:llm-call:start',
      expect.any(Object)
    )
    expect(emitSpy).toHaveBeenCalledWith(
      'tool:llm-call:complete',
      expect.any(Object)
    )
  })

  it('should handle LLM errors gracefully', async () => {
    mockLLMClient.generate.mockRejectedValueOnce(new Error('API rate limit'))

    const result = await llmCall.execute(
      { prompt: 'Test prompt' },
      mockContext
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('API rate limit')
  })
})
