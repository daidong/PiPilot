/**
 * BudgetCoordinator - Single budget authority for the entire context window.
 *
 * Replaces the two-layer disconnect between the Context Pipeline (which assembles
 * history/mentions into the system prompt) and the AgentLoopBudgetManager (which
 * guards the LLM call with percentage-based allocation).
 *
 * The coordinator owns the full context window and tells both the pipeline and
 * the agent loop how much space they have.
 *
 * Budget Slots (priority order):
 *   [P1] System Identity  — NEVER cut
 *   [P1] Last User Message — NEVER cut
 *   [P2] Tool Schemas     — Cut 3rd
 *   [P2] Pack Fragments   — Cut 3rd
 *   [P2] Pinned Memory    — Cut 3rd
 *   [P3] Selected Context — Cut 2nd
 *   [P3] History Index    — Cut 2nd
 *   [P3] State Summary    — Cut 2nd
 *   [P4] Conversation Messages — Cut 1st (all remaining budget)
 *
 * Degradation Levels (with hysteresis):
 *   L0 (normal)    — usage < 70%
 *   L1 (reduced)   — enter >= 80%, exit < 70%
 *   L2 (minimal)   — enter >= 95%, exit < 80%
 *   L3 (emergency) — overflow retry only
 */

import { countTokens } from '../utils/tokenizer.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Safety margin applied to estimated input tokens to compensate for
 * estimation inaccuracy without requiring a real tokenizer.
 */
export const SAFETY_MARGIN = 1.05

/**
 * Hysteresis thresholds for degradation level transitions.
 * Shifted earlier than naive "85/100" to compensate for heuristic token
 * estimation inaccuracy (CJK text, JSON wrapping, tool schema variance).
 * Combined with SAFETY_MARGIN = 1.05, the effective buffer is ~10-15%.
 */
export const HYSTERESIS = {
  L1_ENTER: 0.80,
  L1_EXIT: 0.70,
  L2_ENTER: 0.95,
  L2_EXIT: 0.80
} as const

// ============================================================================
// Types
// ============================================================================

/**
 * Allocated token budgets for each slot
 */
export interface BudgetSlots {
  systemIdentity: number
  packFragments: number
  toolSchemas: number
  pinnedMemory: number
  selectedContext: number
  historyIndex: number
  stateSummary: number
  messages: number
  outputReserve: number
  /** Session history budget — shares a pool with selectedContext */
  sessionBudget: number
}

/**
 * Degradation action types for the new ladder
 */
export interface DegradationAction {
  type: 'compress_tool_output' | 'trim_selected' | 'drop_selected' |
        'trim_session' | 'trim_old_tool_results' | 'reduce_tools' | 'emergency_strip'
  params?: {
    capTokens?: number
    keepCount?: number
    targetTokens?: number
    toolCaps?: Record<string, number>
    totalBudget?: number
  }
}

/**
 * Output reserve strategy for dynamic output allocation
 */
export interface OutputReserveStrategy {
  /** Reserve for intermediate rounds (tool-calling rounds). Default: 4096 */
  intermediate: number
  /** Reserve for final synthesis rounds. Default: 8192 */
  final: number
  /** Reserve for extended output (explicit opt-in). Default: 16384 */
  extended: number
}

/** Round hint for determining output reserve */
export type RoundHint = 'intermediate' | 'final' | 'extended'

/**
 * Task profile for adaptive allocation
 */
export type TaskProfile = 'research' | 'coding' | 'conversation' | 'writing' | 'auto'

/**
 * Profile-based allocation parameters
 */
export interface ProfileAllocations {
  pinnedCap: number
  selectedPct: number
  sessionCap: number
  historyIndexCap: number
  stateSummaryCap: number
}

/**
 * Pre-defined allocation profiles
 */
export const PROFILES: Record<TaskProfile, ProfileAllocations> = {
  research:     { pinnedCap: 2000, selectedPct: 0.30, sessionCap: 10000, historyIndexCap: 500, stateSummaryCap: 2000 },
  coding:       { pinnedCap: 4000, selectedPct: 0.25, sessionCap: 6000,  historyIndexCap: 300, stateSummaryCap: 1500 },
  conversation: { pinnedCap: 1000, selectedPct: 0.10, sessionCap: 12000, historyIndexCap: 800, stateSummaryCap: 500 },
  writing:      { pinnedCap: 1500, selectedPct: 0.15, sessionCap: 8000,  historyIndexCap: 200, stateSummaryCap: 1000 },
  auto:         { pinnedCap: 3000, selectedPct: 0.20, sessionCap: 8000,  historyIndexCap: 500, stateSummaryCap: 2000 },
}

/**
 * Configuration for BudgetCoordinator
 */
