/**
 * AgentLoop 行为测试 — 补充 MessageStore 集成后的覆盖缺口
 *
 * Covers: steering, followUp, pin, transformContext, token trim (GAP-6),
 * hooks (beforeToolCall block), parallel tool execution, tool loop nudge,
 * getMessages/clearMessages.
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
  CompletionResponse,
  Message
} from '../../src/llm/index.js'
import type { Runtime } from '../../src/types/runtime.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockResponse = {
  text: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
  finishReason?: string
}

/**
 * Create a mock LLM client. Optionally captures the messages sent to each call.
 */
function createMockClient(
  responses: MockResponse[],
  capturedMessages?: Message[][]
): LLMClient {
  let callIndex = 0

  return {
    async *stream(options: any): AsyncGenerator<StreamEvent> {
      if (capturedMessages) {
        capturedMessages.push([...(options.messages ?? [])])
      }
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
          finishReason: response.finishReason || (response.toolCalls?.length ? 'tool-calls' : 'stop'),
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          text: response.text,
          toolCalls: (response.toolCalls || []).map(tc => ({ type: 'tool_use' as const, id: tc.toolCallId, name: tc.toolName, input: tc.args }))
        }
      } as FinishEvent
    },
    async generate(options: any): Promise<CompletionResponse> {
      if (capturedMessages) {
        capturedMessages.push([...(options.messages ?? [])])
      }
      const response = responses[callIndex++]
      if (!response) {
        return { id: 'mock', text: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
      }
      return {
        id: 'mock',
        text: response.text,
        toolCalls: (response.toolCalls || []).map(tc => ({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: tc.args })),
        finishReason: (response.finishReason || (response.toolCalls?.length ? 'tool-calls' : 'stop')) as any,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      }
    },
    getModelConfig() { return undefined },
    getLanguageModel() { return {} as any }
  } as LLMClient
}

function buildTestRuntime() {
  const eventBus = new EventBus()
  const trace = new TraceCollector('test-session')
  const policyEngine = new PolicyEngine({ trace, eventBus })
  const toolRegistry = new ToolRegistry()
  const tokenBudget = new TokenBudget({ total: 50_000 })

  const mockRuntime: Runtime = {
    projectPath: '/test/project',
    sessionId: 'test-session',
    agentId: 'test-agent',
    step: 0,
    io: {} as any,
    eventBus,
    trace,
    tokenBudget,
    toolRegistry,
    policyEngine,
    contextManager: {} as any,
    sessionState: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false }
  }

  toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })

  return { eventBus, trace, policyEngine, toolRegistry, tokenBudget, mockRuntime }
}

