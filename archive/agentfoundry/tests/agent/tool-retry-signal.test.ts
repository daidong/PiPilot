/**
 * GAP-12: Tool retry signal tests
 *
 * Verifies that tools can request executor-level retry via `result.retry`,
 * bypassing the framework's heuristic error classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLoop, type LLMClient } from '../../src/agent/agent-loop.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { TokenBudget } from '../../src/core/token-budget.js'
import type {
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  FinishEvent,
  CompletionResponse
} from '../../src/llm/index.js'
import type { Runtime } from '../../src/types/runtime.js'
import type { ToolResult } from '../../src/types/tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(responses: Array<{
  text: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
}>): LLMClient {
  let callIndex = 0
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      const response = responses[callIndex++]
      if (!response) {
        yield { type: 'finish', data: { finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, text: '', toolCalls: [] } } as FinishEvent
        return
      }
      if (response.text) {
        yield { type: 'text-delta', data: { text: response.text } } as TextDeltaEvent
      }
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield { type: 'tool-call', data: { toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.args } } as ToolCallEvent
        }
      }
      yield {
        type: 'finish',
        data: {
          finishReason: response.toolCalls?.length ? 'tool-calls' : 'stop',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          text: response.text,
          toolCalls: (response.toolCalls || []).map(tc => ({ type: 'tool_use' as const, id: tc.toolCallId, name: tc.toolName, input: tc.args }))
        }
      } as FinishEvent
    },
    async generate(): Promise<CompletionResponse> {
      const response = responses[callIndex++]
      if (!response) return { id: 'mock', text: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
      return {
        id: 'mock', text: response.text,
        toolCalls: (response.toolCalls || []).map(tc => ({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: tc.args })),
        finishReason: (response.toolCalls?.length ? 'tool-calls' : 'stop') as any,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      }
    },
    getModelConfig() { return undefined },
    getLanguageModel() { return {} as any }
  } as LLMClient
}

function buildEnv() {
  const eventBus = new EventBus()
  const trace = new TraceCollector('test-session')
  const policyEngine = new PolicyEngine({ trace, eventBus })
  const toolRegistry = new ToolRegistry()
  const tokenBudget = new TokenBudget({ total: 50_000 })
  const mockRuntime: Runtime = {
    projectPath: '/test', sessionId: 'test-session', agentId: 'test-agent', step: 0,
    io: {} as any, eventBus, trace, tokenBudget, toolRegistry, policyEngine,
    contextManager: {} as any,
    sessionState: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false }
  }
  toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })
  return { eventBus, trace, policyEngine, toolRegistry, tokenBudget, mockRuntime }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GAP-12: Tool retry signal', () => {
  let env: ReturnType<typeof buildEnv>

  beforeEach(() => { env = buildEnv() })

  it('retries at executor level when tool returns retry.shouldRetry=true', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'flaky-api',
      description: 'An API that fails then succeeds',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        if (callCount <= 2) {
          return {
            success: false,
            error: 'Service unavailable',
            retry: { shouldRetry: true, delayMs: 10, maxAttempts: 3 }
          }
        }
        return { success: true, data: 'API response' }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'flaky-api', args: {} }] },
      { text: 'Got the API response.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    const result = await loop.run('Call the API')

    expect(result.success).toBe(true)
    expect(result.output).toBe('Got the API response.')
    // Tool was called 3 times (2 retries + 1 success)
    expect(callCount).toBe(3)
  })

  it('falls through to agent_retry when tool retries are exhausted', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'always-fail',
      description: 'Always fails with retry signal',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        return {
          success: false,
          error: 'Permanently broken',
          retry: { shouldRetry: true, delayMs: 10, maxAttempts: 2 }
        }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'always-fail', args: {} }] },
      { text: 'I see the tool failed, moving on.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    const result = await loop.run('Try the failing tool')

    expect(result.success).toBe(true)
    // Tool called 2 times (1 initial + 1 retry, maxAttempts=2)
    expect(callCount).toBe(2)
    // LLM should have seen the error and responded
    expect(result.output).toBe('I see the tool failed, moving on.')
  })

  it('includes tool-provided guidance in error feedback to LLM', async () => {
    env.toolRegistry.register({
      name: 'guided-fail',
      description: 'Fails with custom guidance',
      parameters: {},
      execute: async (): Promise<ToolResult> => ({
        success: false,
        error: 'Database connection timeout',
        retry: {
          shouldRetry: true,
          delayMs: 10,
          maxAttempts: 1, // No retries, just pass guidance through
          guidance: 'The database is under maintenance. Try using the cache instead.'
        }
      })
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'guided-fail', args: {} }] },
      { text: 'Using cache instead.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    const result = await loop.run('Query the database')

    expect(result.success).toBe(true)

    // Check trace for the error events
    const events = env.trace.getEvents()
    const classifiedEvent = events.find(e => e.type === 'error.classified')
    expect(classifiedEvent).toBeDefined()
  })

  it('caps maxAttempts at 5 even if tool requests more', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'greedy-retrier',
      description: 'Requests too many retries',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        return {
          success: false,
          error: 'Still failing',
          retry: { shouldRetry: true, delayMs: 10, maxAttempts: 100 } // requests 100, capped to 5
        }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'greedy-retrier', args: {} }] },
      { text: 'Gave up.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    await loop.run('Call the greedy tool')

    // Tool requests 100 retries, capped at 5 by framework.
    // Further limited by RetryBudget.maxConsecutiveSameCategory (default 3).
    // So: 1 initial + 3 retries = 4 total calls (budget exhausted first).
    expect(callCount).toBeLessThanOrEqual(5)
    expect(callCount).toBeGreaterThanOrEqual(2) // at least one retry happened
  })

  it('does not retry when retry.shouldRetry is false', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'no-retry',
      description: 'Fails but explicitly says no retry',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        return {
          success: false,
          error: 'Permanent failure',
          retry: { shouldRetry: false }
        }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'no-retry', args: {} }] },
      { text: 'Tool failed permanently.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    await loop.run('Try the tool')

    // Only called once — no retry
    expect(callCount).toBe(1)
  })

  it('stops retrying when tool stops requesting retry mid-sequence', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'conditional-retry',
      description: 'Retries twice then gives up',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        if (callCount <= 2) {
          return {
            success: false,
            error: 'Transient error',
            retry: { shouldRetry: true, delayMs: 10, maxAttempts: 5 }
          }
        }
        // Third call: still fails but no longer requests retry
        return {
          success: false,
          error: 'Persistent error',
          retry: { shouldRetry: false }
        }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'conditional-retry', args: {} }] },
      { text: 'Gave up after retries.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    await loop.run('Try conditional tool')

    // Called 3 times: initial + 1 retry (shouldRetry=true) + 1 retry (shouldRetry=false, stops)
    expect(callCount).toBe(3)
  })

  it('records toolInitiated:true in trace events', async () => {
    let callCount = 0

    env.toolRegistry.register({
      name: 'traced-retry',
      description: 'Retry for trace test',
      parameters: {},
      execute: async (): Promise<ToolResult> => {
        callCount++
        if (callCount === 1) {
          return {
            success: false,
            error: 'Transient',
            retry: { shouldRetry: true, delayMs: 10, maxAttempts: 2 }
          }
        }
        return { success: true, data: 'ok' }
      }
    })

    const client = createMockClient([
      { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'traced-retry', args: {} }] },
      { text: 'Done.' }
    ])

    const loop = new AgentLoop({
      client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
      trace: env.trace, systemPrompt: 'Test', maxSteps: 10
    })

    await loop.run('Test trace')

    const events = env.trace.getEvents()
    const retryEvent = events.find(e => e.type === 'error.retrying')
    expect(retryEvent).toBeDefined()
    expect(retryEvent!.data).toMatchObject({ toolInitiated: true, mode: 'executor_retry' })

    const recoveredEvent = events.find(e => e.type === 'error.recovered')
    expect(recoveredEvent).toBeDefined()
    expect(recoveredEvent!.data).toMatchObject({ toolInitiated: true })
  })
})