export interface BudgetCoordinatorConfig {
  /** Total context window size in tokens */
  contextWindow: number
  /** Tokens reserved for LLM output generation (default: 4096) */
  outputReserve?: number
  /** Output reserve strategy for dynamic allocation */
  outputReserveStrategy?: OutputReserveStrategy
  /** Maximum tokens per tool result (default: 4096 tokens ~12K chars) */
  toolResultCap?: number
  /** Model ID for context window auto-detection */
  modelId?: string
  /** Priority tools to keep in emergency degradation */
  priorityTools?: string[]
  /** Task profile for adaptive allocation (default: 'auto') */
  taskProfile?: TaskProfile
}

/**
 * Measured sizes of fixed components (must be provided to allocate)
 */
export interface MeasuredComponents {
  /** Tokens for identity + constraints prompt */
  systemIdentity: number
  /** Tokens for pack prompt fragments */
  packFragments: number
  /** Tokens for all tool schemas */
  toolSchemas: number
  /** Actual tokens consumed by selected context (0 when nothing is selected).
   *  Used for shared-pool reallocation: unused selected budget flows to session. */
  actualSelectedTokens?: number
}

/**
 * Degradation result after escalation
 */
export interface DegradationResult {
  level: number
  slots: BudgetSlots
  actions: DegradationAction[]
  /** Tool subset to expose at this level (undefined = all tools) */
  toolSubset?: string[]
}

// ============================================================================
// Context Window Database
// ============================================================================

/** Known context window sizes by model prefix */
const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4-32k': 32768,
  'gpt-4': 8192,
  'gpt-5.2': 200000,
  'gpt-5.1': 200000,
  'gpt-5': 128000,
  'o1': 200000,
  'o3': 200000,
  'o4': 200000,
  'claude-opus-4': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'gemini-2': 1000000,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000
}

// ============================================================================
// Tool Groups for Subset Selection (Change 4)
// ============================================================================

export const TOOL_GROUPS: Record<string, string[]> = {
  core: ['read', 'write', 'edit', 'grep', 'glob'],
  execution: ['bash', 'exec'],
  research: ['fetch', 'web_search', 'convert_to_markdown'],
  context: ['ctx-get', 'save-note', 'list-notes'],
}

// ============================================================================
// BudgetCoordinator Implementation
// ============================================================================

export class BudgetCoordinator {
  private config: Required<BudgetCoordinatorConfig>
  private lastLevel = 0
  private taskProfile: TaskProfile

  constructor(config: BudgetCoordinatorConfig) {
    this.config = {
      contextWindow: config.contextWindow,
      outputReserve: config.outputReserve ?? 4096,
      outputReserveStrategy: config.outputReserveStrategy ?? {
        intermediate: 16384,
        final: 4096,
        extended: 16384
      },
      toolResultCap: config.toolResultCap ?? 4096,
      modelId: config.modelId ?? '',
      priorityTools: config.priorityTools ?? [],
      taskProfile: config.taskProfile ?? 'auto'
    }
    this.taskProfile = this.config.taskProfile
  }

  /**
   * Get the resolved profile allocations for the current task profile
   */
  private getProfile(): ProfileAllocations {
    return PROFILES[this.taskProfile]
  }

  /**
   * Compute allocations given measured sizes of fixed components.
   *
   * Uses shared-pool allocation so unused budget in high-priority slots
   * flows to lower-priority peers within the same pool.
   *
   * Pools:
   *   Pool A (small caps): pinned + historyIndex + stateSummary
   *     – Each gets up to its profile cap; unused remainder is discarded
   *       (these are small and don't benefit session).
   *   Pool B (context recall): selected + session
   *     – A combined pool sized by profile.selectedPct of remaining budget.
   *     – selected has priority and can use up to its percentage cap.
   *     – session gets the rest (minimum: profile.sessionCap as a floor).
   *   Messages: everything left after all pools.
   */
  allocate(measured: MeasuredComponents): BudgetSlots {
    const profile = this.getProfile()
    const available = this.config.contextWindow - this.config.outputReserve

    // P1: Fixed costs (never cut)
    const fixedCost = measured.systemIdentity + measured.packFragments + measured.toolSchemas
    let remaining = Math.max(0, available - fixedCost)

    // Pool A — small fixed-cap slots
    const pinnedMemory = Math.min(profile.pinnedCap, remaining)
    remaining -= pinnedMemory

    const historyIndex = Math.min(profile.historyIndexCap, remaining)
    remaining -= historyIndex

    const stateSummary = Math.min(profile.stateSummaryCap, remaining)
    remaining -= stateSummary

    // Pool B — shared context-recall pool (selected + session)
    // The pool gets the same total that selected alone used to get,
    // plus a guaranteed session floor. Selected has first claim; the
    // rest flows to session.
    const selectedCap = Math.min(Math.floor(remaining * profile.selectedPct), remaining)
    const poolB = selectedCap + profile.sessionCap
    const actualPool = Math.min(poolB, remaining)

    const actualSelected = measured.actualSelectedTokens ?? selectedCap
    const selectedContext = Math.min(actualSelected, selectedCap)
    const sessionBudget = Math.max(0, actualPool - selectedContext)

    remaining -= actualPool

    // P4: Messages get everything left
    const messages = Math.max(0, remaining)

    return {
      systemIdentity: measured.systemIdentity,
      packFragments: measured.packFragments,
      toolSchemas: measured.toolSchemas,
      pinnedMemory,
      selectedContext,
      historyIndex,
      stateSummary,
      messages,
      outputReserve: this.config.outputReserve,
      sessionBudget
    }
  }

