/**
 * AgentLoop 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLoop, type LLMClient } from '../../src/agent/agent-loop.js'
import { ToolRegistry } from '../../src/core/tool-registry.js'
import { PolicyEngine } from '../../src/core/policy-engine.js'
import { TraceCollector } from '../../src/core/trace-collector.js'
import { EventBus } from '../../src/core/event-bus.js'
import { TokenBudget } from '../../src/core/token-budget.js'
import { TokenTracker } from '../../src/core/token-tracker.js'
import type {
  StreamEvent,
  TextDeltaEvent,
  ToolCallEvent,
  FinishEvent,
  CompletionResponse,
  ToolUseContent,
  TokenUsage
} from '../../src/llm/index.js'
import type { Runtime } from '../../src/types/runtime.js'

/**
 * 创建模拟 LLM 客户端
 */
function createMockClient(responses: Array<{
  text: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
  finishReason?: string
}>): LLMClient {
  let callIndex = 0

  return {
    async *stream(options: any): AsyncGenerator<StreamEvent> {
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

      // 发送文本增量
      if (response.text) {
        yield {
          type: 'text-delta',
          data: { text: response.text }
        } as TextDeltaEvent
      }

      // 发送工具调用
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

      // 发送完成事件
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

    async generate(options: any): Promise<CompletionResponse> {
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

describe('AgentLoop', () => {
  let toolRegistry: ToolRegistry
  let policyEngine: PolicyEngine
  let trace: TraceCollector
  let eventBus: EventBus
  let tokenBudget: TokenBudget
  let mockRuntime: Runtime

  beforeEach(() => {
    eventBus = new EventBus()
    trace = new TraceCollector('test-session')
    policyEngine = new PolicyEngine({ trace, eventBus })
    toolRegistry = new ToolRegistry()
    tokenBudget = new TokenBudget({ total: 10000 })

    mockRuntime = {
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
      sessionState: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
        has: () => false
      }
    }

    toolRegistry.configure({ policyEngine, trace, runtime: mockRuntime })
  })

  describe('run', () => {
    it('should complete with text response', async () => {
      const client = createMockClient([
        { text: 'Hello! How can I help you?' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10
      })

      const result = await agentLoop.run('Hello')

      expect(result.success).toBe(true)
      expect(result.output).toBe('Hello! How can I help you?')
    })

    it('should execute tool calls', async () => {
      // 注册一个简单工具
      toolRegistry.register({
        name: 'greet',
        description: 'Greet someone',
        parameters: {
          name: { type: 'string', description: 'Name to greet', required: true }
        },
        execute: async (input: { name: string }) => ({
          success: true,
          data: `Hello, ${input.name}!`
        })
      })

      const client = createMockClient([
        // 第一次响应：调用工具
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tool-call-1', toolName: 'greet', args: { name: 'World' } }
          ]
        },
        // 第二次响应：最终回复
        { text: 'I greeted World for you!' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10
      })

      const result = await agentLoop.run('Greet World')

      expect(result.success).toBe(true)
      expect(result.output).toBe('I greeted World for you!')
    })

    it('should handle tool execution errors', async () => {
      toolRegistry.register({
        name: 'failing-tool',
        description: 'A tool that fails',
        parameters: {},
        execute: async () => ({
          success: false,
          error: 'Tool execution failed'
        })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tool-call-1', toolName: 'failing-tool', args: {} }
          ]
        },
        { text: 'The tool failed, but I handled it.' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10
      })

      const result = await agentLoop.run('Use the failing tool')

      expect(result.success).toBe(true)
    })

    it('should respect maxSteps limit', async () => {
      // 创建一个总是调用工具的客户端
      let callCount = 0
      const infiniteClient: LLMClient = {
        async *stream() {
          yield {
            type: 'tool-call',
            data: {
              toolCallId: `tool-${callCount++}`,
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
          return {
            id: 'mock',
            text: '',
            toolCalls: [{
              type: 'tool_use',
              id: `tool-${callCount++}`,
              name: 'dummy',
              input: {}
            }],
            finishReason: 'tool-calls',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
          }
        },

        getModelConfig() {
          return undefined
        },

        getLanguageModel() {
          return {} as any
        }
      } as LLMClient

      toolRegistry.register({
        name: 'dummy',
        description: 'Dummy tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'ok' })
      })

      const agentLoop = new AgentLoop({
        client: infiniteClient,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 3
      })

      const result = await agentLoop.run('Keep calling tools')

      expect(result.success).toBe(true)
      expect(result.output).toContain('maximum steps')
    })

    it('should call onText callback for text content', async () => {
      const onText = vi.fn()

      const client = createMockClient([
        { text: 'Streaming text' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10,
        onText
      })

      await agentLoop.run('Test')

      expect(onText).toHaveBeenCalledWith('Streaming text')
    })

    it('should call onToolCall and onToolResult callbacks', async () => {
      const onToolCall = vi.fn()
      const onToolResult = vi.fn()

      toolRegistry.register({
        name: 'test-tool',
        description: 'Test tool',
        parameters: {},
        execute: async () => ({ success: true, data: 'result' })
      })

      const client = createMockClient([
        {
          text: '',
          toolCalls: [
            { toolCallId: 'tool-1', toolName: 'test-tool', args: {} }
          ]
        },
        { text: 'Done' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10,
        onToolCall,
        onToolResult
      })

      await agentLoop.run('Test')

      expect(onToolCall).toHaveBeenCalled()
      expect(onToolResult).toHaveBeenCalled()
    })

    it('should report non-zero cost when modelId is provided', async () => {
      const onUsage = vi.fn()
      const tokenTracker = new TokenTracker()
      const client = createMockClient([{ text: 'Cost test' }])

      const agentLoop = new AgentLoop({
        client,
        modelId: 'gpt-5.4',
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10,
        tokenTracker,
        onUsage
      })

      await agentLoop.run('Test cost')

      expect(onUsage).toHaveBeenCalled()
      const [, cost] = onUsage.mock.calls[0] as [unknown, { totalCost: number }]
      expect(cost.totalCost).toBeGreaterThan(0)
    })
  })

  describe('stop', () => {
    it('should stop the agent loop', async () => {
      const client = createMockClient([
        { text: 'First response' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 100
      })

      // 停止应该设置标志
      agentLoop.stop()

      // 运行后应该很快完成
      const result = await agentLoop.run('Test')

      // 结果取决于停止时机，但应该成功完成
      expect(result).toBeDefined()
    })
  })

  describe('trace integration', () => {
    it('should record events in trace', async () => {
      const client = createMockClient([
        { text: 'Hello!' }
      ])

      const agentLoop = new AgentLoop({
        client,
        toolRegistry,
        runtime: mockRuntime,
        trace,
        systemPrompt: 'You are a helpful assistant.',
        maxSteps: 10
      })

      await agentLoop.run('Test')

      const events = trace.getEvents()
      expect(events.length).toBeGreaterThan(0)
    })
  })
})
