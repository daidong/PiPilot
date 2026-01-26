/**
 * UnifiedBudgeter - Unified token budget management
 *
 * Manages token budget across all context components:
 * - System prompt (framework guide, identity, constraints)
 * - Tool schemas (function definitions sent to LLM)
 * - Messages (conversation history)
 *
 * Provides degradation levels and actions when budget is tight.
 */

import { countTokens } from '../utils/tokenizer.js'

/**
 * Budget allocation for different components
 */
export interface BudgetAllocation {
  /** Total context window size */
  contextWindow: number
  /** Reserved for LLM output generation */
  outputReserve: number
  /** System prompt budget (identity, constraints, framework guide) */
  systemBudget: number
  /** Tool schemas budget */
  toolsBudget: number
  /** Messages budget (conversation history) */
  messagesBudget: number
}

/**
 * Current budget usage
 */
export interface BudgetUsage {
  system: number
  tools: number
  messages: number
  total: number
  remaining: number
}

/**
 * Degradation level
 */
export type DegradationLevel = 'normal' | 'reduced' | 'minimal'

/**
 * Degradation action to take
 */
export type DegradationAction =
  | { type: 'none' }
  | { type: 'reduce_system'; targetTokens: number }
  | { type: 'reduce_tools'; targetTokens: number; priorityTools?: string[] }
  | { type: 'reduce_messages'; targetTokens: number }
  | { type: 'reduce_all'; systemTarget: number; toolsTarget: number; messagesTarget: number }

/**
 * Budget decision result
 */
export interface BudgetDecision {
  /** Current degradation level */
  level: DegradationLevel
  /** Actions to take */
  actions: DegradationAction[]
  /** Whether we can proceed */
  canProceed: boolean
  /** Warning message if any */
  warning?: string
  /** Estimated usage after actions */
  estimatedUsage: BudgetUsage
}

/**
 * Tool schema cache entry
 */
interface ToolSchemaCache {
  schema: unknown
  tokens: number
  timestamp: number
}

/**
 * Configuration for UnifiedBudgeter
 */
export interface UnifiedBudgeterConfig {
  /** Context window size (default: 128000 for GPT-4) */
  contextWindow?: number
  /** Output reserve tokens (default: 4096) */
  outputReserve?: number
  /** System prompt allocation percentage (default: 0.15) */
  systemAllocationPct?: number
  /** Tools allocation percentage (default: 0.25) */
  toolsAllocationPct?: number
  /** Messages allocation percentage (default: 0.60) */
  messagesAllocationPct?: number
  /** Warning threshold percentage (default: 0.85) */
  warningThreshold?: number
  /** Priority tools to keep in minimal mode */
  priorityTools?: string[]
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  contextWindow: 128000,
  outputReserve: 4096,
  systemAllocationPct: 0.15,
  toolsAllocationPct: 0.25,
  messagesAllocationPct: 0.60,
  warningThreshold: 0.85,
  // Minimum budgets to avoid complete elimination
  minSystemBudget: 500,
  minToolsBudget: 1000,
  minMessagesBudget: 2000
}

/**
 * UnifiedBudgeter - Manages token budget across all context components
 */
export class UnifiedBudgeter {
  private config: Required<UnifiedBudgeterConfig>
  private allocation: BudgetAllocation
  private usage: BudgetUsage
  private toolSchemaCache = new Map<string, ToolSchemaCache>()

  constructor(config: UnifiedBudgeterConfig = {}) {
    this.config = {
      contextWindow: config.contextWindow ?? DEFAULTS.contextWindow,
      outputReserve: config.outputReserve ?? DEFAULTS.outputReserve,
      systemAllocationPct: config.systemAllocationPct ?? DEFAULTS.systemAllocationPct,
      toolsAllocationPct: config.toolsAllocationPct ?? DEFAULTS.toolsAllocationPct,
      messagesAllocationPct: config.messagesAllocationPct ?? DEFAULTS.messagesAllocationPct,
      warningThreshold: config.warningThreshold ?? DEFAULTS.warningThreshold,
      priorityTools: config.priorityTools ?? []
    }

    this.allocation = this.calculateAllocation()
    this.usage = { system: 0, tools: 0, messages: 0, total: 0, remaining: this.getAvailableBudget() }
  }