  /**
   * Compute context usage ratio with safety margin.
   * usage = (estimatedInputTokens * SAFETY_MARGIN + outputReserve) / contextWindow
   */
  computeUsage(estimatedInputTokens: number): number {
    return (estimatedInputTokens * SAFETY_MARGIN + this.config.outputReserve) / this.config.contextWindow
  }

  /**
   * Escalate degradation with hysteresis.
   *
   * Levels:
   *   0 (normal)    — usage < 70%
   *   1 (reduced)   — enter >= 80%, exit < 70%: compress tool output, halve selected
   *   2 (minimal)   — enter >= 95%, exit < 80%: drop selected, halve session, compress old tools
   *   3 (emergency) — overflow retry: identity + last msg + last tool result (2K cap) + core tools
   */
  degrade(estimatedInputTokens: number, measured: MeasuredComponents): DegradationResult {
    const usage = this.computeUsage(estimatedInputTokens)

    // Determine target level with hysteresis
    let targetLevel = this.lastLevel
    if (this.lastLevel === 0) {
      if (usage >= HYSTERESIS.L1_ENTER) targetLevel = 1
      if (usage >= HYSTERESIS.L2_ENTER) targetLevel = 2
    } else if (this.lastLevel === 1) {
      if (usage < HYSTERESIS.L1_EXIT) targetLevel = 0
      else if (usage >= HYSTERESIS.L2_ENTER) targetLevel = 2
    } else if (this.lastLevel === 2) {
      if (usage < HYSTERESIS.L2_EXIT) targetLevel = 1
    }
    // L3 is only set explicitly via degradeEmergency()

    this.lastLevel = targetLevel

    return this.buildDegradationResult(targetLevel, measured)
  }

  /**
   * Force emergency degradation (Level 3) — called on overflow retry
   */
  degradeEmergency(measured: MeasuredComponents): DegradationResult {
    this.lastLevel = 3
    return this.buildDegradationResult(3, measured)
  }

