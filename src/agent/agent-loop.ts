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
  DetailedTokenUsage,
  TokenCost,
  UsageSummary
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
import { compressToolResult } from '../core/tool-result-compressor.js'
import { createChannel, type AsyncChannel } from '../utils/async-channel.js'
import type { AgentEvent } from '../types/agent-event.js'
import { classifyError, sanitizeErrorContent } from '../core/errors.js'
import { TokenTracker } from '../core/token-tracker.js'
import type { ErrorCategory } from '../core/errors.js'
import { buildFeedback, formatFeedbackAsToolResult, contextDropFeedback, policyDenialFeedback } from '../core/feedback.js'
import { RetryBudget, DEFAULT_BUDGET_CONFIG, getStrategy, computeBackoff } from '../core/retry.js'
import type { AgentHooks } from '../core/agent-hooks.js'
import { tryCatch } from '../utils/result.js'
import { MessageStore } from '../core/message-store.js'

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
  /** Resolved model ID used for token cost calculation */
  modelId?: string
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
  /** Optional builder to refresh system prompt between rounds */
  systemPromptBuilder?: () => string
  /** Maximum steps */
  maxSteps: number
  /** Maximum tokens for generation */
  maxTokens?: number
  /** Temperature */
  temperature?: number
  /** Reasoning effort for reasoning models (low, medium, high, max) */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
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

  /** Max tokens per tool result (default: 4096) */
  toolResultCap?: number

  /** Token tracker for usage and cost tracking */
  tokenTracker?: TokenTracker

  /** Callback fired after each LLM call with usage and cost info */
  onUsage?: (usage: DetailedTokenUsage, cost: TokenCost) => void

  /**
   * Error strike policy (3-strike protocol by default)
   * - After warnAfter strikes: advise alternate approach
   * - After disableAfter strikes: disable tool for this run
   */
  errorStrikePolicy?: {
    /** Number of failures before warning (default: 2) */
    warnAfter?: number
    /** Number of failures before disabling tool (default: 3) */
    disableAfter?: number
  }

  /**
   * Execute tool calls within a round in parallel (default: false).
   *
   * When true: pre-validation (3-strike, subset checks) runs sequentially,
   * then all valid tool calls execute concurrently via Promise.allSettled.
   * Results are collected in source order.
   */
  parallelToolExecution?: boolean

  /**
   * Strongly-typed lifecycle hooks for observing and gating agent behavior.
   * Complements the EventBus with compile-time safety.
   */
  hooks?: AgentHooks

  /**
   * Called just before each LLM request with the current message array.
   * Return a (possibly modified) copy of the messages to send instead.
   * Useful for RAG injection, message filtering, per-call system augmentation.
   *
   * The original message history is not modified — only the messages sent
   * to the LLM are affected. Changes do NOT persist to subsequent rounds.
   */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>

  /**
   * Messages pinned to every LLM call — prepended to messagesToSend and
   * never compacted or dropped by pre-call trimming.
   */
  pinnedMessages?: Message[]

  /**
   * Model context window size in tokens (used for GAP-6 pre-call trimming).
   * When set, messagesToSend is proactively trimmed before hitting the limit.
   */
  contextWindow?: number

  /**
   * Fraction of contextWindow at which pre-call trimming kicks in (default: 0.85).
   * E.g. 0.85 means trim when estimated tokens > contextWindow * 0.85.
   */
  preCallTrimThreshold?: number
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
 * Append guidance to a structured tool-result JSON string if possible,
 * otherwise append a plain-text note.
 */
function appendGuidance(resultContent: string, extraGuidance: string): string {
  try {
    const parsed = JSON.parse(resultContent)
    if (parsed && typeof parsed === 'object') {
      const existing = typeof parsed.guidance === 'string' ? parsed.guidance : ''
      parsed.guidance = existing ? `${existing}\n${extraGuidance}` : extraGuidance
      return JSON.stringify(parsed)
    }
  } catch {
    // fall through to plain-text append
  }
  return `${resultContent}\n${extraGuidance}`
}

/**
 * Stable stringify for tool input arguments.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${entries.join(',')}}`
}

function buildArgKey(input: unknown): string {
  return stableStringify(input)
}

function strikeKey(toolName: string, argKey: string, category: ErrorCategory): string {
  return `${toolName}::${category}::${argKey}`
}

/**
 * Agent execution loop
 */