  /**
   * Calculate budget allocation based on config
   */
  private calculateAllocation(): BudgetAllocation {
    const available = this.config.contextWindow - this.config.outputReserve
    return {
      contextWindow: this.config.contextWindow,
      outputReserve: this.config.outputReserve,
      systemBudget: Math.floor(available * this.config.systemAllocationPct),
      toolsBudget: Math.floor(available * this.config.toolsAllocationPct),
      messagesBudget: Math.floor(available * this.config.messagesAllocationPct)
    }
  }

  /**
   * Get available budget (context window minus output reserve)
   */
  getAvailableBudget(): number {
    return this.config.contextWindow - this.config.outputReserve
  }

  /**
   * Get current allocation
   */
  getAllocation(): BudgetAllocation {
    return { ...this.allocation }
  }

  /**
   * Get current usage
   */
  getUsage(): BudgetUsage {
    return { ...this.usage }
  }

  /**
   * Update system prompt token count
   */
  setSystemTokens(tokens: number): void {
    this.usage.system = tokens
    this.updateTotals()
  }

  /**
   * Update tools schema token count
   */
  setToolsTokens(tokens: number): void {
    this.usage.tools = tokens
    this.updateTotals()
  }

  /**
   * Update messages token count
   */
  setMessagesTokens(tokens: number): void {
    this.usage.messages = tokens
    this.updateTotals()
  }

  /**
   * Update total usage calculations
   */
  private updateTotals(): void {
    this.usage.total = this.usage.system + this.usage.tools + this.usage.messages
    this.usage.remaining = this.getAvailableBudget() - this.usage.total
  }

  /**
   * Count tokens for a tool schema and cache the result
   */
  countToolSchemaTokens(toolName: string, schema: unknown): number {
    const cached = this.toolSchemaCache.get(toolName)
    const schemaStr = JSON.stringify(schema)

    // Check if cached and schema hasn't changed
    if (cached && JSON.stringify(cached.schema) === schemaStr) {
      return cached.tokens
    }

    // Count tokens for the schema
    const tokens = countTokens(schemaStr)

    // Cache the result
    this.toolSchemaCache.set(toolName, {
      schema,
      tokens,
      timestamp: Date.now()
    })

    return tokens
  }

  /**
   * Get cached tool schema tokens
   */
  getCachedToolTokens(toolName: string): number | undefined {
    return this.toolSchemaCache.get(toolName)?.tokens
  }

  /**
   * Clear tool schema cache
   */
  clearToolCache(): void {
    this.toolSchemaCache.clear()
  }

  /**
   * Calculate total tokens for all tool schemas
   */
  calculateTotalToolTokens(schemas: Array<{ name: string; schema: unknown }>): number {
    let total = 0
    for (const { name, schema } of schemas) {
      total += this.countToolSchemaTokens(name, schema)
    }
    return total
  }

