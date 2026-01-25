/**
 * AgentLoop - Agent 执行循环
 *
 * 使用 Vercel AI SDK 的统一 LLM 接口
 */

import type {
  Message,
  ContentBlock,
  ToolUseContent,
  LLMToolDefinition,
  TokenUsage
} from '../llm/index.js'
import {
  createLLMClient,
  streamWithCallbacks,
  type LLMClientConfig
} from '../llm/index.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { TraceCollector } from '../core/trace-collector.js'
import type { Runtime } from '../types/runtime.js'
import type { AgentRunResult } from '../types/agent.js'

/**
 * LLM 客户端类型
 */
export type LLMClient = ReturnType<typeof createLLMClient>

/**
 * AgentLoop 配置
 */
export interface AgentLoopConfig {
  /** LLM 客户端 (新 API) */
  client?: LLMClient
  /** LLM 客户端配置 (用于自动创建客户端) */
  llmConfig?: LLMClientConfig
  /** 工具注册表 */
  toolRegistry: ToolRegistry
  /** 运行时 */
  runtime: Runtime
  /** Trace 收集器 */
  trace: TraceCollector
  /** 系统提示 */
  systemPrompt: string
  /** 最大步骤数 */
  maxSteps: number
  /** 最大 token 数 */
  maxTokens?: number
  /** 温度 */
  temperature?: number
  /** 流式文本回调 */
  onText?: (text: string) => void
  /** 工具调用回调 */
  onToolCall?: (tool: string, input: unknown) => void
  /** 工具结果回调 */
  onToolResult?: (tool: string, result: unknown) => void
}

/**
 * Agent 执行循环
 */
export class AgentLoop {
  private config: AgentLoopConfig
  private client: LLMClient
  private messages: Message[] = []
  private stopped = false

  constructor(config: AgentLoopConfig) {
    this.config = config

    // 创建或使用传入的 LLM 客户端
    if (config.client) {
      this.client = config.client
    } else if (config.llmConfig) {
      this.client = createLLMClient(config.llmConfig)
    } else {
      throw new Error('Either client or llmConfig must be provided')
    }
  }

  /**
   * 运行 Agent
   */
  async run(userPrompt: string): Promise<AgentRunResult> {
    const startTime = Date.now()
    this.stopped = false

    // 记录开始
    this.config.trace.record({
      type: 'agent.start',
      data: { prompt: userPrompt }
    })

    // 添加用户消息
    this.messages.push({
      role: 'user',
      content: userPrompt
    })

    let step = 0
    let finalOutput = ''

    try {
      while (step < this.config.maxSteps && !this.stopped) {
        step++
        this.config.runtime.step = step
        this.config.trace.setStep(step)

        // 记录步骤开始
        this.config.trace.record({
          type: 'agent.step',
          data: { step }
        })

        // 发送请求
        this.config.trace.record({
          type: 'llm.request',
          data: { messagesCount: this.messages.length }
        })

        // 使用新的流式 API
        const toolCalls: ToolUseContent[] = []
        let responseText = ''
        let usage: TokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }

        let llmError: Error | undefined

        const response = await streamWithCallbacks(
          this.client,
          {
            system: this.config.systemPrompt,
            messages: this.messages,
            tools: this.config.toolRegistry.generateToolSchemas() as LLMToolDefinition[],
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature
          },
          {
            onText: (text) => {
              responseText += text
              this.config.onText?.(text)
            },
            onToolCall: (tc) => {
              toolCalls.push({
                type: 'tool_use',
                id: tc.toolCallId,
                name: tc.toolName,
                input: tc.args
              })
              this.config.onToolCall?.(tc.toolName, tc.args)
            },
            onFinish: (result) => {
              usage = result.usage
            },
            onError: (error) => {
              llmError = error
              console.error('[AgentLoop] LLM Error:', error.message)
            }
          }
        )

        // Check for LLM error
        if (response.finishReason === 'error' || llmError) {
          const errorMessage = llmError?.message || 'Unknown LLM error'
          this.config.trace.record({
            type: 'llm.response',
            data: {
              toolCallsCount: 0,
              finishReason: 'error',
              error: errorMessage,
              usage: { inputTokens: 0, outputTokens: 0 }
            }
          })

          // Record completion with error
          this.config.trace.record({
            type: 'agent.complete',
            data: { steps: step, success: false, error: errorMessage }
          })

          return {
            success: false,
            output: '',
            error: errorMessage,
            steps: step,
            trace: this.config.trace.getEvents(),
            durationMs: Date.now() - startTime
          }
        }

        this.config.trace.record({
          type: 'llm.response',
          data: {
            toolCallsCount: toolCalls.length,
            finishReason: response.finishReason,
            usage: {
              inputTokens: usage.promptTokens,
              outputTokens: usage.completionTokens
            }
          }
        })

        // 构建助手消息内容
        const assistantContent: ContentBlock[] = []
        if (responseText) {
          assistantContent.push({ type: 'text', text: responseText })
        }
        assistantContent.push(...toolCalls)

        // 添加助手消息
        this.messages.push({
          role: 'assistant',
          content: assistantContent
        })

        // 如果没有工具调用，提取文本并结束
        if (toolCalls.length === 0 || response.finishReason === 'stop') {
          finalOutput = responseText
          break
        }

        // 执行工具调用
        const toolResults: ContentBlock[] = []

        for (const toolUse of toolCalls) {
          const result = await this.config.toolRegistry.call(
            toolUse.name,
            toolUse.input,
            {
              sessionId: this.config.runtime.sessionId,
              step,
              agentId: this.config.runtime.agentId
            }
          )

          this.config.onToolResult?.(toolUse.name, result)

          // 构建工具结果
          const resultContent = result.success
            ? JSON.stringify(result.data, null, 2)
            : `Error: ${result.error}`

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
            is_error: !result.success
          })
        }

        // 添加工具结果消息
        this.messages.push({
          role: 'tool',
          content: toolResults
        })

        // 检查是否达到 max_tokens
        if (response.finishReason === 'length') {
          finalOutput =
            responseText + '\n[Response truncated due to token limit]'
          break
        }
      }

      // 检查是否达到最大步骤
      if (step >= this.config.maxSteps) {
        finalOutput += '\n[Reached maximum steps limit]'
      }

      // 记录完成
      this.config.trace.record({
        type: 'agent.complete',
        data: { steps: step, success: true }
      })

      return {
        success: true,
        output: finalOutput,
        steps: step,
        trace: this.config.trace.getEvents(),
        durationMs: Date.now() - startTime
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      this.config.trace.record({
        type: 'agent.complete',
        data: { steps: step, success: false, error: errorMessage }
      })

      return {
        success: false,
        output: '',
        error: errorMessage,
        steps: step,
        trace: this.config.trace.getEvents(),
        durationMs: Date.now() - startTime
      }
    }
  }

  /**
   * 停止执行
   */
  stop(): void {
    this.stopped = true
  }

  /**
   * 获取消息历史
   */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /**
   * 清空消息历史
   */
  clearMessages(): void {
    this.messages = []
  }

  /**
   * 获取 LLM 客户端
   */
  getClient(): LLMClient {
    return this.client
  }
}

/**
 * 快捷方式：创建 AgentLoop 并运行
 */
export async function runAgent(
  config: AgentLoopConfig,
  prompt: string
): Promise<AgentRunResult> {
  const loop = new AgentLoop(config)
  return loop.run(prompt)
}