  private buildDegradationResult(level: number, measured: MeasuredComponents): DegradationResult {
    const profile = this.getProfile()
    const available = this.config.contextWindow - this.config.outputReserve
    const fixedCost = measured.systemIdentity + measured.packFragments + measured.toolSchemas
    let remaining = Math.max(0, available - fixedCost)
    const actions: DegradationAction[] = []
    let toolSubset: string[] | undefined

    let pinnedMemory: number
    let selectedContext: number
    let sessionBudget: number
    let historyIndex: number
    let stateSummary: number

    const actualSelected = measured.actualSelectedTokens ?? 0

    if (level === 0) {
      // Normal — shared-pool allocation (same as allocate())
      pinnedMemory = Math.min(profile.pinnedCap, remaining)
      remaining -= pinnedMemory
      historyIndex = Math.min(profile.historyIndexCap, remaining)
      remaining -= historyIndex
      stateSummary = Math.min(profile.stateSummaryCap, remaining)
      remaining -= stateSummary

      const selectedCap = Math.min(Math.floor(remaining * profile.selectedPct), remaining)
      const poolB = Math.min(selectedCap + profile.sessionCap, remaining)
      selectedContext = Math.min(actualSelected, selectedCap)
      sessionBudget = Math.max(0, poolB - selectedContext)
      remaining -= poolB
    } else if (level === 1) {
      // Reduced: compress tool output, halve selected cap
      pinnedMemory = Math.min(profile.pinnedCap, remaining)
      remaining -= pinnedMemory
      historyIndex = Math.min(profile.historyIndexCap, remaining)
      remaining -= historyIndex
      stateSummary = Math.min(profile.stateSummaryCap, remaining)
      remaining -= stateSummary

      const selectedCap = Math.min(Math.floor(remaining * profile.selectedPct * 0.5), remaining)
      const poolB = Math.min(selectedCap + profile.sessionCap, remaining)
      selectedContext = Math.min(actualSelected, selectedCap)
      sessionBudget = Math.max(0, poolB - selectedContext)
      remaining -= poolB

      actions.push({
        type: 'compress_tool_output',
        params: {
          toolCaps: { read: 2000, grep: 1500, glob: 500, bash: 1500, fetch: 1500, _default: 2000 },
          totalBudget: Math.floor((available - fixedCost) * 0.35)
        }
      })
      actions.push({ type: 'trim_selected', params: { targetTokens: selectedContext } })
    } else if (level === 2) {
      // Minimal: drop selected, halve session, compress old tool results, reduce tools
      pinnedMemory = Math.min(Math.floor(profile.pinnedCap * 0.5), remaining)
      remaining -= pinnedMemory
      selectedContext = 0
      historyIndex = Math.min(Math.floor(profile.historyIndexCap * 0.5), remaining)
      remaining -= historyIndex
      stateSummary = Math.min(profile.stateSummaryCap, remaining)
      remaining -= stateSummary

      sessionBudget = Math.min(Math.floor(profile.sessionCap * 0.5), remaining)
      remaining -= sessionBudget

      actions.push({ type: 'drop_selected' })
      actions.push({ type: 'trim_session', params: { targetTokens: sessionBudget } })
      actions.push({
        type: 'trim_old_tool_results',
        params: { keepCount: 3, capTokens: 512 }
      })
      actions.push({ type: 'reduce_tools' })

      // Tool subset: core + recently used tools (caller fills in recent)
      toolSubset = [...(TOOL_GROUPS.core ?? [])]
    } else {
      // Emergency (L3): strip almost everything
      pinnedMemory = 0
      selectedContext = 0
      sessionBudget = 0
      historyIndex = 0
      stateSummary = 0

      actions.push({
        type: 'emergency_strip',
        params: { capTokens: 2048 }
      })

      // Core tools only
      toolSubset = [...(TOOL_GROUPS.core ?? [])]
    }

    const messages = Math.max(0, remaining)

    return {
      level,
      slots: {
        systemIdentity: measured.systemIdentity,
        packFragments: level >= 2 ? Math.floor(measured.packFragments * 0.5) : measured.packFragments,
        toolSchemas: measured.toolSchemas,
        pinnedMemory,
        selectedContext,
        historyIndex,
        stateSummary,
        messages,
        outputReserve: this.config.outputReserve,
        sessionBudget
      },
      actions,
      toolSubset
    }
  }

  /**
   * Get output reserve for a given round hint.
   */
  getOutputReserve(hint: RoundHint = 'intermediate'): number {
    return this.config.outputReserveStrategy[hint]
  }

  /**
   * Set the active output reserve (updates config for subsequent allocations)
   */
  setOutputReserve(tokens: number): void {
    this.config.outputReserve = tokens
  }

  /**
   * Cap a tool result string to the configured limit.
   * Uses ~3 chars per token heuristic.
   */
  capToolResult(content: string): string {
    const charLimit = this.config.toolResultCap * 3
    if (content.length <= charLimit) {
      return content
    }
    return content.slice(0, charLimit)
      + '\n\n[...truncated to fit context budget. Use more specific queries for details.]'
  }

  /**
   * Get the tool result cap in tokens
   */
  getToolResultCap(): number {
    return this.config.toolResultCap
  }

  /**
   * Get current degradation level
   */
  getDegradationLevel(): number {
    return this.lastLevel
  }

  /**
   * Reset degradation level (e.g., on new turn)
   */
  resetDegradation(): void {
    this.lastLevel = 0
  }

  /**
   * Get the configured context window size
   */
  getContextWindow(): number {
    return this.config.contextWindow
  }

  /**
   * Get / set task profile
   */
  getTaskProfile(): TaskProfile {
    return this.taskProfile
  }

  setTaskProfile(profile: TaskProfile): void {
    this.taskProfile = profile
  }

  /**
   * Auto-detect task profile from context signals.
   * Returns the detected profile and the reason.
   */
  static autoDetectProfile(options: {
    hasSelectedContext?: boolean
    selectedContextTokens?: number
    toolCount?: number
  }): { profile: TaskProfile; reason: string } {
    if (options.hasSelectedContext && (options.selectedContextTokens ?? 0) > 5000) {
      return { profile: 'research', reason: 'selected_context_over_5k' }
    }
    if (options.toolCount === 0) {
      return { profile: 'conversation', reason: 'no_tools_registered' }
    }
    return { profile: 'auto', reason: 'default' }
  }

  /**
   * Detect context window size for a given model ID.
   * Falls back to 128000 if unknown.
   */
  static getContextWindow(modelId: string): number {
    if (!modelId) return 128000

    // Try exact match first, then prefix match
    for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
      if (modelId === prefix || modelId.startsWith(prefix)) {
        return size
      }
    }

    // Fallback: most modern models have at least 128K
    return 128000
  }

  /**
   * Estimate token count for a string
   */
  static estimateTokens(text: string): number {
    return countTokens(text)
  }
}