  /**
   * Evaluate current budget and decide on degradation actions
   */
  evaluate(
    systemTokens: number,
    toolsTokens: number,
    messagesTokens: number
  ): BudgetDecision {
    const total = systemTokens + toolsTokens + messagesTokens
    const available = this.getAvailableBudget()
    const usageRatio = total / available

    // Update internal state
    this.usage = {
      system: systemTokens,
      tools: toolsTokens,
      messages: messagesTokens,
      total,
      remaining: available - total
    }

    // Determine degradation level
    let level: DegradationLevel = 'normal'
    const actions: DegradationAction[] = []

    if (usageRatio > 1.0) {
      // Over budget - need aggressive reduction
      level = 'minimal'
      const overflow = total - available

      // Calculate reduction targets
      const reductionRatio = Math.min(0.5, overflow / total + 0.1) // At least 10% reduction

      // Prioritize: reduce messages first, then tools, then system
      if (messagesTokens > DEFAULTS.minMessagesBudget) {
        const messagesTarget = Math.max(
          DEFAULTS.minMessagesBudget,
          Math.floor(messagesTokens * (1 - reductionRatio))
        )
        actions.push({ type: 'reduce_messages', targetTokens: messagesTarget })
      }

      if (toolsTokens > DEFAULTS.minToolsBudget) {
        const toolsTarget = Math.max(
          DEFAULTS.minToolsBudget,
          Math.floor(toolsTokens * (1 - reductionRatio * 0.5))
        )
        actions.push({
          type: 'reduce_tools',
          targetTokens: toolsTarget,
          priorityTools: this.config.priorityTools
        })
      }

      if (systemTokens > DEFAULTS.minSystemBudget) {
        const systemTarget = Math.max(
          DEFAULTS.minSystemBudget,
          Math.floor(systemTokens * (1 - reductionRatio * 0.3))
        )
        actions.push({ type: 'reduce_system', targetTokens: systemTarget })
      }
    } else if (usageRatio > this.config.warningThreshold) {
      // Near budget - moderate reduction
      level = 'reduced'

      // Light reduction on messages
      if (messagesTokens > this.allocation.messagesBudget) {
        actions.push({
          type: 'reduce_messages',
          targetTokens: Math.floor(this.allocation.messagesBudget * 0.9)
        })
      }
    }

    // Calculate estimated usage after actions
    const estimatedUsage = this.estimateUsageAfterActions(actions)

    return {
      level,
      actions,
      canProceed: estimatedUsage.total <= available,
      warning: usageRatio > this.config.warningThreshold
        ? `Token usage at ${Math.round(usageRatio * 100)}% of available budget`
        : undefined,
      estimatedUsage
    }
  }

  /**
   * Estimate usage after applying degradation actions
   */
  private estimateUsageAfterActions(actions: DegradationAction[]): BudgetUsage {
    let system = this.usage.system
    let tools = this.usage.tools
    let messages = this.usage.messages

    for (const action of actions) {
      switch (action.type) {
        case 'reduce_system':
          system = Math.min(system, action.targetTokens)
          break
        case 'reduce_tools':
          tools = Math.min(tools, action.targetTokens)
          break
        case 'reduce_messages':
          messages = Math.min(messages, action.targetTokens)
          break
        case 'reduce_all':
          system = Math.min(system, action.systemTarget)
          tools = Math.min(tools, action.toolsTarget)
          messages = Math.min(messages, action.messagesTarget)
          break
      }
    }

    const total = system + tools + messages
    return {
      system,
      tools,
      messages,
      total,
      remaining: this.getAvailableBudget() - total
    }
  }

  /**
   * Get usage percentage
   */
  getUsagePercentage(): number {
    return (this.usage.total / this.getAvailableBudget()) * 100
  }

  /**
   * Check if budget allows for a specific operation
   */
  canAfford(additionalTokens: number): boolean {
    return this.usage.total + additionalTokens <= this.getAvailableBudget()
  }

  /**
   * Reset usage counters
   */
  reset(): void {
    this.usage = { system: 0, tools: 0, messages: 0, total: 0, remaining: this.getAvailableBudget() }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<UnifiedBudgeterConfig>): void {
    Object.assign(this.config, config)
    this.allocation = this.calculateAllocation()
    this.updateTotals()
  }

  /**
   * Create a snapshot of current state for debugging
   */
  snapshot(): {
    config: UnifiedBudgeterConfig
    allocation: BudgetAllocation
    usage: BudgetUsage
    cachedTools: number
  } {
    return {
      config: { ...this.config },
      allocation: { ...this.allocation },
      usage: { ...this.usage },
      cachedTools: this.toolSchemaCache.size
    }
  }
}

/**
 * Create a budgeter with model-specific defaults
 */
export function createBudgeterForModel(modelId: string): UnifiedBudgeter {
  // Model-specific context window sizes
  const contextWindows: Record<string, number> = {
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-4-turbo': 128000,
    'gpt-4o': 128000,
    'gpt-5': 128000,
    'gpt-5.1': 200000,
    'gpt-5.2': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-sonnet': 200000,
    'claude-opus-4': 200000
  }

  // Find matching context window
  let contextWindow = DEFAULTS.contextWindow
  for (const [prefix, size] of Object.entries(contextWindows)) {
    if (modelId.startsWith(prefix) || modelId.includes(prefix)) {
      contextWindow = size
      break
    }
  }

  return new UnifiedBudgeter({ contextWindow })
}
