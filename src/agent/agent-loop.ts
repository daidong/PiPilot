/**
 * AgentLoop - Agent execution loop
 *
 * Uses Vercel AI SDK's unified LLM interface with optional budget management.
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
import {
  AgentLoopBudgetManager,
  type BlockEstimates
} from './agent-loop-budget.js'

/**
 * LLM 客户端类型
 */
export type LLMClient = ReturnType<typeof createLLMClient>

/**
 * AgentLoop configuration
 */
export interface AgentLoopConfig {
  /** LLM client (new API) */
  client?: LLMClient
  /** LLM client config (for auto-creating client) */
  llmConfig?: LLMClientConfig
  /** Tool registry */
  toolRegistry: ToolRegistry
  /** Runtime */
  runtime: Runtime
  /** Trace collector */
  trace: TraceCollector
  /** System prompt */
  systemPrompt: string
  /** Maximum steps */
  maxSteps: number
  /** Maximum tokens for generation */
  maxTokens?: number
  /** Temperature */
  temperature?: number
  /** Streaming text callback */
  onText?: (text: string) => void
  /** Tool call callback */
  onToolCall?: (tool: string, input: unknown) => void
  /** Tool result callback */
  onToolResult?: (tool: string, result: unknown) => void

  /**
   * Token budget configuration (optional)
   * When enabled, uses smart budget management to optimize context
   */
  budgetConfig?: {
    /** Enable unified budget management */
    enabled: boolean
    /** Model ID for context window detection */
    modelId?: string
    /** Override context window size */
    contextWindow?: number
    /** Budget allocation percentages */
    allocation?: {
      system?: number   // default: 0.15
      tools?: number    // default: 0.25
      messages?: number // default: 0.60
    }
    /** Priority tools to keep in minimal mode */
    priorityTools?: string[]
  }
}

/**
 * Agent execution loop
 */
export class AgentLoop {
  private config: AgentLoopConfig
  private client: LLMClient
  private messages: Message[] = []
  private stopped = false
  private budgetManager: AgentLoopBudgetManager | null = null

  constructor(config: AgentLoopConfig) {
    this.config = config

    // Create or use provided LLM client
    if (config.client) {
      this.client = config.client
    } else if (config.llmConfig) {
      this.client = createLLMClient(config.llmConfig)
    } else {
      throw new Error('Either client or llmConfig must be provided')
    }

    // Initialize budget manager if enabled
    if (config.budgetConfig?.enabled) {
      this.budgetManager = new AgentLoopBudgetManager({
        modelId: config.budgetConfig.modelId ?? config.llmConfig?.model,
        contextWindow: config.budgetConfig.contextWindow,
        allocation: config.budgetConfig.allocation,
        priorityTools: config.budgetConfig.priorityTools
      })
    }
  }

  /**
   * Run the agent
   */
  async run(userPrompt: string): Promise<AgentRunResult> {
    const startTime = Date.now()
    this.stopped = false

    // Record start
    this.config.trace.record({
      type: 'agent.start',
      data: { prompt: userPrompt }
    })

    // Add user message
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

        // Record step start
        this.config.trace.record({
          type: 'agent.step',
          data: { step }
        })

        // Prepare context (with optional budget management)
        let systemPrompt = this.config.systemPrompt
        let tools = this.config.toolRegistry.generateToolSchemas() as LLMToolDefinition[]
        let messagesToSend = this.messages
        let estimates: BlockEstimates | undefined

        if (this.budgetManager) {
          const prepared = this.budgetManager.prepareContext({
            systemPrompt,
            tools,
            messages: messagesToSend as unknown as import('../types/session.js').Message[]
          })

          systemPrompt = prepared.systemPrompt
          tools = prepared.tools
          messagesToSend = prepared.messages as unknown as Message[]
          estimates = prepared.estimates

          // Log degradation if occurred
          if (prepared.decision.level !== 'normal') {
            this.config.trace.record({
              type: 'budget.degradation',
              data: {
                level: prepared.decision.level,
                actions: prepared.decision.actions,
                messagesExcluded: prepared.messagesExcluded,
                warning: prepared.warning
              }
            })
          }
        }

        // Send request
        this.config.trace.record({
          type: 'llm.request',
          data: { messagesCount: messagesToSend.length }
        })

        // Use streaming API
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
            system: systemPrompt,
            messages: messagesToSend,
            tools,
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
              // Log full error details for debugging
              console.error('[AgentLoop] LLM Error:', error.message || error)
              if (error && typeof error === 'object') {
                const errorDetails = {
                  message: error.message,
                  name: (error as any).name,
                  code: (error as any).code,
                  status: (error as any).status,
                  cause: (error as any).cause
                }
                console.error('[AgentLoop] Error details:', JSON.stringify(errorDetails, null, 2))
              }
            }
          }
        )

        // Check for LLM error
        if (response.finishReason === 'error' || llmError) {
          const errorMessage = llmError?.message
            || (llmError as any)?.cause?.message
            || (typeof llmError === 'string' ? llmError : null)
            || `Unknown LLM error (finishReason: ${response.finishReason})`
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

        // Calibrate budget manager with actual usage
        if (this.budgetManager && estimates) {
          this.budgetManager.calibrate(estimates, usage)
        }

        // Build assistant message content
        const assistantContent: ContentBlock[] = []
        if (responseText) {
          assistantContent.push({ type: 'text', text: responseText })
        }
        assistantContent.push(...toolCalls)

        // Add assistant message
        this.messages.push({
          role: 'assistant',
          content: assistantContent
        })

        // If no tool calls, extract text and finish
        if (toolCalls.length === 0 || response.finishReason === 'stop') {
          finalOutput = responseText
          break
        }

        // Execute tool calls
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

          // Build tool result
          // Note: JSON.stringify(undefined) returns undefined, not a string
          // We need to handle this case to avoid null content errors
          const resultContent = result.success
            ? (result.data !== undefined ? JSON.stringify(result.data, null, 2) : '{"success": true}')
            : `Error: ${result.error}`

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
            is_error: !result.success
          })
        }

        // Add tool result message
        this.messages.push({
          role: 'tool',
          content: toolResults
        })

        // Check if reached max_tokens
        if (response.finishReason === 'length') {
          finalOutput =
            responseText + '\n[Response truncated due to token limit]'
          break
        }
      }

      // Check if reached max steps
      if (step >= this.config.maxSteps) {
        finalOutput += '\n[Reached maximum steps limit]'
      }

      // Record completion
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
   * Stop execution
   */
  stop(): void {
    this.stopped = true
  }

  /**
   * Get message history
   */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /**
   * Clear message history
   */
  clearMessages(): void {
    this.messages = []
  }

  /**
   * Get LLM client
   */
  getClient(): LLMClient {
    return this.client
  }

  /**
   * Get budget manager (if enabled)
   */
  getBudgetManager(): AgentLoopBudgetManager | null {
    return this.budgetManager
  }
}

/**
 * Shortcut: Create AgentLoop and run
 */
export async function runAgent(
  config: AgentLoopConfig,
  prompt: string
): Promise<AgentRunResult> {
  const loop = new AgentLoop(config)
  return loop.run(prompt)
}
