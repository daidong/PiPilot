/**
 * Streaming-first API tests
 *
 * Verifies that AgentLoop.runStream() and AgentRunHandle.events() produce
 * the correct sequence of typed AgentEvents.
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
import type { AgentEvent } from '../../src/types/agent-event.js'
import type { ToolResult } from '../../src/types/tool.js'

// ---------------------------------------------------------------------------
// Helpers (same pattern as tool-retry-signal tests)
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
        // Simulate streaming by splitting text into chunks
        for (const char of response.text) {
          yield { type: 'text-delta', data: { text: char } } as TextDeltaEvent
        }
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

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Streaming-first API', () => {
  let env: ReturnType<typeof buildEnv>

  beforeEach(() => { env = buildEnv() })

  describe('AgentLoop.runStream()', () => {
    it('emits text-delta events for each text chunk', async () => {
      const client = createMockClient([
        { text: 'Hi!' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('hello'))

      const textDeltas = events.filter(e => e.type === 'text-delta')
      expect(textDeltas.length).toBe(3) // 'H', 'i', '!'
      expect(textDeltas.map(e => (e as any).text).join('')).toBe('Hi!')
    })

    it('emits step-start and step-finish events', async () => {
      const client = createMockClient([
        { text: 'Done.' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('hello'))

      const stepStarts = events.filter(e => e.type === 'step-start')
      const stepFinishes = events.filter(e => e.type === 'step-finish')

      expect(stepStarts.length).toBe(1)
      expect((stepStarts[0] as any).step).toBe(1)
      expect(stepFinishes.length).toBe(1)
      expect((stepFinishes[0] as any).step).toBe(1)
      expect((stepFinishes[0] as any).text).toBe('Done.')
      expect((stepFinishes[0] as any).toolCallCount).toBe(0)
    })

    it('emits tool-call and tool-result events', async () => {
      env.toolRegistry.register({
        name: 'greet',
        description: 'Say hello',
        parameters: {},
        execute: async (): Promise<ToolResult> => ({ success: true, data: 'Hello!' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'greet', args: {} }] },
        { text: 'Greeting sent.' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('greet'))

      const toolCalls = events.filter(e => e.type === 'tool-call')
      const toolResults = events.filter(e => e.type === 'tool-result')

      expect(toolCalls.length).toBe(1)
      expect((toolCalls[0] as any).tool).toBe('greet')
      expect((toolCalls[0] as any).toolCallId).toBe('tc-1')

      expect(toolResults.length).toBe(1)
      expect((toolResults[0] as any).tool).toBe('greet')
      expect((toolResults[0] as any).success).toBe(true)
      expect((toolResults[0] as any).data).toBe('Hello!')
    })

    it('emits done event with AgentRunResult', async () => {
      const client = createMockClient([
        { text: 'The answer is 42.' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('question'))

      const doneEvents = events.filter(e => e.type === 'done')
      expect(doneEvents.length).toBe(1)
      const done = doneEvents[0] as any
      expect(done.result.success).toBe(true)
      expect(done.result.output).toBe('The answer is 42.')
      expect(done.result.steps).toBe(1)
    })

    it('emits events in correct order across multiple steps', async () => {
      env.toolRegistry.register({
        name: 'calc',
        description: 'Calculate',
        parameters: {},
        execute: async (): Promise<ToolResult> => ({ success: true, data: 42 })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'calc', args: {} }] },
        { text: 'Result: 42' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('compute'))
      const types = events.map(e => e.type)

      // Expected order:
      // step-start(1) → tool-call → step-finish(1) → step-start(2) → text-deltas → step-finish(2) → done
      expect(types[0]).toBe('step-start')
      expect(types).toContain('tool-call')
      expect(types).toContain('tool-result')
      expect(types).toContain('step-finish')

      // Verify done is last
      expect(types[types.length - 1]).toBe('done')

      // Verify step ordering
      const stepStarts = events.filter(e => e.type === 'step-start').map(e => (e as any).step)
      expect(stepStarts).toEqual([1, 2])
    })

    it('emits tool-result with error info on tool failure', async () => {
      env.toolRegistry.register({
        name: 'fail-tool',
        description: 'Always fails',
        parameters: {},
        execute: async (): Promise<ToolResult> => ({ success: false, error: 'Disk full' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'fail-tool', args: {} }] },
        { text: 'Tool failed.' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10
      })

      const events = await collectEvents(loop.runStream('try'))

      const toolResults = events.filter(e => e.type === 'tool-result')
      expect(toolResults.length).toBe(1)
      expect((toolResults[0] as any).success).toBe(false)
      expect((toolResults[0] as any).error).toBe('Disk full')
    })

    it('existing callbacks still fire alongside stream events', async () => {
      const textChunks: string[] = []
      const toolCallNames: string[] = []

      env.toolRegistry.register({
        name: 'ping',
        description: 'Ping',
        parameters: {},
        execute: async (): Promise<ToolResult> => ({ success: true, data: 'pong' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'ping', args: {} }] },
        { text: 'Done' }
      ])

      const loop = new AgentLoop({
        client, toolRegistry: env.toolRegistry, runtime: env.mockRuntime,
        trace: env.trace, systemPrompt: 'Test', maxSteps: 10,
        onText: (t) => textChunks.push(t),
        onToolCall: (name) => toolCallNames.push(name)
      })

      const events = await collectEvents(loop.runStream('test'))

      // Callbacks fired
      expect(textChunks.join('')).toBe('Done')
      expect(toolCallNames).toEqual(['ping'])

      // Stream events also produced
      expect(events.some(e => e.type === 'text-delta')).toBe(true)
      expect(events.some(e => e.type === 'tool-call')).toBe(true)
    })
  })
})
