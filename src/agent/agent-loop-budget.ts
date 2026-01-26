/**
 * AgentLoopBudgetManager - Coordinates budget components for AgentLoop
 *
 * Integrates:
 * - UnifiedBudgeter: Overall token budget management
 * - TokenEstimator: Block-level token estimation with calibration
 * - AdaptiveMessageSelector: Message selection when budget is tight
 *
 * Provides:
 * - prepareContext(): Optimize context before LLM call
 * - calibrate(): Update estimators with actual usage
 * - Decision logging for debugging
 */

import type { Message } from '../types/session.js'
import type { LLMToolDefinition, TokenUsage } from '../llm/index.js'
import {
  UnifiedBudgeter,
  createBudgeterForModel,
  type BudgetDecision,
  type DegradationAction
} from '../core/unified-budgeter.js'
import {
  TokenEstimator,
  createTokenEstimator,
  type BlockEstimate
} from '../core/token-estimator.js'
import {
  AdaptiveMessageSelector,
  createMessageSelector,
  type SelectionStrategy
} from '../core/adaptive-message-selector.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for AgentLoopBudgetManager
 */
export interface BudgetManagerConfig {
  /** Model ID for context window detection */
  modelId?: string
  /** Override context window size */
  contextWindow?: number
  /** Budget allocation percentages */
  allocation?: {
    /** System prompt allocation (default: 0.15) */
    system?: number
    /** Tools allocation (default: 0.25) */
    tools?: number
    /** Messages allocation (default: 0.60) */
    messages?: number
  }
  /** Priority tools to keep in minimal mode */
  priorityTools?: string[]
  /** Message selection strategy (default: recent-first) */
  messageStrategy?: SelectionStrategy
}

/**
 * Block estimates for all context components
 */
export interface BlockEstimates {
  system: BlockEstimate
  tools: BlockEstimate
  messages: BlockEstimate
}

/**
 * Prepared context after budget optimization
 */
export interface PreparedContext {
  /** Optimized system prompt */
  systemPrompt: string
  /** Optimized tool schemas */
  tools: LLMToolDefinition[]
  /** Selected messages */
  messages: Message[]
  /** Budget decision made */
  decision: BudgetDecision
  /** Token estimates used */
  estimates: BlockEstimates
  /** Number of messages excluded */
  messagesExcluded: number
  /** Warning message if any */
  warning?: string
}

/**
 * LLM message format for estimation
 */
interface LLMMessage {
  role: string
  content: string
}

// ============================================================================
// AgentLoopBudgetManager Implementation
// ============================================================================

/**
 * AgentLoopBudgetManager - Coordinates budget management for AgentLoop
 *
 * @example
 * ```typescript
 * const budgetManager = new AgentLoopBudgetManager({ modelId: 'gpt-4o' })
 *
 * // Prepare context before LLM call
 * const prepared = budgetManager.prepareContext({
 *   systemPrompt,
 *   tools: toolSchemas,
 *   messages: conversationHistory
 * })
 *
 * // Use prepared context
 * const response = await llm.chat({
 *   system: prepared.systemPrompt,
 *   tools: prepared.tools,
 *   messages: prepared.messages
 * })
 *
 * // Calibrate with actual usage
 * budgetManager.calibrate(prepared.estimates, response.usage)
 * ```
 */
export class AgentLoopBudgetManager {
  private budgeter: UnifiedBudgeter
  private estimator: TokenEstimator
  private messageSelector: AdaptiveMessageSelector
  private config: BudgetManagerConfig

  constructor(config: BudgetManagerConfig = {}) {
    this.config = config

    // Create budgeter with model-specific defaults
    if (config.modelId) {
      this.budgeter = createBudgeterForModel(config.modelId)
    } else {
      this.budgeter = new UnifiedBudgeter({
        contextWindow: config.contextWindow,
        systemAllocationPct: config.allocation?.system,
        toolsAllocationPct: config.allocation?.tools,
        messagesAllocationPct: config.allocation?.messages,
        priorityTools: config.priorityTools
      })
    }

    // Create token estimator
    this.estimator = createTokenEstimator(config.modelId)

    // Create message selector
    this.messageSelector = createMessageSelector()
  }

  /**
   * Prepare context for LLM call with budget optimization
   */
  prepareContext(params: {
    systemPrompt: string
    tools: LLMToolDefinition[]
    messages: Message[]
  }): PreparedContext {
    const { systemPrompt, tools, messages } = params

    // 1. Estimate current token usage
    const estimates = this.estimateAll(systemPrompt, tools, messages)

    // 2. Evaluate budget and get decision
    const decision = this.budgeter.evaluate(
      estimates.system.calibrated,
      estimates.tools.calibrated,
      estimates.messages.calibrated
    )

    // 3. Apply degradation if needed
    let finalSystemPrompt = systemPrompt
    let finalTools = tools
    let finalMessages = messages
    let messagesExcluded = 0

    if (decision.level !== 'normal') {
      // Apply message selection if there's a reduce_messages action
      const reduceMessagesAction = decision.actions.find(
        a => a.type === 'reduce_messages'
      )

      if (reduceMessagesAction && reduceMessagesAction.type === 'reduce_messages') {
        const result = this.messageSelector.select(
          this.toLLMMessages(messages) as Message[],
          {
            budget: reduceMessagesAction.targetTokens,
            strategy: this.config.messageStrategy ?? 'recent-first',
            minMessages: 1,
            includeFirstUser: true
          }
        )
        finalMessages = result.messages as Message[]
        messagesExcluded = result.excludedCount
      }

      // Handle tool reduction if needed (future enhancement)
      const reduceToolsAction = decision.actions.find(a => a.type === 'reduce_tools')
      if (reduceToolsAction && reduceToolsAction.type === 'reduce_tools') {
        finalTools = this.reduceTools(tools, reduceToolsAction)
      }

      // Handle system prompt reduction if needed (future enhancement)
      const reduceSystemAction = decision.actions.find(a => a.type === 'reduce_system')
      if (reduceSystemAction && reduceSystemAction.type === 'reduce_system') {
        finalSystemPrompt = this.reduceSystemPrompt(systemPrompt, reduceSystemAction)
      }
    }

    return {
      systemPrompt: finalSystemPrompt,
      tools: finalTools,
      messages: finalMessages,
      decision,
      estimates,
      messagesExcluded,
      warning: decision.warning
    }
  }

