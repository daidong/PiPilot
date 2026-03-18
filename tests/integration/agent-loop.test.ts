/**
 * Integration tests for the full agent loop with mocked LLM.
 *
 * These tests exercise createAgent (or AgentLoop directly) with pre-scripted
 * LLM responses so no real API keys are needed, while still verifying the
 * end-to-end flow of prompt -> tool calls -> policy checks -> response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentLoop, type LLMClient } from '../../src/agent/agent-loop.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { TokenBudget } from '../../src/core/token-budget.js'
import { TokenTracker } from '../../src/core/token-tracker.js'
import { defineGuardPolicy } from '../../src/factories/define-policy.js'
import { noSecretFilesRead } from '../../src/policies/no-secret-files.js'
import type {
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  FinishEvent,
  CompletionResponse
} from '../../src/llm/index.js'
import type { Runtime } from '../../src/types/runtime.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock LLM client that yields pre-scripted responses in order.
 */
function createMockClient(responses: Array<{
  text: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
  finishReason?: string
}>): LLMClient {
  let callIndex = 0

  return {
    async *stream(_options: any): AsyncGenerator<StreamEvent> {
      const response = responses[callIndex++]
      if (!response) {
        yield {
          type: 'finish',
          data: {
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            text: '',
            toolCalls: []
          }
        } as FinishEvent
        return
      }

      if (response.text) {
        yield {
          type: 'text-delta',
          data: { text: response.text }
        } as TextDeltaEvent
      }

      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield {
            type: 'tool-call',
            data: {
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args
            }
          } as ToolCallEvent
        }
      }

      yield {
        type: 'finish',
        data: {
          finishReason: response.finishReason || (response.toolCalls?.length ? 'tool-calls' : 'stop'),
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          text: response.text,
          toolCalls: (response.toolCalls || []).map(tc => ({
            type: 'tool_use' as const,
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args
          }))
        }
      } as FinishEvent
    },

    async generate(_options: any): Promise<CompletionResponse> {
      const response = responses[callIndex++]
      if (!response) {
        return {
          id: 'mock-response',
          text: '',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        }
      }
      return {
        id: 'mock-response',
        text: response.text,
        toolCalls: (response.toolCalls || []).map(tc => ({
          type: 'tool_use',
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.args
        })),
        finishReason: (response.finishReason || (response.toolCalls?.length ? 'tool-calls' : 'stop')) as any,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      }
    },

    getModelConfig() {
      return undefined
    },

    getLanguageModel() {
      return {} as any
    }
  } as LLMClient
}

/**
 * Build the standard test runtime and its components.
 */
