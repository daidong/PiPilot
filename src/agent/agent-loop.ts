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
import type { StateSummarizer } from '../core/state-summarizer.js'
import type { BudgetCoordinator, RoundHint } from '../core/budget-coordinator.js'
import { compressToolResult } from '../core/tool-result-compressor.js'

/**
 * LLM client type
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
  /** Reasoning effort for reasoning models (low, medium, high) */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Streaming text callback */
  onText?: (text: string) => void
  /** Tool call callback */
  onToolCall?: (tool: string, input: unknown) => void
  /** Tool result callback */
  onToolResult?: (tool: string, result: unknown, args?: unknown) => void

  /** Enable debug logging (prints full LLM payload to stderr) */
  debug?: boolean

  /** Consecutive tool-only rounds before nudge (default: 7) */
  toolLoopThreshold?: number
  /** Custom nudge message factory. Return null to skip. */
  onToolLoopNudge?: (rounds: number) => string | null

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
    /** Max tokens per tool result (default: 4096) */
    toolResultCap?: number
  }

  /** State summarizer for accumulated findings (Change 3) */
  stateSummarizer?: StateSummarizer

  /** Selected context to inject as separate message (Change 5) */
  selectedContext?: string

  /** Budget coordinator for dynamic output reserve (Change 2) */
  budgetCoordinator?: BudgetCoordinator
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
  /** Recently used tool names for subset selection (Change 4) */
  private recentTools: string[] = []
  /** Current tool subset (undefined = all tools) */
  private activeToolSubset: string[] | undefined
  /** Whether tool nudge was injected last round */
  private toolNudgeInjected = false
  /** Circuit breaker: consecutive rounds with TOOL_NOT_AVAILABLE errors */
  private toolNotAvailableStreak = 0

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
   * Determine round hint for dynamic output reserve (Change 2)
   */
  private determineRoundHint(tools: LLMToolDefinition[], previousResponseText: string, previousToolCalls: number): RoundHint {
    // Tool nudge was just injected → final
    if (this.toolNudgeInjected) return 'final'
    // No tools in schema for this round → final
    if (tools.length === 0) return 'final'
    // Previous round had text response and no tool calls → final
    if (previousResponseText && previousToolCalls === 0) return 'final'
    // Default: intermediate
    return 'intermediate'
  }

  /**
   * Track recently used tools (last 5 rounds)
   */
  private trackToolUsage(toolNames: string[]): void {
    this.recentTools.push(...toolNames)
    // Keep only last ~25 tool names (5 rounds * ~5 tools max)
    if (this.recentTools.length > 25) {
      this.recentTools = this.recentTools.slice(-25)
    }
  }

  /**
   * Get unique recently used tool names
   */
  private getRecentToolNames(): string[] {
    return [...new Set(this.recentTools)]
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

    // Inject selected context as a separate message before the user message (Change 5)
    if (this.config.selectedContext) {
      this.messages.push({
        role: 'user',
        content: `[REFERENCE MATERIAL]\n<selected-context>\n${this.config.selectedContext}\n</selected-context>`
      })
    }

    // Inject accumulated findings if available (Change 3)
    if (this.config.stateSummarizer?.hasContent()) {
      const summary = this.config.stateSummarizer.render()
      if (summary) {
        this.messages.push({
          role: 'user',
          content: `<accumulated-findings>\n${summary}\n</accumulated-findings>`
        })
      }
    }

    // Add user message
    this.messages.push({
      role: 'user',
      content: userPrompt
    })

    let step = 0
    let finalOutput = ''
    let retryCount = 0
    let consecutiveToolRounds = 0
    let previousResponseText = ''
    let previousToolCallCount = 0

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
        let tools = this.config.toolRegistry.generateToolSchemas(
          this.activeToolSubset ? { subset: this.activeToolSubset } : undefined
        ) as LLMToolDefinition[]
        let messagesToSend = this.messages
        let estimates: BlockEstimates | undefined

        // Determine round hint and set output reserve (Change 2)
        const roundHint = this.determineRoundHint(tools, previousResponseText, previousToolCallCount)
        let maxTokensForRound = this.config.maxTokens
        if (this.config.budgetCoordinator) {
          const outputReserve = this.config.budgetCoordinator.getOutputReserve(roundHint)
          this.config.budgetCoordinator.setOutputReserve(outputReserve)
          maxTokensForRound = outputReserve
        }

        // Inject tool subset constraint if active (Change 4)
        let subsetConstraint = ''
        if (this.activeToolSubset) {
          subsetConstraint = `\n\nOnly the following tools are available for this round: ${this.activeToolSubset.join(', ')}. Do not attempt to call unlisted tools.`
        }

        if (this.budgetManager) {
          const prepared = this.budgetManager.prepareContext({
            systemPrompt: systemPrompt + subsetConstraint,
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
        } else if (subsetConstraint) {
          systemPrompt = systemPrompt + subsetConstraint
        }

        // Send request
        this.config.trace.record({
          type: 'llm.request',
          data: {
            messagesCount: messagesToSend.length,
            roundHint,
            maxTokens: maxTokensForRound,
            toolSubset: this.activeToolSubset ?? 'all'
          }
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

        // Debug: log LLM payload metadata (not the full content)
        if (this.config.debug) {
          // Extract working-context metadata from system prompt
          const hasWorkingContext = systemPrompt.includes('<working-context>')
          const pinnedMatch = systemPrompt.match(/## Pinned Context\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const pinnedCount = pinnedMatch ? (pinnedMatch.match(/^### /gm) || []).length : 0
          const selectedMatch = systemPrompt.match(/## Selected Context\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const selectedCount = selectedMatch ? (selectedMatch.match(/^### /gm) || []).length : 0
          const sessionMatch = systemPrompt.match(/## Prior Conversation\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const sessionMsgCount = sessionMatch ? (sessionMatch.match(/^\*\*(User|Assistant|Tool)\*\*/gm) || []).length : 0
          const excludedMatch = systemPrompt.match(/\[(\d+) earlier messages in index/)
          const excludedCount = excludedMatch?.[1] ? parseInt(excludedMatch[1], 10) : 0

          // Summarize message roles in the messages array
          const msgRoles: Record<string, number> = {}
          for (const m of messagesToSend) {
            const role = typeof m.role === 'string' ? m.role : 'unknown'
            msgRoles[role] = (msgRoles[role] || 0) + 1
          }
          const msgSummary = Object.entries(msgRoles).map(([r, c]) => `${r}:${c}`).join(' ')

          console.error('[AgentLoop:debug] === LLM Request ===')
          console.error('[AgentLoop:debug] System prompt:', systemPrompt.length, 'chars |', hasWorkingContext ? 'has working-context' : 'no working-context')
          console.error('[AgentLoop:debug] Context — pinned:', pinnedCount, '| selected:', selectedCount, '| history msgs:', sessionMsgCount, '| excluded (indexed):', excludedCount)
          console.error('[AgentLoop:debug] Messages:', messagesToSend.length, `(${msgSummary})`)
          console.error('[AgentLoop:debug] Tools:', tools.length, '(' + tools.map(t => t.name).join(', ') + ')')
          console.error('[AgentLoop:debug] Round hint:', roundHint, '| maxTokens:', maxTokensForRound)
          console.error('[AgentLoop:debug] === End Request ===')
        }

        const response = await streamWithCallbacks(
          this.client,
          {
            system: systemPrompt,
            messages: messagesToSend,
            tools,
            maxTokens: maxTokensForRound,
            temperature: this.config.temperature,
            reasoningEffort: this.config.reasoningEffort
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

          // Detect context length overflow and retry with reduced messages
          const isContextOverflow = errorMessage.includes('context_length_exceeded')
            || errorMessage.includes('maximum context length')
            || errorMessage.includes('too many tokens')

          if (isContextOverflow && retryCount < 2) {
            retryCount++
            // Halve the messages to reduce context size
            const halfCount = Math.max(2, Math.floor(this.messages.length / 2))
            this.messages = this.messages.slice(-halfCount)
            this.config.trace.record({
              type: 'budget.retry',
              data: { retryCount, messagesKept: halfCount, error: errorMessage }
            })
            // Don't increment step for retry
            step--
            continue
          }

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

        // Debug: log response details
        if (this.config.debug) {
          console.error('[AgentLoop:debug] === LLM Response ===')
          console.error('[AgentLoop:debug] finishReason:', response.finishReason)
          console.error('[AgentLoop:debug] responseText length:', responseText.length)
          console.error('[AgentLoop:debug] toolCalls count:', toolCalls.length)
          console.error('[AgentLoop:debug] usage:', JSON.stringify(usage))
          console.error('[AgentLoop:debug] === End Response ===')
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

        // Detect incomplete response: finishReason='length' with no usable content.
        // This happens when the model starts a large tool call but maxOutputTokens is
        // too small — the Vercel AI SDK silently drops incomplete tool call JSON.
        if (response.finishReason === 'length' && toolCalls.length === 0 && !responseText) {
          if (retryCount < 2) {
            retryCount++
            // Remove the last user message so it gets re-sent with higher token budget
            // (the user message is still at the end of this.messages)
            this.config.trace.record({
              type: 'budget.retry',
              data: {
                retryCount,
                reason: 'incomplete_response_length',
                outputTokensUsed: usage.completionTokens
              }
            })
            console.error(`[AgentLoop] Empty response with finishReason=length (outputTokens=${usage.completionTokens}). Retrying ${retryCount}/2 with halved messages.`)
            // Reduce messages to free input budget, giving the model more room for output
            const halfCount = Math.max(2, Math.floor(this.messages.length / 2))
            this.messages = this.messages.slice(-halfCount)
            step--
            continue
          }
        }

        // Calibrate budget manager with actual usage
        if (this.budgetManager && estimates) {
          this.budgetManager.calibrate(estimates, usage)
        }

        // Store for next round's hint detection
        previousResponseText = responseText
        previousToolCallCount = toolCalls.length

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

        // If no tool calls, extract text and finish.
        // When there ARE tool calls, always execute them even if finishReason is 'stop'
        // (some providers set 'stop' when the model emits both text and tool calls).
        if (toolCalls.length === 0) {
          finalOutput = responseText
          break
        }

        // Track tool usage for subset selection (Change 4)
        this.trackToolUsage(toolCalls.map(tc => tc.name))

        // Execute tool calls
        const toolResults: ContentBlock[] = []
        let toolNotAvailableThisRound = false

        for (const toolUse of toolCalls) {
          // Check tool subset validation (Change 4)
          if (this.activeToolSubset) {
            const subsetError = this.config.toolRegistry.validateSubset(toolUse.name, this.activeToolSubset)
            if (subsetError) {
              toolNotAvailableThisRound = true
              this.config.onToolResult?.(toolUse.name, subsetError, toolUse.input)
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(subsetError),
                is_error: true
              })
              continue
            }
          }

          const result = await this.config.toolRegistry.call(
            toolUse.name,
            toolUse.input,
            {
              sessionId: this.config.runtime.sessionId,
              step,
              agentId: this.config.runtime.agentId
            }
          )

          this.config.onToolResult?.(toolUse.name, result, toolUse.input)

          // Update state summarizer (Change 3)
          if (this.config.stateSummarizer) {
            const args = (typeof toolUse.input === 'object' && toolUse.input !== null)
              ? toolUse.input as Record<string, unknown>
              : {}
            this.config.stateSummarizer.update(
              toolUse.name,
              args,
              result.success ? result.data : result.error,
              result.success,
              step
            )
          }

          // Build tool result
          // Note: JSON.stringify(undefined) returns undefined, not a string
          // We need to handle this case to avoid null content errors
          let resultContent = result.success
            ? (result.data !== undefined ? JSON.stringify(result.data, null, 2) : '{"success": true}')
            : `Error: ${result.error}`

          // Cap tool result to prevent context overflow
          const toolResultCap = this.config.budgetConfig?.toolResultCap
          if (toolResultCap && resultContent.length > toolResultCap * 3) {
            // Use structured compression instead of blind truncation (Change 1)
            const compressed = compressToolResult(toolUse.name, resultContent, toolResultCap)
            resultContent = compressed.content
          }

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

        // Circuit breaker: if TOOL_NOT_AVAILABLE happens in 2 consecutive rounds,
        // expand tool subset back to full (or L1 level) to let the model recover.
        if (toolNotAvailableThisRound) {
          this.toolNotAvailableStreak++
          if (this.toolNotAvailableStreak >= 2 && this.activeToolSubset) {
            this.config.trace.record({
              type: 'budget.degradation',
              data: {
                level: 'circuit_breaker',
                actions: ['expand_tool_subset'],
                reason: `TOOL_NOT_AVAILABLE ${this.toolNotAvailableStreak} consecutive rounds`
              }
            })
            // Expand back to full tool set
            this.activeToolSubset = undefined
            this.toolNotAvailableStreak = 0
          }
        } else {
          this.toolNotAvailableStreak = 0
        }

        // Track consecutive tool-only rounds and inject nudge if stuck
        this.toolNudgeInjected = false
        if (responseText) {
          consecutiveToolRounds = 0
        } else {
          consecutiveToolRounds++
        }

        const threshold = this.config.toolLoopThreshold ?? 7
        if (consecutiveToolRounds > 0 && consecutiveToolRounds % threshold === 0) {
          const nudge = this.config.onToolLoopNudge?.(consecutiveToolRounds)
            ?? `[System Notice] You have made ${consecutiveToolRounds} consecutive tool calls without producing any text response. Please stop calling tools and synthesize your findings into a comprehensive response now.`

          if (nudge) {
            this.messages.push({ role: 'user', content: nudge })
            this.toolNudgeInjected = true
            this.config.trace.record({
              type: 'agent.toolLoopNudge',
              data: { consecutiveToolRounds }
            })
          }
        }

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

  /**
   * Set active tool subset (Change 4)
   */
  setToolSubset(subset: string[] | undefined): void {
    this.activeToolSubset = subset
  }

  /**
   * Get recently used tool names (Change 4)
   */
  getRecentTools(): string[] {
    return this.getRecentToolNames()
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