  /**
   * Calibrate estimators with actual token usage from LLM response
   */
  calibrate(estimates: BlockEstimates, actualUsage: TokenUsage): void {
    const total = actualUsage.promptTokens

    // Distribute actual tokens across blocks proportionally
    const estimatedTotal =
      estimates.system.estimated +
      estimates.tools.estimated +
      estimates.messages.estimated

    if (estimatedTotal > 0) {
      const ratio = total / estimatedTotal

      this.estimator.calibrate(
        'system',
        estimates.system.estimated,
        Math.floor(estimates.system.estimated * ratio)
      )
      this.estimator.calibrate(
        'tools',
        estimates.tools.estimated,
        Math.floor(estimates.tools.estimated * ratio)
      )
      this.estimator.calibrate(
        'messages',
        estimates.messages.estimated,
        Math.floor(estimates.messages.estimated * ratio)
      )
    }
  }

  /**
   * Estimate tokens for all blocks
   */
  private estimateAll(
    systemPrompt: string,
    tools: LLMToolDefinition[],
    messages: Message[]
  ): BlockEstimates {
    return {
      system: this.estimator.estimateSystem(systemPrompt),
      tools: this.estimator.estimateTools(tools),
      messages: this.estimator.estimateMessages(this.toLLMMessages(messages))
    }
  }

  /**
   * Convert messages to LLM format for estimation
   */
  private toLLMMessages(messages: Message[]): LLMMessage[] {
    return messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }))
  }

  /**
   * Reduce tools to fit budget (keep priority tools)
   */
  private reduceTools(
    tools: LLMToolDefinition[],
    action: Extract<DegradationAction, { type: 'reduce_tools' }>
  ): LLMToolDefinition[] {
    const priorityTools = action.priorityTools ?? this.config.priorityTools ?? []
    const targetTokens = action.targetTokens

    // Always keep priority tools
    const prioritySet = new Set(priorityTools)
    const priority = tools.filter(t => prioritySet.has(t.name))
    const nonPriority = tools.filter(t => !prioritySet.has(t.name))

    // Check if priority tools alone fit
    const priorityTokens = this.estimator.estimateTools(priority).calibrated
    if (priorityTokens >= targetTokens) {
      return priority
    }

    // Add non-priority tools until budget exhausted
    const result = [...priority]
    let usedTokens = priorityTokens

    for (const tool of nonPriority) {
      const toolTokens = this.estimator.estimateToolSchema(tool)
      if (usedTokens + toolTokens <= targetTokens) {
        result.push(tool)
        usedTokens += toolTokens
      }
    }

    return result
  }

  /**
   * Reduce system prompt to fit budget
   * Currently a simple truncation - could be enhanced with smarter summarization
   */
  private reduceSystemPrompt(
    prompt: string,
    action: Extract<DegradationAction, { type: 'reduce_system' }>
  ): string {
    const targetTokens = action.targetTokens
    const currentEstimate = this.estimator.estimateSystem(prompt)

    if (currentEstimate.calibrated <= targetTokens) {
      return prompt
    }

    // Simple truncation ratio
    const ratio = targetTokens / currentEstimate.calibrated
    const targetLength = Math.floor(prompt.length * ratio * 0.9) // 10% safety margin

    // Truncate with ellipsis
    if (targetLength < prompt.length) {
      return prompt.slice(0, targetLength) + '\n\n[System prompt truncated due to token budget]'
    }

    return prompt
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  /**
   * Get the underlying budgeter
   */
  getBudgeter(): UnifiedBudgeter {
    return this.budgeter
  }

  /**
   * Get the underlying estimator
   */
  getEstimator(): TokenEstimator {
    return this.estimator
  }

  /**
   * Get the underlying message selector
   */
  getMessageSelector(): AdaptiveMessageSelector {
    return this.messageSelector
  }

  /**
   * Get current budget usage
   */
  getUsage() {
    return this.budgeter.getUsage()
  }

  /**
   * Get current allocation
   */
  getAllocation() {
    return this.budgeter.getAllocation()
  }

  /**
   * Reset budget state
   */
  reset(): void {
    this.budgeter.reset()
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an AgentLoopBudgetManager
 */
export function createAgentLoopBudgetManager(
  config: BudgetManagerConfig = {}
): AgentLoopBudgetManager {
  return new AgentLoopBudgetManager(config)
}