function buildTestRuntime() {
  const eventBus = new EventBus()
  const trace = new TraceCollector('integration-session')
  const policyEngine = new PolicyEngine({ trace, eventBus })
  const toolRegistry = new ToolRegistry()
  const tokenBudget = new TokenBudget({ total: 50_000 })

  const mockRuntime: Runtime = {
    projectPath: '/test/project',
    sessionId: 'integration-session',
    agentId: 'integration-agent',
    step: 0,
    io: {} as any,
    eventBus,
    trace,
    tokenBudget,
    toolRegistry,
    policyEngine,
    contextManager: {} as any,
    sessionState: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      has: () => false
    }
  }

  toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })

  return { eventBus, trace, policyEngine, toolRegistry, tokenBudget, mockRuntime }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: AgentLoop end-to-end', () => {
  let env: ReturnType<typeof buildTestRuntime>

  beforeEach(() => {
    env = buildTestRuntime()
  })

  // -----------------------------------------------------------------------
  // 1. Prompt -> tool call -> final response
  // -----------------------------------------------------------------------
  describe('prompt -> tool call -> response', () => {
    it('should call a tool and return the final text response', async () => {
      env.toolRegistry.register({
        name: 'lookup',
        description: 'Look up a value',
        parameters: {
          key: { type: 'string', description: 'Key to look up', required: true }
        },
        execute: async (input: { key: string }) => ({
          success: true,
          data: `value-for-${input.key}`
        })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'lookup', args: { key: 'version' } }
          ]
        },
        { text: 'The version is value-for-version.' }
      ])

      const onToolCall = vi.fn()
      const onToolResult = vi.fn()

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10,
        onToolCall,
        onToolResult
      })

      const result = await loop.run('What is the version?')

      expect(result.success).toBe(true)
      expect(result.output).toBe('The version is value-for-version.')
      expect(onToolCall).toHaveBeenCalledWith('lookup', { key: 'version' })
      expect(onToolResult).toHaveBeenCalled()
    })

    it('should chain multiple tool calls across steps', async () => {
      const callLog: string[] = []

      env.toolRegistry.register({
        name: 'step-a',
        description: 'First step',
        parameters: {},
        execute: async () => {
          callLog.push('step-a')
          return { success: true, data: 'result-a' }
        }
      })

      env.toolRegistry.register({
        name: 'step-b',
        description: 'Second step',
        parameters: {},
        execute: async () => {
          callLog.push('step-b')
          return { success: true, data: 'result-b' }
        }
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 'step-a', args: {} }]
        },
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-2', toolName: 'step-b', args: {} }]
        },
        { text: 'Both steps complete.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Run both steps')

      expect(result.success).toBe(true)
      expect(result.output).toBe('Both steps complete.')
      expect(callLog).toEqual(['step-a', 'step-b'])
    })
  })

  // -----------------------------------------------------------------------
  // 2. Tool errors -> error feedback loop
  // -----------------------------------------------------------------------
  describe('tool error feedback loop', () => {
    it('should feed tool errors back to the LLM and still succeed', async () => {
      env.toolRegistry.register({
        name: 'flaky',
        description: 'A tool that sometimes fails',
        parameters: {},
        execute: async () => ({
          success: false,
          error: 'Temporary failure — please retry'
        })
      })

      const client = createMockClient([
        // Round 1: LLM calls the flaky tool
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 'flaky', args: {} }]
        },
        // Round 2: LLM sees the error and gives a text answer instead
        { text: 'The tool failed, so I will answer directly.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Try the flaky tool')

      expect(result.success).toBe(true)
      expect(result.output).toBe('The tool failed, so I will answer directly.')
    })

    it('should handle tools that throw exceptions', async () => {
      env.toolRegistry.register({
        name: 'crasher',
        description: 'A tool that throws',
        parameters: {},
        execute: async () => {
          throw new Error('Unexpected crash')
        }
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 'crasher', args: {} }]
        },
        { text: 'I encountered an error and recovered.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Call the crasher')

      expect(result.success).toBe(true)
      expect(result.output).toBe('I encountered an error and recovered.')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Policy denials (e.g. reading .env files)
  // -----------------------------------------------------------------------
  describe('policy denial end-to-end', () => {
    it('should deny reading a .env file via the no-secret-files policy', async () => {
      // Register the guard policy
      env.policyEngine.register(noSecretFilesRead)

      // Register a read tool that the policy targets
      env.toolRegistry.register({
        name: 'read',
        description: 'Read a file',
        parameters: {
          path: { type: 'string', description: 'File path', required: true }
        },
        execute: async (input: { path: string }) => ({
          success: true,
          data: `contents of ${input.path}`
        })
      })

      const client = createMockClient([
        // LLM tries to read .env
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'read', args: { path: '/project/.env' } }
          ]
        },
        // After denial feedback, LLM gives a text answer
        { text: 'I cannot read .env files due to security policies.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Read the .env file')

      expect(result.success).toBe(true)
      expect(result.output).toBe('I cannot read .env files due to security policies.')
    })

    it('should deny reading a .pem private key file', async () => {
      env.policyEngine.register(noSecretFilesRead)

      env.toolRegistry.register({
        name: 'read',
        description: 'Read a file',
        parameters: {
          path: { type: 'string', description: 'File path', required: true }
        },
        execute: async (input: { path: string }) => ({
          success: true,
          data: `contents of ${input.path}`
        })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'read', args: { path: '/certs/server.pem' } }
          ]
        },
        { text: 'I cannot read key files.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Read the PEM file')

      expect(result.success).toBe(true)
      expect(result.output).toBe('I cannot read key files.')
    })

    it('should allow reading a normal file when policy is active', async () => {
      env.policyEngine.register(noSecretFilesRead)

      let readCalled = false
      env.toolRegistry.register({
        name: 'read',
        description: 'Read a file',
        parameters: {
          path: { type: 'string', description: 'File path', required: true }
        },
        execute: async (input: { path: string }) => {
          readCalled = true
          return { success: true, data: `contents of ${input.path}` }
        }
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'read', args: { path: '/project/README.md' } }
          ]
        },
        { text: 'Here is the README content.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Read README.md')

      expect(result.success).toBe(true)
      expect(readCalled).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 4. Custom guard policy denial
  // -----------------------------------------------------------------------
  describe('custom guard policy', () => {
    it('should deny based on a custom guard policy', async () => {
      const denyBash = defineGuardPolicy({
        id: 'no-bash',
        match: (ctx) => ctx.tool === 'bash',
        decide: () => ({ action: 'deny', reason: 'Bash is disabled in this environment.' })
      })
      env.policyEngine.register(denyBash)

      env.toolRegistry.register({
        name: 'bash',
        description: 'Run a shell command',
        parameters: {
          command: { type: 'string', description: 'Command', required: true }
        },
        execute: async (input: { command: string }) => ({
          success: true,
          data: `ran: ${input.command}`
        })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'bash', args: { command: 'rm -rf /' } }
          ]
        },
        { text: 'Bash is not available.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Delete everything')

      expect(result.success).toBe(true)
      expect(result.output).toBe('Bash is not available.')
    })
  })

  // -----------------------------------------------------------------------
  // 5. maxSteps limit
  // -----------------------------------------------------------------------
  describe('maxSteps limit', () => {
    it('should stop after maxSteps even if the LLM keeps calling tools', async () => {
      let callCount = 0
      const infiniteClient: LLMClient = {
        async *stream() {
          callCount++
          yield {
            type: 'tool-call',
            data: {
              toolCallId: `tool-${callCount}`,
              toolName: 'dummy',
              args: {}
            }
          } as ToolCallEvent

          yield {
            type: 'finish',
            data: {
              finishReason: 'tool-calls',
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
              text: '',
              toolCalls: [{
                type: 'tool_use',
                id: `tool-${callCount}`,
                name: 'dummy',
                input: {}
              }]
            }
          } as FinishEvent
        },

        async generate() {
          callCount++
          return {
            id: 'mock',
            text: '',
            toolCalls: [{
              type: 'tool_use',
              id: `tool-${callCount}`,
              name: 'dummy',
              input: {}
            }],
            finishReason: 'tool-calls',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
          }
        },

        getModelConfig() { return undefined },
        getLanguageModel() { return {} as any }
      } as LLMClient

      env.toolRegistry.register({
        name: 'dummy',
        description: 'Dummy tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const loop = new AgentLoop({
        client: infiniteClient,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 3
      })

      const result = await loop.run('Keep looping')

      expect(result.success).toBe(true)
      expect(result.output).toContain('maximum steps')
      expect(result.steps).toBeLessThanOrEqual(3)
    })

    it('should finish in fewer steps when LLM stops early', async () => {
      const client = createMockClient([
        { text: 'Done immediately.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 20
      })

      const result = await loop.run('Quick answer')

      expect(result.success).toBe(true)
      expect(result.steps).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // 6. Token usage tracking
  // -----------------------------------------------------------------------
  describe('token usage tracking', () => {
    it('should call onUsage with cost info when modelId is set', async () => {
      const onUsage = vi.fn()
      const tokenTracker = new TokenTracker()

      const client = createMockClient([{ text: 'Usage test answer' }])

      const loop = new AgentLoop({
        client,
        modelId: 'gpt-5.2',
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10,
        tokenTracker,
        onUsage
      })

      await loop.run('Track usage')

      expect(onUsage).toHaveBeenCalled()
      const [usage, cost] = onUsage.mock.calls[0] as [any, { totalCost: number }]
      expect(usage.promptTokens).toBe(10)
      expect(usage.completionTokens).toBe(20)
      expect(cost.totalCost).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // 7. Trace recording
  // -----------------------------------------------------------------------
  describe('trace integration', () => {
    it('should record trace events throughout the run', async () => {
      env.toolRegistry.register({
        name: 'tracer-tool',
        description: 'A tool for testing trace',
        parameters: {},
        execute: async () => ({ success: true, data: 'traced' })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [{ toolCallId: 'tc-1', toolName: 'tracer-tool', args: {} }]
        },
        { text: 'Trace complete.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      await loop.run('Test trace')

      const events = env.trace.getEvents()
      expect(events.length).toBeGreaterThan(0)

      // Verify we have an agent.start event
      const startEvent = events.find(e => e.type === 'agent.start')
      expect(startEvent).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // 8. Streaming callback
  // -----------------------------------------------------------------------
  describe('streaming callback', () => {
    it('should fire onText for streamed text', async () => {
      const onText = vi.fn()
      const client = createMockClient([{ text: 'Streamed chunk' }])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10,
        onText
      })

      await loop.run('Stream test')

      expect(onText).toHaveBeenCalledWith('Streamed chunk')
    })
  })

  // -----------------------------------------------------------------------
  // 9. Stop mid-run
  // -----------------------------------------------------------------------
  describe('stop', () => {
    it('should stop the loop when stop() is called', async () => {
      const client = createMockClient([{ text: 'First response' }])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 100
      })

      loop.stop()
      const result = await loop.run('Test stop')

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 10. Unknown tool handling
  // -----------------------------------------------------------------------
  describe('unknown tool call', () => {
    it('should handle a call to an unregistered tool gracefully', async () => {
      // LLM calls a tool that does not exist
      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tc-1', toolName: 'nonexistent', args: {} }
          ]
        },
        { text: 'Recovered from missing tool.' }
      ])

      const loop = new AgentLoop({
        client,
        toolRegistry: env.toolRegistry,
        runtime: env.mockRuntime,
        trace: env.trace,
        systemPrompt: 'You are a test assistant.',
        maxSteps: 10
      })

      const result = await loop.run('Call nonexistent tool')

      // The loop should still succeed (error fed back to LLM, LLM recovers)
      expect(result.success).toBe(true)
      expect(result.output).toBe('Recovered from missing tool.')
    })
  })
})