export class AgentLoop {
  private config: AgentLoopConfig
  private client: LLMClient
  private store: MessageStore
  private stopped = false
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
  /** Per-signature consecutive failure streaks (3-strike protocol) */
  private toolErrorStreaks: Record<string, number> = {}
  /** Last error category per tool+args signature (for pre-block checks) */
  private lastErrorByArgs: Record<string, { category: ErrorCategory }> = {}
  /** Steering messages to inject before the next LLM call */
  private steeringQueue: string[] = []
  /** Follow-up prompts to continue with after the agent would otherwise stop */
  private followUpQueue: string[] = []
  /** Event channel for runStream() — null when not streaming */
  private _eventChannel: AsyncChannel<AgentEvent> | null = null
  /** Current step number exposed for event emission */
  private _currentStep = 0
  /** AbortController for the current run — aborted when stop() is called */
  private abortController: AbortController | null = null

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

    this.store = new MessageStore({
      contextWindow: config.contextWindow,
      preCallTrimThreshold: config.preCallTrimThreshold,
      transformContext: config.transformContext,
      pinnedMessages: config.pinnedMessages,
    })
  }

  /**
   * Determine round hint for trace metadata
   */
  private determineRoundHint(tools: LLMToolDefinition[], previousResponseText: string, previousToolCalls: number): 'intermediate' | 'final' {
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
    const runId = crypto.randomUUID()
    this.stopped = false
    this.abortController = new AbortController()

    // Start token tracking
    this.config.tokenTracker?.startRun(runId)
    // Start a new trace run
    this.config.trace.startRun(runId, startTime)
    const runSpanId = this.config.trace.startSpan('agent.run', { prompt: userPrompt })

    const finalizeTrace = async (params: { success: boolean; steps: number; error?: string; usage?: UsageSummary }) => {
      this.config.trace.setRunOutcome({
        success: params.success,
        error: params.error,
        steps: params.steps,
        durationMs: Date.now() - startTime
      })
      this.config.trace.setUsageSummary(params.usage)
      this.config.trace.endSpan(runSpanId, {
        success: params.success,
        steps: params.steps,
        error: params.error
      })
      await this.config.trace.flush()
    }

    // Record start
    this.config.trace.record({
      type: 'agent.start',
      data: { prompt: userPrompt }
    })

    // Hook: onRunStart
    if (this.config.hooks?.onRunStart) {
      await this.config.hooks.onRunStart({
        input: userPrompt,
        sessionId: this.config.runtime.sessionId,
        agentId: this.config.runtime.agentId
      })
    }

    // Add user message
    this.store.append({
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
    const strikePolicy = {
      warnAfter: this.config.errorStrikePolicy?.warnAfter ?? 2,
      disableAfter: this.config.errorStrikePolicy?.disableAfter ?? 3
    }
    if (strikePolicy.disableAfter < strikePolicy.warnAfter) {
      strikePolicy.disableAfter = strikePolicy.warnAfter
    }

    try {
      while (step < this.config.maxSteps && !this.stopped) {
        step++
        this.config.runtime.step = step
        this.config.trace.setStep(step)

        this._currentStep = step

        // Record step start
        this.config.trace.record({
          type: 'agent.step',
          data: { step }
        })

        // Emit step-start event for streaming consumers
        this._eventChannel?.push({ type: 'step-start', step })

        // Hook: onTurnStart
        if (this.config.hooks?.onTurnStart) {
          await this.config.hooks.onTurnStart({
            step,
            messageCount: this.store.length,
            sessionId: this.config.runtime.sessionId
          })
        }

        // Drain steering queue — inject messages as user turns before the LLM call
        while (this.steeringQueue.length > 0) {
          const steeringMsg = this.steeringQueue.shift()!
          this.config.trace.record({ type: 'agent.steering', data: { message: steeringMsg, step } })
          this.store.append({ role: 'user', content: steeringMsg })
        }

        // Prepare context (with optional budget management)
        let systemPrompt = this.config.systemPromptBuilder
          ? this.config.systemPromptBuilder()
          : this.config.systemPrompt
        let tools = this.config.toolRegistry.generateToolSchemas(
          this.activeToolSubset ? { subset: this.activeToolSubset } : undefined
        ) as LLMToolDefinition[]
        // Build LLM view: transform → pin → trim (delegated to MessageStore)
        const messagesToSend = await this.store.buildView()

        // Determine round hint for trace metadata
        const roundHint = this.determineRoundHint(tools, previousResponseText, previousToolCallCount)
        const maxTokensForRound = this.config.maxTokens

        // Inject tool subset constraint if active
        if (this.activeToolSubset) {
          const subsetConstraint = `\n\nOnly the following tools are available for this round: ${this.activeToolSubset.join(', ')}. Do not attempt to call unlisted tools.`
          systemPrompt = systemPrompt + subsetConstraint
        }

        // Send request
        const llmSpanId = this.config.trace.startSpan('llm.request', {
          messagesCount: messagesToSend.length,
          roundHint,
          maxTokens: maxTokensForRound,
          toolSubset: this.activeToolSubset ?? 'all'
        })

        // Use streaming API
        const toolCalls: ToolUseContent[] = []
        let responseText = ''
        let usage: DetailedTokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }

        let llmError: Error | undefined

        // Debug: log LLM payload metadata (not the full content)
        if (this.config.debug) {
          // Extract working-context metadata from system prompt
          const hasWorkingContext = systemPrompt.includes('<working-context>')
          const memoryMatch = systemPrompt.match(/## Memory Cards\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const memoryCardsCount = memoryMatch ? (memoryMatch.match(/^- /gm) || []).length : 0
          const selectedMatch = systemPrompt.match(/## Optional Expansion\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const selectedCount = selectedMatch ? (selectedMatch.match(/^### /gm) || []).length : 0
          const historyMatch = systemPrompt.match(/## Non-Protected History\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const protectedMatch = systemPrompt.match(/## Protected Recent Turns\n([\s\S]*?)(?=\n## |<\/working-context>)/)?.[1]
          const historyMsgCount = historyMatch ? (historyMatch.match(/^\*\*(User|Assistant|Tool)\*\*/gm) || []).length : 0
          const protectedMsgCount = protectedMatch ? (protectedMatch.match(/^\*\*(User|Assistant|Tool)\*\*/gm) || []).length : 0
          const sessionMsgCount = historyMsgCount + protectedMsgCount
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
          console.error('[AgentLoop:debug] Context — memory cards:', memoryCardsCount, '| selected:', selectedCount, '| history msgs:', sessionMsgCount, '| excluded (indexed):', excludedCount)
          console.error('[AgentLoop:debug] Messages:', messagesToSend.length, `(${msgSummary})`)
          console.error('[AgentLoop:debug] Tools:', tools.length, '(' + tools.map(t => t.name).join(', ') + ')')
          console.error('[AgentLoop:debug] Round hint:', roundHint, '| maxTokens:', maxTokensForRound)
          console.error('[AgentLoop:debug] === End Request ===')
        }

        // Wrap in tryCatch so that pre-stream throws (e.g. connection refused before
        // streaming starts) are funnelled into the existing error-recovery logic
        // rather than bubbling past the retry/context-trim paths to the outer catch.
        const streamResult = await tryCatch(() => streamWithCallbacks(
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
              this._eventChannel?.push({ type: 'text-delta', text, step })
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
              this._eventChannel?.push({ type: 'tool-call', tool: tc.toolName, toolCallId: tc.toolCallId, args: safeInput, step })
            },
            onFinish: (result) => {
              usage = result.usage

              // Record usage with token tracker
              if (this.config.tokenTracker) {
                const modelId = this.config.modelId ?? this.config.llmConfig?.model ?? ''
                const cost = this.config.tokenTracker.recordCall(modelId, usage)
                this.config.onUsage?.(usage, cost)

                // Record trace event for usage
                this.config.trace.record({
                  type: 'usage.call',
                  data: {
                    modelId,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    cachedTokens: usage.cacheReadInputTokens ?? 0,
                    cost: cost.totalCost
                  }
                })
              }
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
        ))

        // Convert a thrown error to the same structured path as onError
        const response = streamResult.ok
          ? streamResult.value
          : { finishReason: 'error' as const, text: '', toolCalls: [], id: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
        if (!streamResult.ok && !llmError) {
          llmError = streamResult.error
        }

        // Check for LLM error
        if (response.finishReason === 'error' || llmError) {
          const errorMessage = llmError?.message
            || (llmError as any)?.cause?.message
            || (typeof llmError === 'string' ? llmError : null)
            || `Unknown LLM error (finishReason: ${response.finishReason})`

          // Classify the error using the structured error system (RFC-005)
          const classifiedError = classifyError(errorMessage, 'llm')

          // Transient LLM errors (server 500, network blips, overloaded): retry with backoff, no message changes
          const isTransient = classifiedError.category === 'transient_network'
            || classifiedError.category === 'rate_limit'
            || classifiedError.category === 'timeout'
            || classifiedError.category === 'server_overload'
          if (isTransient && transientRetryCount < 3) {
            transientRetryCount++
            const backoffMs = 1000 * Math.pow(2, transientRetryCount - 1) // 1s, 2s, 4s
            console.error(`[AgentLoop] Transient LLM error (${classifiedError.category}), retrying ${transientRetryCount}/3 after ${backoffMs}ms...`)
            this.config.trace.record({
              type: 'error.retrying',
              data: { category: classifiedError.category, attempt: transientRetryCount, maxAttempts: 3, mode: 'executor_retry', backoffMs }
            })
            this._eventChannel?.push({ type: 'error', error: errorMessage, recoverable: true, step })
            await new Promise(resolve => setTimeout(resolve, backoffMs))
            step--
            continue
          }

          if (classifiedError.category === 'context_overflow' && retryCount < 2) {
            retryCount++
            // Halve the messages to reduce context size
            const history = this.store.getHistory()
            const totalMsgs = history.length
            const halfCount = Math.max(2, Math.floor(totalMsgs / 2))
            const droppedCount = totalMsgs - halfCount
            this.store.setHistory(history.slice(-halfCount))

            // Inject context-drop feedback so the LLM knows data was lost (RFC-005).
            const dropFeedback = contextDropFeedback(
              [`${droppedCount} earlier messages`],
              'Context overflow — messages trimmed to fit token limit'
            )
            this.store.append({
              role: 'assistant',
              content: 'Some earlier context was trimmed due to token limits.'
            })
            this.store.append({
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
          this.config.trace.endSpan(llmSpanId, {
            toolCallsCount: 0,
            finishReason: 'error',
            error: errorMessage,
            usage: { inputTokens: 0, outputTokens: 0 }
          })

          // Complete token tracking on early error exit
          const usageSummary = this.config.tokenTracker?.completeRun()

          // Record completion with error
          this.config.trace.record({
            type: 'agent.complete',
            data: { steps: step, success: false, error: errorMessage }
          })

          const result = {
            success: false,
            output: '',
            error: errorMessage,
            steps: step,
            trace: this.config.trace.getEvents(),
            durationMs: Date.now() - startTime,
            usage: usageSummary
          }
          await finalizeTrace({ success: false, steps: step, error: errorMessage, usage: usageSummary })
          return result
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
        this.config.trace.endSpan(llmSpanId, {
          toolCallsCount: toolCalls.length,
          finishReason: response.finishReason,
          usage: {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens
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
            // (the user message is still at the end of the message history)
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
            const history = this.store.getHistory()
            let halfCount = Math.max(2, Math.floor(history.length / 2))
            let sliced = history.slice(-halfCount)
            // Walk forward past any leading tool messages (they need their preceding assistant)
            while (sliced.length > 1 && sliced[0]?.role === 'tool') {
              halfCount--
              sliced = history.slice(-halfCount)
            }
            this.store.setHistory(sliced)
            step--
            continue
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
        this.store.append({
          role: 'assistant',
          content: assistantContent
        })

        // If no tool calls, extract text and finish.
        // When there ARE tool calls, always execute them even if finishReason is 'stop'
        // (some providers set 'stop' when the model emits both text and tool calls).
        if (toolCalls.length === 0) {
          // Emit step-finish for the final step (no tools called)
          this._eventChannel?.push({ type: 'step-finish', step, text: responseText, toolCallCount: 0 })

          finalOutput = responseText
          // Check follow-up queue before stopping — allows chained agentic pipelines
          if (this.followUpQueue.length > 0) {
            const followUpMsg = this.followUpQueue.shift()!
            this.config.trace.record({ type: 'agent.followUp', data: { message: followUpMsg, step } })
            this.store.append({ role: 'user', content: followUpMsg })
            continue
          }
          break
        }

        // Track tool usage for subset selection
        this.trackToolUsage(toolCalls.map(tc => tc.name))

        // Execute tool calls
        // Per-tool execution encapsulated as an async closure so the same logic
        // can run either sequentially or in parallel (Promise.all).
        let toolNotAvailableThisRound = false

        const executeOneToolCall = async (toolUse: ToolUseContent): Promise<ContentBlock> => {
          // Check tool subset validation
          if (this.activeToolSubset) {
            const subsetError = this.config.toolRegistry.validateSubset(toolUse.name, this.activeToolSubset)
            if (subsetError) {
              toolNotAvailableThisRound = true
              this.config.onToolResult?.(toolUse.name, subsetError, toolUse.input)
              return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(subsetError),
                is_error: true
              }
            }
          }

          // Hook: beforeToolCall — can block the tool
          if (this.config.hooks?.beforeToolCall) {
            const hookResult = await this.config.hooks.beforeToolCall({
              tool: toolUse.name,
              input: toolUse.input,
              step,
              sessionId: this.config.runtime.sessionId
            })
            if (hookResult && 'block' in hookResult && hookResult.block) {
              const blockedFeedback = policyDenialFeedback(toolUse.name, hookResult.reason, 'hook')
              const blockedContent = formatFeedbackAsToolResult(blockedFeedback)
              this.config.onToolResult?.(toolUse.name, { success: false, blocked: true, reason: hookResult.reason }, toolUse.input)
              return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: blockedContent,
                is_error: true
              }
            }
          }

          // Check repeated failure signature block (3-strike protocol)
          const argKey = buildArgKey(toolUse.input)
          const lastError = this.lastErrorByArgs[`${toolUse.name}::${argKey}`]
          if (lastError) {
            const signature = strikeKey(toolUse.name, argKey, lastError.category)
            const strikes = this.toolErrorStreaks[signature] ?? 0
            if (strikes >= strikePolicy.disableAfter) {
              const feedback = policyDenialFeedback(
                toolUse.name,
                'Repeated failure with the same parameters. Change parameters or use a different tool.',
                'error-strike'
              )
              const resultContent = formatFeedbackAsToolResult(feedback)
              this.config.onToolResult?.(toolUse.name, { success: false, error: feedback }, toolUse.input)
              this.config.trace.record({
                type: 'error.classified',
                data: { tool: toolUse.name, category: 'policy_denied', source: 'error-strike', attempt: this.toolAttempts[`${toolUse.name}:${toolUse.id}`] ?? 0 }
              })
              return {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: resultContent,
                is_error: true
              }
            }
          }

          // RFC-005: Execute tool with transparent executor_retry for transient errors
          const toolCallStart = Date.now()
          let result = await this.config.toolRegistry.call(
            toolUse.name,
            toolUse.input,
            {
              sessionId: this.config.runtime.sessionId,
              step,
              agentId: this.config.runtime.agentId,
              messages: this.store.getHistory(),
              signal: this.abortController?.signal
            }
          )

          // Transparent executor retry loop
          // GAP-12: Tool-initiated retry signal takes priority over error classification.
          // If the tool returns `retry.shouldRetry`, we retry at the executor level
          // without consulting the LLM, using the tool's suggested delay/attempts.
          if (!result.success) {
            const toolRetry = result.retry
            const useToolRetry = toolRetry?.shouldRetry === true

            const initialClassified = classifyError(result.error || 'Unknown error', { toolName: toolUse.name, stepId: step })
            const strategy = getStrategy(initialClassified.category)
            const shouldExecutorRetry = useToolRetry || strategy.mode === 'executor_retry'

            if (shouldExecutorRetry) {
              const maxAttempts = useToolRetry
                ? Math.min(toolRetry!.maxAttempts ?? 2, 5) // tool-requested, capped at 5
                : strategy.maxAttempts
              const retryCategory = useToolRetry ? 'execution' : initialClassified.category
              let retryAttempt = 0
              let lastCategory = retryCategory

              while (
                !result.success &&
                retryAttempt < maxAttempts - 1
              ) {
                // For tool-initiated retries, respect the tool's signal on each attempt.
                // For strategy-based retries, re-classify to catch category changes.
                if (useToolRetry) {
                  // Check if the latest result still wants retry
                  if (retryAttempt > 0 && result.retry?.shouldRetry !== true) break
                  if (!this.retryBudget.canRetry(retryCategory, 'yes')) break
                } else {
                  const currentError = classifyError(result.error || 'Unknown error', { toolName: toolUse.name, stepId: step })
                  const currentStrategy = getStrategy(currentError.category)
                  if (currentStrategy.mode !== 'executor_retry') break
                  if (!this.retryBudget.canRetry(currentError.category, currentError.recoverability)) break
                  lastCategory = currentError.category
                }

                this.retryBudget.record(lastCategory)
                retryAttempt++
                this.retryByMode.executor_retry++

                this.config.trace.record({
                  type: 'error.retrying',
                  data: {
                    tool: toolUse.name,
                    category: lastCategory,
                    attempt: retryAttempt,
                    mode: 'executor_retry',
                    ...(useToolRetry ? { toolInitiated: true } : {})
                  }
                })

                // Backoff: tool-requested delay or strategy-based
                const delay = useToolRetry
                  ? (toolRetry!.delayMs ?? 1000)
                  : computeBackoff(strategy.backoff, retryAttempt - 1)
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
                    messages: this.store.getHistory(),
                    signal: this.abortController?.signal
                  }
                )
              }

              // Emit recovered or exhausted
              if (result.success && retryAttempt > 0) {
                this.config.trace.record({
                  type: 'error.recovered',
                  data: { tool: toolUse.name, category: lastCategory, attempts: retryAttempt + 1, mode: 'executor_retry', ...(useToolRetry ? { toolInitiated: true } : {}) }
                })
              } else if (!result.success && retryAttempt > 0) {
                this.config.trace.record({
                  type: 'error.exhausted',
                  data: { tool: toolUse.name, category: lastCategory, attempts: retryAttempt + 1, mode: 'executor_retry', ...(useToolRetry ? { toolInitiated: true } : {}) }
                })
              }
            }
          }

          this.config.onToolResult?.(toolUse.name, result, toolUse.input)
          this._eventChannel?.push({
            type: 'tool-result',
            tool: toolUse.name,
            toolCallId: toolUse.id,
            success: result.success,
            data: result.success ? result.data : undefined,
            error: result.success ? undefined : result.error,
            durationMs: Date.now() - toolCallStart,
            step
          })

          // Hook: afterToolCall
          if (this.config.hooks?.afterToolCall) {
            await this.config.hooks.afterToolCall({
              tool: toolUse.name,
              input: toolUse.input,
              success: result.success,
              result: result.success ? result.data : undefined,
              error: result.success ? undefined : result.error,
              durationMs: Date.now() - toolCallStart,
              step,
              sessionId: this.config.runtime.sessionId
            })
          }

          // Notify skill manager of tool usage (triggers lazy loading of associated skills)
          if (this.config.runtime.skillManager) {
            this.config.runtime.skillManager.onToolUsed(toolUse.name)
          }

          // Build tool result content
          let resultContent: string
          if (result.success) {
            const recentTools = this.config.runtime.sessionState.get<string[]>('recentSuccessfulTools') ?? []
            if (!recentTools.includes(toolUse.name)) {
              recentTools.push(toolUse.name)
            }
            if (recentTools.length > 20) {
              recentTools.splice(0, recentTools.length - 20)
            }
            this.config.runtime.sessionState.set('recentSuccessfulTools', recentTools)

            // Reset error streaks for this tool+args on success (3-strike protocol)
            const successArgKey = buildArgKey(toolUse.input)
            const prefix = `${toolUse.name}::`
            const lastKey = `${toolUse.name}::${successArgKey}`
            if (this.lastErrorByArgs[lastKey]) {
              delete this.lastErrorByArgs[lastKey]
            }
            for (const key of Object.keys(this.toolErrorStreaks)) {
              if (key.startsWith(prefix) && key.endsWith(`::${successArgKey}`)) {
                delete this.toolErrorStreaks[key]
              }
            }
            // Prefer a pre-computed compact LLM summary when the tool provides one.
            // This allows tools to return rich data in `result.data` for UI consumers
            // while keeping the LLM context lean.
            resultContent = result.llmSummary
              ?? (result.data !== undefined ? JSON.stringify(result.data, null, 2) : '{"success": true}')
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

            // GAP-12: If the tool provided custom guidance in its retry signal,
            // append it to the feedback so the LLM gets tool-specific recovery advice.
            if (result.retry?.guidance) {
              resultContent = appendGuidance(resultContent, result.retry.guidance)
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
            // 3-strike protocol: warn after N failures, disable after M failures (per tool)
            const strikeEligible = !['rate_limit', 'server_overload', 'transient_network', 'timeout'].includes(errorCategory)
            if (strikeEligible) {
              const failArgKey = buildArgKey(toolUse.input)
              const signature = strikeKey(toolUse.name, failArgKey, errorCategory)
              const prev = this.toolErrorStreaks[signature] ?? 0
              const next = prev + 1
              this.toolErrorStreaks[signature] = next
              this.lastErrorByArgs[`${toolUse.name}::${failArgKey}`] = { category: errorCategory }

              if (next === strikePolicy.warnAfter) {
                resultContent = appendGuidance(
                  resultContent,
                  `STRIKE ${next}: This exact call failed multiple times. Do not retry with the same parameters. Change parameters or use a different tool.`
                )
                this.config.trace.record({
                  type: 'error.retrying',
                  data: { tool: toolUse.name, category: errorCategory, attempt: next, mode: 'agent_retry', strike: 'warn' }
                })
              } else if (next >= strikePolicy.disableAfter) {
                resultContent = appendGuidance(
                  resultContent,
                  `STRIKE ${next}: This exact call is now blocked for this run. Change parameters or use a different tool, or ask the user for help.`
                )
                this.config.trace.record({
                  type: 'error.exhausted',
                  data: { tool: toolUse.name, category: errorCategory, attempt: next, mode: 'agent_retry', strike: 'disable' }
                })
              }
            }
          }

          // Cap tool result to prevent context overflow
          const toolResultCap = this.config.toolResultCap
          if (toolResultCap && resultContent.length > toolResultCap * 3) {
            const compressed = compressToolResult(toolUse.name, resultContent, toolResultCap)
            resultContent = compressed.content
          }

          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
            is_error: !result.success
          }
        }

        // Run tools: parallel when opted in, sequential otherwise
        const toolResults: ContentBlock[] = this.config.parallelToolExecution && toolCalls.length > 1
          ? await Promise.all(toolCalls.map(executeOneToolCall))
          : await (async () => {
              const results: ContentBlock[] = []
              for (const toolUse of toolCalls) {
                results.push(await executeOneToolCall(toolUse))
              }
              return results
            })()

        // Add tool result message
        this.store.append({
          role: 'tool',
          content: toolResults
        })

        // RFC-005: Track whether any tool errored — the next LLM round is an agent_retry
        this.hadToolErrors = toolResults.some(
          (tr: any) => tr.is_error === true
        )

        // Emit step-finish for streaming consumers
        this._eventChannel?.push({ type: 'step-finish', step, text: responseText, toolCallCount: toolCalls.length })

        // Hook: onTurnEnd
        if (this.config.hooks?.onTurnEnd) {
          await this.config.hooks.onTurnEnd({
            step,
            toolCallCount: toolCalls.length,
            hadErrors: this.hadToolErrors,
            sessionId: this.config.runtime.sessionId
          })
        }

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
            this.store.append({ role: 'user', content: nudge })
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

      // Complete token tracking and get usage summary
      const usageSummary = this.config.tokenTracker?.completeRun()

      // Record completion
      this.config.trace.record({
        type: 'agent.complete',
        data: { steps: step, success: true }
      })

      const result = {
        success: true,
        output: finalOutput,
        steps: step,
        trace: this.config.trace.getEvents(),
        durationMs: Date.now() - startTime,
        usage: usageSummary
      }
      if (this.config.hooks?.onRunEnd) {
        await this.config.hooks.onRunEnd({
          output: finalOutput,
          steps: step,
          success: true,
          sessionId: this.config.runtime.sessionId,
          agentId: this.config.runtime.agentId
        })
      }
      await finalizeTrace({ success: true, steps: step, usage: usageSummary })
      return result
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

      // Complete token tracking even on error
      const usageSummary = this.config.tokenTracker?.completeRun()

      this.config.trace.record({
        type: 'agent.complete',
        data: { steps: step, success: false, error: errorMessage }
      })

      const result = {
        success: false,
        output: '',
        error: errorMessage,
        steps: step,
        trace: this.config.trace.getEvents(),
        durationMs: Date.now() - startTime,
        usage: usageSummary
      }
      if (this.config.hooks?.onRunEnd) {
        await this.config.hooks.onRunEnd({
          output: '',
          steps: step,
          success: false,
          error: errorMessage,
          sessionId: this.config.runtime.sessionId,
          agentId: this.config.runtime.agentId
        })
      }
      await finalizeTrace({ success: false, steps: step, error: errorMessage, usage: usageSummary })
      return result
    }
  }

  /**
   * Run the agent and yield events as an async iterable.
   *
   * This is the streaming-first API. Each observable action (text deltas,
   * tool calls, tool results, step boundaries, errors) is yielded as a
   * typed AgentEvent. The final `done` event contains the full AgentRunResult.
   *
   * Existing callbacks (onText, onToolCall, onToolResult) still fire alongside
   * the event stream — they are not disabled.
   *
   * @example
   * ```typescript
   * for await (const event of loop.runStream('hello')) {
   *   if (event.type === 'text-delta') process.stdout.write(event.text)
   *   if (event.type === 'done') console.log('Done:', event.result.output)
   * }
   * ```
   */
  runStream(userPrompt: string): AsyncIterable<AgentEvent> {
    const channel = createChannel<AgentEvent>()
    this._eventChannel = channel

    // Launch run() in the background — it pushes events to the channel
    // via the instrumented callback sites. When done, push the final event.
    const runPromise = this.run(userPrompt)
      .then((result) => {
        channel.push({ type: 'done', result })
        channel.done()
      })
      .catch((err) => {
        channel.push({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
          recoverable: false,
          step: this._currentStep
        })
        channel.push({
          type: 'done',
          result: {
            success: false,
            output: '',
            error: err instanceof Error ? err.message : String(err),
            steps: this._currentStep,
            trace: this.config.trace.getEvents(),
            durationMs: 0
          }
        })
        channel.done()
      })
      .finally(() => {
        this._eventChannel = null
      })

    // Prevent unhandled rejection if consumer breaks early
    runPromise.catch(() => {})

    return channel
  }

  /**
   * Stop execution
   */
  stop(): void {
    this.stopped = true
    this.abortController?.abort()
  }

  /**
   * Inject a steering message that will be delivered to the LLM before its
   * next call. Safe to call while the agent is running.
   */
  steer(message: string): void {
    this.steeringQueue.push(message)
  }

  /**
   * Queue a follow-up prompt that continues execution after the agent would
   * otherwise stop. Consumed one at a time, in order.
   */
  followUp(message: string): void {
    this.followUpQueue.push(message)
  }

  /**
   * Get message history
   */
  getMessages(): Message[] {
    return this.store.getHistory()
  }

  /**
   * Clear message history
   */
  clearMessages(): void {
    this.store.clear()
  }

  /**
   * Get LLM client
   */
  getClient(): LLMClient {
    return this.client
  }

  /**
   * Set active tool subset
   */
  setToolSubset(subset: string[] | undefined): void {
    this.activeToolSubset = subset
  }

  /**
   * Get recently used tool names   */
  getRecentTools(): string[] {
    return this.getRecentToolNames()
  }

  /**
   * Pin a message so it is prepended to every future LLM call.
   * Pinned messages are never trimmed by pre-call token estimation.
   */
  pin(message: Message): void {
    this.store.pin(message)
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
