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
import { classifyError, sanitizeErrorContent } from '../core/errors.js'
import type { ErrorCategory } from '../core/errors.js'
import { buildFeedback, formatFeedbackAsToolResult, contextDropFeedback } from '../core/feedback.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG, getStrategy, computeBackoff } from '../core/retry.js'

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

  /** Hard stop after this many consecutive tool-only rounds (default: threshold * 2) */
  maxConsecutiveToolRounds?: number

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

  /** Pre-compaction flush callback — fired once per run() when usage >= 80% */
  onPreCompaction?: () => Promise<void>
}

/**
 * Detect whether an error string is already structured feedback JSON
 * from ToolRegistry (formatFeedbackAsToolResult output).
 * Avoids re-classification which would lose validation/policy details.
 */
function isStructuredFeedback(error: string): boolean {
  if (!error.startsWith('{"success":false')) return false
  try {
    const parsed = JSON.parse(error)
    return parsed.success === false && parsed.error?.category !== undefined && parsed.guidance !== undefined
  } catch {
    return false
  }
}

/**
 * Re-sanitize structured feedback JSON to enforce the "no raw external content" rule.
 * Tools could inject unsanitized content into facts/guidance fields.
 */
function sanitizeStructuredFeedback(feedbackJson: string): string {
  try {
    const parsed = JSON.parse(feedbackJson)
    // Sanitize guidance (framework text, but could be manipulated by a tool)
    if (typeof parsed.guidance === 'string') {
      parsed.guidance = sanitizeErrorContent(parsed.guidance, 512)
    }
    // Sanitize string values in facts.data
    if (parsed.error?.data && typeof parsed.error.data === 'object') {
      for (const [key, value] of Object.entries(parsed.error.data)) {
        if (typeof value === 'string') {
          parsed.error.data[key] = sanitizeErrorContent(value, 256)
        }
      }
    }
    return JSON.stringify(parsed)
  } catch {
    // If parsing fails, sanitize the entire string
    return sanitizeErrorContent(feedbackJson, 1024)
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
  /** Error category counts across the run (RFC-005) */
  private errorCategoryCounts: Partial<Record<ErrorCategory, number>> = {}
  /** Per-run retry budget shared across executor_retry and agent_retry (RFC-005) */
  private retryBudget = new RetryBudget(DEFAULT_BUDGET_CONFIG)
  /** Per-tool attempt tracker (RFC-005) */
  private toolAttempts: Record<string, number> = {}
  /** Retry counts by mode for budget summary (RFC-005) */
  private retryByMode: { executor_retry: number; agent_retry: number } = { executor_retry: 0, agent_retry: 0 }
  /** Tokens consumed by retries (RFC-005) — executor retries cost 0, agent retries cost tokens */
  private retryTokenCost = 0
  /** Whether previous round had tool errors (next LLM call is an agent_retry) */
  private hadToolErrors = false
  /** Recently used tool names for subset selection (Change 4) */
  private recentTools: string[] = []
  /** Current tool subset (undefined = all tools) */
  private activeToolSubset: string[] | undefined
  /** Whether tool nudge was injected last round */
  private toolNudgeInjected = false
  /** Circuit breaker: consecutive rounds with TOOL_NOT_AVAILABLE errors */
  private toolNotAvailableStreak = 0
  /** Whether onPreCompaction has already fired this run */
  private preCompactionFlushed = false

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
    let transientRetryCount = 0
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
              // Ensure input is always a plain object — the Anthropic API
              // rejects tool_use blocks where input is a string or other
              // non-dict type.  LLMs occasionally produce malformed args
              // (e.g. a raw JSON string instead of an object).
              const safeInput = (tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args))
                ? tc.args
                : { _raw: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) }
              toolCalls.push({
                type: 'tool_use',
                id: tc.toolCallId,
                name: tc.toolName,
                input: safeInput
              })
              this.config.onToolCall?.(tc.toolName, safeInput)
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

          // Classify the error using the structured error system (RFC-005)
          const classifiedError = classifyError(errorMessage, 'llm')

          // Transient LLM errors (server 500, network blips): retry with backoff, no message changes
          const isTransient = classifiedError.category === 'transient_network'
            || classifiedError.category === 'rate_limit'
            || classifiedError.category === 'timeout'
          if (isTransient && transientRetryCount < 3) {
            transientRetryCount++
            const backoffMs = 1000 * Math.pow(2, transientRetryCount - 1) // 1s, 2s, 4s
            console.error(`[AgentLoop] Transient LLM error (${classifiedError.category}), retrying ${transientRetryCount}/3 after ${backoffMs}ms...`)
            this.config.trace.record({
              type: 'error.retrying',
              data: { category: classifiedError.category, attempt: transientRetryCount, maxAttempts: 3, mode: 'executor_retry', backoffMs }
            })
            await new Promise(resolve => setTimeout(resolve, backoffMs))
            step--
            continue
          }

          if (classifiedError.category === 'context_overflow' && retryCount < 2) {
            retryCount++
            // Halve the messages to reduce context size
            const totalMsgs = this.messages.length
            const halfCount = Math.max(2, Math.floor(totalMsgs / 2))
            const droppedCount = totalMsgs - halfCount
            this.messages = this.messages.slice(-halfCount)

            // Inject context-drop feedback so the LLM knows data was lost (RFC-005).
            // This is an LLM-level event (no tool_use_id), so we use the assistant/user
            // message channel with structured JSON content.
            const dropFeedback = contextDropFeedback(
              [`${droppedCount} earlier messages`],
              'Context overflow — messages trimmed to fit token limit'
            )
            this.messages.push({
              role: 'assistant',
              content: 'Some earlier context was trimmed due to token limits.'
            })
            this.messages.push({
              role: 'user',
              content: formatFeedbackAsToolResult(dropFeedback)
            })

            this.config.trace.record({
              type: 'budget.retry',
              data: { retryCount, messagesKept: halfCount, droppedMessages: droppedCount, error: errorMessage }
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

        // RFC-005: If the previous round had tool errors, this LLM round is an
        // agent_retry. Track token cost so the budget summary includes it.
        if (this.hadToolErrors) {
          this.retryTokenCost += (usage.promptTokens + usage.completionTokens)
          this.hadToolErrors = false
        }

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
            // Reduce messages to free input budget, giving the model more room for output.
            // Ensure we don't orphan tool results from their assistant tool_call messages.
            let halfCount = Math.max(2, Math.floor(this.messages.length / 2))
            let sliced = this.messages.slice(-halfCount)
            // Walk forward past any leading tool messages (they need their preceding assistant)
            while (sliced.length > 1 && sliced[0]?.role === 'tool') {
              halfCount--
              sliced = this.messages.slice(-halfCount)
            }
            this.messages = sliced
            step--
            continue
          }
        }

        // Calibrate budget manager with actual usage
        if (this.budgetManager && estimates) {
          this.budgetManager.calibrate(estimates, usage)
        }

        // Pre-compaction flush: fire once when usage reaches 80% of context window
        if (
          !this.preCompactionFlushed &&
          this.config.onPreCompaction &&
          this.config.budgetCoordinator
        ) {
          const usageRatio = this.config.budgetCoordinator.computeUsage(usage.promptTokens)
          if (usageRatio >= 0.80) {
            this.preCompactionFlushed = true
            await this.config.onPreCompaction()
          }
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

          // RFC-005: Execute tool with transparent executor_retry for transient errors
          let result = await this.config.toolRegistry.call(
            toolUse.name,
            toolUse.input,
            {
              sessionId: this.config.runtime.sessionId,
              step,
              agentId: this.config.runtime.agentId,
              messages: this.messages
            }
          )

          // Transparent executor retry loop (rate_limit, transient_network, timeout)
          if (!result.success) {
            const initialClassified = classifyError(result.error || 'Unknown error', { toolName: toolUse.name, stepId: step })
            const strategy = getStrategy(initialClassified.category)

            if (strategy.mode === 'executor_retry') {
              let retryAttempt = 0
              let lastCategory = initialClassified.category

              while (
                !result.success &&
                retryAttempt < strategy.maxAttempts - 1
              ) {
                // Re-classify current error to catch category changes between retries
                const currentError = classifyError(result.error || 'Unknown error', { toolName: toolUse.name, stepId: step })
                const currentStrategy = getStrategy(currentError.category)

                // Stop if the error is no longer executor-retryable
                if (currentStrategy.mode !== 'executor_retry') break
                if (!this.retryBudget.canRetry(currentError.category, currentError.recoverability)) break

                this.retryBudget.record(currentError.category)
                retryAttempt++
                lastCategory = currentError.category
                this.retryByMode.executor_retry++

                this.config.trace.record({
                  type: 'error.retrying',
                  data: { tool: toolUse.name, category: currentError.category, attempt: retryAttempt, mode: 'executor_retry' }
                })

                // Backoff using the current error's strategy
                const delay = computeBackoff(currentStrategy.backoff, retryAttempt - 1)
                if (delay > 0) {
                  await new Promise(resolve => setTimeout(resolve, delay))
                }

                result = await this.config.toolRegistry.call(
                  toolUse.name,
                  toolUse.input,
                  {
                    sessionId: this.config.runtime.sessionId,
                    step,
                    agentId: this.config.runtime.agentId,
                    messages: this.messages
                  }
                )
              }

              // Emit recovered or exhausted
              if (result.success && retryAttempt > 0) {
                this.config.trace.record({
                  type: 'error.recovered',
                  data: { tool: toolUse.name, category: lastCategory, attempts: retryAttempt + 1, mode: 'executor_retry' }
                })
              } else if (!result.success && retryAttempt > 0) {
                this.config.trace.record({
                  type: 'error.exhausted',
                  data: { tool: toolUse.name, category: lastCategory, attempts: retryAttempt + 1, mode: 'executor_retry' }
                })
              }
            }
          }

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

          // Build tool result content
          let resultContent: string
          if (result.success) {
            resultContent = result.data !== undefined ? JSON.stringify(result.data, null, 2) : '{"success": true}'
          } else {
            const errorStr = result.error || 'Unknown error'
            const attemptKey = `${toolUse.name}:${toolUse.id}`
            this.toolAttempts[attemptKey] = (this.toolAttempts[attemptKey] || 0) + 1

            // Determine category for budget tracking
            let errorCategory: ErrorCategory = 'unknown'

            if (isStructuredFeedback(errorStr)) {
              // RFC-005: Pre-structured feedback from ToolRegistry — re-sanitize
              // facts and guidance to enforce the "no raw external content" rule,
              // then pass through to preserve validation/policy details.
              resultContent = sanitizeStructuredFeedback(errorStr)

              try {
                const parsed = JSON.parse(errorStr)
                errorCategory = parsed.error?.category ?? 'unknown'
                this.config.trace.record({
                  type: 'error.classified',
                  data: { tool: toolUse.name, category: errorCategory, attempt: this.toolAttempts[attemptKey], preStructured: true }
                })
              } catch {
                // Parsing failed — still use the sanitized string
              }
            } else {
              // Classify raw error and build feedback
              const classified = classifyError(errorStr, { toolName: toolUse.name, stepId: step })
              classified.attempt = this.toolAttempts[attemptKey]
              errorCategory = classified.category

              this.config.trace.record({
                type: 'error.classified',
                data: { tool: toolUse.name, category: classified.category, source: classified.source, attempt: classified.attempt }
              })

              const feedback = buildFeedback(classified)
              resultContent = formatFeedbackAsToolResult(feedback)
            }

            // RFC-005: Track agent-retry budget — the LLM seeing this error is an
            // agent_retry attempt. Record it and append exhaustion guidance if needed.
            this.retryByMode.agent_retry++
            this.errorCategoryCounts[errorCategory] = (this.errorCategoryCounts[errorCategory] || 0) + 1

            if (!this.retryBudget.canRetry(errorCategory, 'yes')) {
              // Budget exhausted — append guidance telling the LLM to stop retrying
              try {
                const parsed = JSON.parse(resultContent)
                parsed.guidance = (parsed.guidance || '') + ' RETRY BUDGET EXHAUSTED: Do not retry this tool. Try a different approach or report the failure.'
                resultContent = JSON.stringify(parsed)
              } catch {
                resultContent += '\n[RETRY BUDGET EXHAUSTED: Do not retry this tool.]'
              }
            }
            this.retryBudget.record(errorCategory)
          }

          // Cap tool result to prevent context overflow
          const toolResultCap = this.config.budgetConfig?.toolResultCap
          if (toolResultCap && resultContent.length > toolResultCap * 3) {
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

        // RFC-005: Track whether any tool errored — the next LLM round is an agent_retry
        this.hadToolErrors = toolResults.some(
          (tr: any) => tr.is_error === true
        )

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

        // Hard stop: too many consecutive tool-only rounds
        const hardLimit = this.config.maxConsecutiveToolRounds ?? (threshold * 2)
        if (consecutiveToolRounds >= hardLimit) {
          finalOutput += '\n[Stopped: too many consecutive tool calls without a response]'
          this.config.trace.record({
            type: 'agent.toolLoopHardStop',
            data: { consecutiveToolRounds }
          })
          break
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

      // Emit error budget summary (RFC-005)
      const totalErrors = Object.values(this.errorCategoryCounts).reduce((a, b) => a + (b || 0), 0)
      const retryStats = this.retryBudget.stats()
      if (totalErrors > 0 || retryStats.total > 0) {
        this.config.trace.record({
          type: 'error.budget_summary',
          data: {
            totalErrors,
            byCategory: { ...this.errorCategoryCounts },
            retries: retryStats,
            byMode: { ...this.retryByMode },
            tokensConsumedByRetries: this.retryTokenCost
          }
        })
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

      // Emit error budget summary (RFC-005)
      const totalErrors2 = Object.values(this.errorCategoryCounts).reduce((a, b) => a + (b || 0), 0)
      const retryStats2 = this.retryBudget.stats()
      if (totalErrors2 > 0 || retryStats2.total > 0) {
        this.config.trace.record({
          type: 'error.budget_summary',
          data: {
            totalErrors: totalErrors2,
            byCategory: { ...this.errorCategoryCounts },
            retries: retryStats2,
            byMode: { ...this.retryByMode },
            tokensConsumedByRetries: this.retryTokenCost
          }
        })
      }

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