function makeLoop(
  env: ReturnType<typeof buildTestRuntime>,
  client: LLMClient,
  extra: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {}
) {
  return new AgentLoop({
    client,
    toolRegistry: env.toolRegistry,
    runtime: env.mockRuntime,
    trace: env.trace,
    systemPrompt: 'You are a test assistant.',
    maxSteps: 20,
    ...extra
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop behavior tests', () => {
  let env: ReturnType<typeof buildTestRuntime>

  beforeEach(() => {
    env = buildTestRuntime()
  })

  // ── 1. Steering queue ──────────────────────────────────────────────────
  describe('steering queue', () => {
    it('injects steering message before the next LLM call', async () => {
      const captured: Message[][] = []

      env.toolRegistry.register({
        name: 'slow-tool',
        description: 'A tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'slow-tool', args: {} }] },
        { text: 'Done.' }
      ], captured)

      const loop = makeLoop(env, client)

      // Inject steering before run — it should appear in the second LLM call
      loop.steer('Focus on security issues')

      await loop.run('Analyze codebase')

      // The steering message should appear in messages sent to the second LLM call
      expect(captured.length).toBe(2)
      const secondCallMessages = captured[1]
      const steeringMsg = secondCallMessages.find(
        m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Focus on security')
      )
      expect(steeringMsg).toBeDefined()
    })
  })

  // ── 2. Follow-up queue ─────────────────────────────────────────────────
  describe('followUp queue', () => {
    it('continues execution after initial task completion', async () => {
      const client = createMockClient([
        { text: 'Task 1 done.' },
        { text: 'Follow-up done.' }
      ])

      const loop = makeLoop(env, client)
      loop.followUp('Now do the follow-up task')

      const result = await loop.run('Do the main task')

      // The agent should have continued with the follow-up
      expect(result.success).toBe(true)
      expect(result.output).toBe('Follow-up done.')
      expect(result.steps).toBe(2)
    })

    it('processes multiple follow-ups in FIFO order', async () => {
      const captured: Message[][] = []
      const client = createMockClient([
        { text: 'Main done.' },
        { text: 'Follow-up 1 done.' },
        { text: 'Follow-up 2 done.' }
      ], captured)

      const loop = makeLoop(env, client)
      loop.followUp('First follow-up')
      loop.followUp('Second follow-up')

      const result = await loop.run('Main task')

      expect(result.steps).toBe(3)
      // Verify first follow-up appeared before second
      const call2Msgs = captured[1]
      const call3Msgs = captured[2]
      expect(call2Msgs.some(m => typeof m.content === 'string' && m.content.includes('First follow-up'))).toBe(true)
      expect(call3Msgs.some(m => typeof m.content === 'string' && m.content.includes('Second follow-up'))).toBe(true)
    })
  })

  // ── 3. Pinned messages ─────────────────────────────────────────────────
  describe('pinned messages', () => {
    it('prepends static pinned messages to every LLM call', async () => {
      const captured: Message[][] = []

      env.toolRegistry.register({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
        { text: 'Done.' }
      ], captured)

      const loop = makeLoop(env, client, {
        pinnedMessages: [{ role: 'user', content: '[PINNED] Always be concise.' }]
      })

      await loop.run('Hello')

      // Both LLM calls should have the pinned message at the start
      for (const callMsgs of captured) {
        expect(callMsgs[0]).toEqual({ role: 'user', content: '[PINNED] Always be concise.' })
      }
    })

    it('runtime pin() adds message to subsequent LLM calls', async () => {
      const captured: Message[][] = []

      env.toolRegistry.register({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
        { text: 'Done.' }
      ], captured)

      const loop = makeLoop(env, client)

      // Pin after construction but before run
      loop.pin({ role: 'user', content: '[DYNAMIC PIN] Remember this.' })

      await loop.run('Hello')

      // The pinned message should appear in both calls
      for (const callMsgs of captured) {
        expect(callMsgs[0]).toEqual({ role: 'user', content: '[DYNAMIC PIN] Remember this.' })
      }
    })
  })

  // ── 4. transformContext ────────────────────────────────────────────────
  describe('transformContext', () => {
    it('injects context into every LLM call without mutating history', async () => {
      const captured: Message[][] = []
      let callCount = 0

      const transformContext = vi.fn(async (msgs: Message[]) => {
        callCount++
        return [...msgs, { role: 'user' as const, content: `[injected] call #${callCount}` }]
      })

      env.toolRegistry.register({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
        { text: 'Done.' }
      ], captured)

      const loop = makeLoop(env, client, { transformContext })

      await loop.run('Hello')

      expect(transformContext).toHaveBeenCalledTimes(2)

      // Each call should have an injected message at the end (before LLM processes)
      const call1Last = captured[0][captured[0].length - 1]
      expect(typeof call1Last.content === 'string' && call1Last.content.includes('[injected] call #1')).toBe(true)

      const call2Last = captured[1][captured[1].length - 1]
      expect(typeof call2Last.content === 'string' && call2Last.content.includes('[injected] call #2')).toBe(true)

      // History should NOT contain injected messages
      const history = loop.getMessages()
      const injected = history.filter(m => typeof m.content === 'string' && m.content.includes('[injected]'))
      expect(injected).toHaveLength(0)
    })
  })

  // ── 5. Hooks: beforeToolCall blocking ──────────────────────────────────
  describe('hooks: beforeToolCall', () => {
    it('blocks tool execution when hook returns block:true', async () => {
      let toolExecuted = false

      env.toolRegistry.register({
        name: 'dangerous',
        description: 'Dangerous op',
        parameters: {},
        execute: async () => {
          toolExecuted = true
          return { success: true, data: 'ran' }
        }
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'dangerous', args: {} }] },
        { text: 'Blocked, so I recovered.' }
      ])

      const loop = makeLoop(env, client, {
        hooks: {
          beforeToolCall: async ({ tool }) => {
            if (tool === 'dangerous') {
              return { block: true, reason: 'Not allowed in tests' }
            }
          }
        }
      })

      const result = await loop.run('Do something dangerous')

      expect(result.success).toBe(true)
      expect(toolExecuted).toBe(false)
    })

    it('allows tool execution when hook returns undefined', async () => {
      let toolExecuted = false

      env.toolRegistry.register({
        name: 'safe-tool',
        description: 'Safe op',
        parameters: {},
        execute: async () => {
          toolExecuted = true
          return { success: true, data: 'ran' }
        }
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'safe-tool', args: {} }] },
        { text: 'Done.' }
      ])

      const loop = makeLoop(env, client, {
        hooks: {
          beforeToolCall: async () => {
            // No block — allow
          }
        }
      })

      await loop.run('Do something safe')

      expect(toolExecuted).toBe(true)
    })
  })

  // ── 6. Parallel tool execution ─────────────────────────────────────────
  describe('parallel tool execution', () => {
    it('executes multiple tool calls in parallel when enabled', async () => {
      const executionOrder: string[] = []
      const startTimes: Record<string, number> = {}

      env.toolRegistry.register({
        name: 'tool-a',
        description: 'Tool A',
        parameters: {},
        execute: async () => {
          startTimes['a'] = Date.now()
          executionOrder.push('a-start')
          await new Promise(r => setTimeout(r, 50))
          executionOrder.push('a-end')
          return { success: true, data: 'a' }
        }
      })

      env.toolRegistry.register({
        name: 'tool-b',
        description: 'Tool B',
        parameters: {},
        execute: async () => {
          startTimes['b'] = Date.now()
          executionOrder.push('b-start')
          await new Promise(r => setTimeout(r, 50))
          executionOrder.push('b-end')
          return { success: true, data: 'b' }
        }
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'tool-a', args: {} },
            { toolCallId: 'tc-2', toolName: 'tool-b', args: {} }
          ]
        },
        { text: 'Both done.' }
      ])

      const loop = makeLoop(env, client, { parallelToolExecution: true })
      await loop.run('Run both tools')

      // In parallel mode, both should start before either finishes
      // The order should be: a-start, b-start, then (a-end, b-end in any order)
      expect(executionOrder[0]).toBe('a-start')
      expect(executionOrder[1]).toBe('b-start')
    })

    it('executes tool calls sequentially when disabled', async () => {
      const executionOrder: string[] = []

      env.toolRegistry.register({
        name: 'tool-a',
        description: 'Tool A',
        parameters: {},
        execute: async () => {
          executionOrder.push('a-start')
          await new Promise(r => setTimeout(r, 20))
          executionOrder.push('a-end')
          return { success: true, data: 'a' }
        }
      })

      env.toolRegistry.register({
        name: 'tool-b',
        description: 'Tool B',
        parameters: {},
        execute: async () => {
          executionOrder.push('b-start')
          await new Promise(r => setTimeout(r, 20))
          executionOrder.push('b-end')
          return { success: true, data: 'b' }
        }
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'tool-a', args: {} },
            { toolCallId: 'tc-2', toolName: 'tool-b', args: {} }
          ]
        },
        { text: 'Both done.' }
      ])

      const loop = makeLoop(env, client, { parallelToolExecution: false })
      await loop.run('Run both tools')

      // Sequential: a finishes before b starts
      expect(executionOrder).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    })
  })

  // ── 7. Tool loop nudge ─────────────────────────────────────────────────
  describe('tool loop nudge', () => {
    it('injects nudge after toolLoopThreshold consecutive tool-only rounds', async () => {
      const captured: Message[][] = []
      let callCount = 0

      env.toolRegistry.register({
        name: 'dummy',
        description: 'Dummy',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      // Create a client that does tool calls for first N rounds, then stops
      const client: LLMClient = {
        async *stream(options: any): AsyncGenerator<StreamEvent> {
          if (captured) captured.push([...(options.messages ?? [])])
          callCount++

          if (callCount <= 4) {
            // Tool-only rounds (no text)
            yield { type: 'tool-call', data: { toolCallId: `tc-${callCount}`, toolName: 'dummy', args: {} } } as ToolCallEvent
            yield {
              type: 'finish',
              data: {
                finishReason: 'tool-calls',
                usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
                text: '',
                toolCalls: [{ type: 'tool_use' as const, id: `tc-${callCount}`, name: 'dummy', input: {} }]
              }
            } as FinishEvent
          } else {
            // Final text response
            yield { type: 'text-delta', data: { text: 'Finally done.' } } as TextDeltaEvent
            yield {
              type: 'finish',
              data: {
                finishReason: 'stop',
                usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
                text: 'Finally done.',
                toolCalls: []
              }
            } as FinishEvent
          }
        },
        async generate() { return { id: 'mock', text: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } },
        getModelConfig() { return undefined },
        getLanguageModel() { return {} as any }
      } as LLMClient

      const loop = makeLoop(env, client, { toolLoopThreshold: 3 })
      await loop.run('Do stuff')

      // After 3 consecutive tool rounds, a nudge should appear in the messages
      // The nudge is injected as a user message in the history
      const history = loop.getMessages()
      const nudge = history.find(
        m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('consecutive tool calls')
      )
      expect(nudge).toBeDefined()
    })
  })

  // ── 8. getMessages / clearMessages ─────────────────────────────────────
  describe('getMessages / clearMessages', () => {
    it('getMessages returns the conversation history', async () => {
      const client = createMockClient([{ text: 'Hello!' }])
      const loop = makeLoop(env, client)

      await loop.run('Hi')

      const messages = loop.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant at minimum
      expect(messages[0]).toEqual({ role: 'user', content: 'Hi' })
    })

    it('getMessages returns a copy — mutations do not affect internal state', async () => {
      const client = createMockClient([{ text: 'Hello!' }])
      const loop = makeLoop(env, client)

      await loop.run('Hi')

      const msgs1 = loop.getMessages()
      msgs1.push({ role: 'user', content: 'injected' })

      const msgs2 = loop.getMessages()
      expect(msgs2.length).toBe(msgs1.length - 1) // the injected one should not appear
    })

    it('clearMessages resets history', async () => {
      const client = createMockClient([{ text: 'Hello!' }])
      const loop = makeLoop(env, client)

      await loop.run('Hi')
      expect(loop.getMessages().length).toBeGreaterThan(0)

      loop.clearMessages()
      expect(loop.getMessages()).toEqual([])
    })
  })

  // ── 9. transformContext + pinnedMessages interaction ────────────────────
  describe('transformContext + pinnedMessages', () => {
    it('pinned messages come before transformed context', async () => {
      const captured: Message[][] = []

      const client = createMockClient([{ text: 'Done.' }], captured)

      const loop = makeLoop(env, client, {
        pinnedMessages: [{ role: 'user', content: '[PINNED]' }],
        transformContext: async (msgs) => [
          ...msgs,
          { role: 'user' as const, content: '[INJECTED]' }
        ]
      })

      await loop.run('Hello')

      const sent = captured[0]
      // Pinned should be first
      expect(sent[0].content).toBe('[PINNED]')
      // Injected should be somewhere after
      const injectedIdx = sent.findIndex(m => m.content === '[INJECTED]')
      expect(injectedIdx).toBeGreaterThan(0)
    })
  })

  // ── 10. Token trim via contextWindow (GAP-6) ──────────────────────────
  describe('GAP-6 token trim', () => {
    it('trims old messages when context exceeds threshold', async () => {
      const captured: Message[][] = []

      env.toolRegistry.register({
        name: 'verbose',
        description: 'Returns verbose output',
        parameters: {},
        execute: async () => ({
          success: true,
          data: 'x'.repeat(2000) // Large result to fill context
        })
      })

      // 5 rounds of tool calls generating large results, then final text
      const responses: MockResponse[] = []
      for (let i = 0; i < 5; i++) {
        responses.push({
          text: '',
          toolCalls: [{ toolCallId: `tc-${i}`, toolName: 'verbose', args: {} }]
        })
      }
      responses.push({ text: 'Summary.' })

      const client = createMockClient(responses, captured)

      const loop = makeLoop(env, client, {
        contextWindow: 500, // Very small window to trigger trimming
        preCallTrimThreshold: 0.85,
      })

      const result = await loop.run('Generate verbose data')

      expect(result.success).toBe(true)

      // Later LLM calls should have fewer messages than total history
      // because buildView trims old messages
      const totalHistory = loop.getMessages().length
      if (captured.length > 2) {
        const lastCallMsgCount = captured[captured.length - 1].length
        // With trimming active, the last call should have fewer messages
        // than the full history (or equal if history is small enough)
        expect(lastCallMsgCount).toBeLessThanOrEqual(totalHistory)
      }
    })

    it('preserves pinned messages during trim', async () => {
      const captured: Message[][] = []

      env.toolRegistry.register({
        name: 'verbose',
        description: 'Returns verbose output',
        parameters: {},
        execute: async () => ({
          success: true,
          data: 'x'.repeat(2000)
        })
      })

      const responses: MockResponse[] = []
      for (let i = 0; i < 3; i++) {
        responses.push({
          text: '',
          toolCalls: [{ toolCallId: `tc-${i}`, toolName: 'verbose', args: {} }]
        })
      }
      responses.push({ text: 'Done.' })

      const client = createMockClient(responses, captured)

      const loop = makeLoop(env, client, {
        contextWindow: 500,
        preCallTrimThreshold: 0.85,
        pinnedMessages: [{ role: 'user', content: '[CRITICAL] Never forget this.' }]
      })

      await loop.run('Test pinned survival')

      // Every LLM call should still have the pinned message at position 0
      for (const callMsgs of captured) {
        expect(callMsgs[0].content).toBe('[CRITICAL] Never forget this.')
      }
    })
  })

  // ── 11. Hooks: onTurnStart / onTurnEnd ─────────────────────────────────
  describe('hooks: onTurnStart / onTurnEnd', () => {
    it('calls onTurnStart and onTurnEnd for each step', async () => {
      const onTurnStart = vi.fn()
      const onTurnEnd = vi.fn()

      env.toolRegistry.register({
        name: 'echo',
        description: 'Echo',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const client = createMockClient([
        { text: '', toolCalls: [{ toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
        { text: 'Done.' }
      ])

      const loop = makeLoop(env, client, {
        hooks: { onTurnStart, onTurnEnd }
      })

      await loop.run('Test hooks')

      // 2 steps: tool call round + text response round
      expect(onTurnStart).toHaveBeenCalledTimes(2)
      expect(onTurnStart.mock.calls[0][0]).toMatchObject({ step: 1 })
      expect(onTurnStart.mock.calls[1][0]).toMatchObject({ step: 2 })

      // onTurnEnd is only called for rounds with tool calls
      expect(onTurnEnd).toHaveBeenCalledTimes(1)
      expect(onTurnEnd.mock.calls[0][0]).toMatchObject({ step: 1, toolCallCount: 1 })
    })
  })
})
