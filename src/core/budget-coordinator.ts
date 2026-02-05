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
 *   [P2] Project Cards    — Cut 3rd
 *   [P2] Working Set      — Cut 3rd
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
  projectCards: number
  workingSet: number
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
 * Elastic profile slot: min guarantee, max cap, priority weight
 */
export interface ElasticProfileSlot {
  /** Minimum guaranteed tokens */
  min: number
  /** Maximum allowed tokens (Infinity = no cap) */
  max: number
  /** Priority weight for surplus distribution (higher = gets more surplus) */
  weight: number
}

/**
 * Elastic profile slot with percentage-based max
 */
export interface ElasticProfileSlotPct {
  min: number
  /** Max expressed as fraction of remaining pool (0-1) */
  maxPct: number
  weight: number
}

/**
 * Elastic profile: min/max/weight per slot
 */
export interface ElasticProfile {
  projectCards: ElasticProfileSlot
  workingSet: ElasticProfileSlot
  selected: ElasticProfileSlotPct
  session: ElasticProfileSlot
  historyIndex: ElasticProfileSlot
  stateSummary: ElasticProfileSlot
}

/**
 * Legacy profile format (backward compat)
 */
export interface LegacyProfileAllocations {
  pinnedCap: number
  selectedPct: number
  sessionCap: number
  historyIndexCap: number
  stateSummaryCap: number
}

/** Union type: either new elastic or legacy format */
export type ProfileAllocations = ElasticProfile | LegacyProfileAllocations

/**
 * Check if a profile is legacy format
 */
function isLegacyProfile(p: ProfileAllocations): p is LegacyProfileAllocations {
  return 'pinnedCap' in p
}

/**
 * Convert legacy profile to elastic format (min === max for identical behavior)
 */
export function normalizeLegacyProfile(p: LegacyProfileAllocations): ElasticProfile {
  return {
    projectCards: { min: p.pinnedCap, max: p.pinnedCap, weight: 5 },
    workingSet:   { min: 0, max: 0, weight: 0 },
    selected:     { min: 0, maxPct: p.selectedPct, weight: 4 },
    session:      { min: p.sessionCap, max: p.sessionCap, weight: 3 },
    historyIndex: { min: p.historyIndexCap, max: p.historyIndexCap, weight: 1 },
    stateSummary: { min: p.stateSummaryCap, max: p.stateSummaryCap, weight: 1 },
  }
}

/**
 * Normalize any profile to ElasticProfile
 */
function normalizeProfile(p: ProfileAllocations): ElasticProfile {
  return isLegacyProfile(p) ? normalizeLegacyProfile(p) : p
}

/**
 * Pre-defined allocation profiles (elastic format)
 */
export const PROFILES: Record<TaskProfile, ElasticProfile> = {
  research: {
    projectCards: { min: 2000,  max: Infinity, weight: 5 },
    workingSet:   { min: 4000,  max: 20000,    weight: 3 },
    selected:     { min: 0,     maxPct: 0.20,  weight: 4 },
    session:      { min: 8000,  max: 15000,    weight: 3 },
    historyIndex: { min: 500,   max: 2000,     weight: 1 },
    stateSummary: { min: 2000,  max: 5000,     weight: 1 },
  },
  coding: {
    projectCards: { min: 4000,  max: Infinity, weight: 5 },
    workingSet:   { min: 3000,  max: 12000,    weight: 3 },
    selected:     { min: 0,     maxPct: 0.20,  weight: 4 },
    session:      { min: 6000,  max: 30000,    weight: 3 },
    historyIndex: { min: 300,   max: 1500,     weight: 1 },
    stateSummary: { min: 1500,  max: 4000,     weight: 1 },
  },
  conversation: {
    projectCards: { min: 1000,  max: Infinity, weight: 3 },
    workingSet:   { min: 1500,  max: 8000,     weight: 2 },
    selected:     { min: 0,     maxPct: 0.10,  weight: 2 },
    session:      { min: 12000, max: 50000,    weight: 5 },
    historyIndex: { min: 800,   max: 3000,     weight: 1 },
    stateSummary: { min: 500,   max: 2000,     weight: 1 },
  },
  writing: {
    projectCards: { min: 1500,  max: Infinity, weight: 4 },
    workingSet:   { min: 2000,  max: 10000,    weight: 3 },
    selected:     { min: 0,     maxPct: 0.15,  weight: 3 },
    session:      { min: 8000,  max: 35000,    weight: 3 },
    historyIndex: { min: 200,   max: 1000,     weight: 1 },
    stateSummary: { min: 1000,  max: 3000,     weight: 1 },
  },
  auto: {
    projectCards: { min: 3000,  max: Infinity, weight: 5 },
    workingSet:   { min: 3000,  max: 15000,    weight: 3 },
    selected:     { min: 0,     maxPct: 0.20,  weight: 4 },
    session:      { min: 8000,  max: 40000,    weight: 3 },
    historyIndex: { min: 500,   max: 2000,     weight: 1 },
    stateSummary: { min: 2000,  max: 5000,     weight: 1 },
  },
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
   * Get the resolved elastic profile for the current task profile
   */
  private getProfile(): ElasticProfile {
    const raw = PROFILES[this.taskProfile]
    return normalizeProfile(raw)
  }

  /**
   * Compute allocations using elastic budget: min guarantees + weighted surplus.
   *
   * Algorithm:
   *   1. Deduct fixed costs (identity + tools + pack fragments)
   *   2. Satisfy minimum guarantees for each slot
   *   3. Distribute surplus by priority weight — higher weight slots grow first
   *   4. Clamp each slot at its max (Infinity = no cap)
   *   5. Messages get whatever remains
   */
  allocate(measured: MeasuredComponents): BudgetSlots {
    const profile = this.getProfile()
    const available = this.config.contextWindow - this.config.outputReserve

    // P1: Fixed costs (never cut)
    const fixedCost = measured.systemIdentity + measured.packFragments + measured.toolSchemas
    const pool = Math.max(0, available - fixedCost)

    // Resolve max for selected (percentage-based)
    const selectedMax = Math.floor(pool * profile.selected.maxPct)

    // Slot definitions: [key, min, max, weight]
    // Messages participates in elastic allocation with min guarantee of 4000
    type SlotKey = 'projectCards' | 'workingSet' | 'selected' | 'session' | 'historyIndex' | 'stateSummary' | 'messages'
    const slots: { key: SlotKey; min: number; max: number; weight: number }[] = [
      { key: 'projectCards', min: profile.projectCards.min, max: profile.projectCards.max, weight: profile.projectCards.weight },
      { key: 'workingSet',   min: profile.workingSet.min,   max: profile.workingSet.max,   weight: profile.workingSet.weight },
      { key: 'selected',     min: profile.selected.min,     max: selectedMax,               weight: profile.selected.weight },
      { key: 'session',      min: profile.session.min,      max: profile.session.max,       weight: profile.session.weight },
      { key: 'historyIndex', min: profile.historyIndex.min, max: profile.historyIndex.max, weight: profile.historyIndex.weight },
      { key: 'stateSummary', min: profile.stateSummary.min, max: profile.stateSummary.max, weight: profile.stateSummary.weight },
      { key: 'messages',     min: 4000,                     max: Infinity,                  weight: 2 },
    ]

    // Allocate minimums
    const alloc: Record<SlotKey, number> = { projectCards: 0, workingSet: 0, selected: 0, session: 0, historyIndex: 0, stateSummary: 0, messages: 0 }
    let guaranteedTotal = 0
    for (const s of slots) {
      const m = Math.min(s.min, pool) // don't exceed pool
      alloc[s.key] = m
      guaranteedTotal += m
    }

    // Scale down minimums if they exceed pool
    if (guaranteedTotal > pool) {
      const scale = pool / guaranteedTotal
      guaranteedTotal = 0
      for (const s of slots) {
        alloc[s.key] = Math.floor(alloc[s.key] * scale)
        guaranteedTotal += alloc[s.key]
      }
    }

    // Distribute surplus iteratively
    let surplus = pool - guaranteedTotal
    const capped = new Set<SlotKey>()

    // Iterate until surplus exhausted or all slots capped (max 10 rounds)
    for (let round = 0; round < 10 && surplus > 0; round++) {
      const uncapped = slots.filter(s => !capped.has(s.key))
      if (uncapped.length === 0) break

      const totalWeight = uncapped.reduce((sum, s) => sum + s.weight, 0)
      if (totalWeight === 0) break

      let distributed = 0
      for (const s of uncapped) {
        const share = Math.floor(surplus * s.weight / totalWeight)
        const newVal = alloc[s.key] + share
        if (newVal >= s.max) {
          distributed += s.max - alloc[s.key]
          alloc[s.key] = s.max
          capped.add(s.key)
        } else {
          distributed += share
          alloc[s.key] = newVal
        }
      }
      surplus -= distributed
      if (distributed === 0) break
    }

    // If selected has actual measured tokens, use the lesser of actual vs allocated
    const actualSelected = measured.actualSelectedTokens
    const selectedContext = actualSelected !== undefined
      ? Math.min(actualSelected, alloc.selected)
      : alloc.selected

    // Unused selected budget flows to session (up to session max)
    const selectedUnused = alloc.selected - selectedContext
    const sessionBudget = Math.min(alloc.session + selectedUnused, profile.session.max)

    // Recalculate messages: starts from elastic allocation, plus any leftover from selected→session overflow
    const selectedSessionOverflow = selectedUnused - (sessionBudget - alloc.session)
    const messages = alloc.messages + Math.max(0, selectedSessionOverflow)

    return {
      systemIdentity: measured.systemIdentity,
      packFragments: measured.packFragments,
      toolSchemas: measured.toolSchemas,
      projectCards: alloc.projectCards,
      workingSet: alloc.workingSet,
      selectedContext,
      historyIndex: alloc.historyIndex,
      stateSummary: alloc.stateSummary,
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
    const pool = Math.max(0, available - fixedCost)
    const actions: DegradationAction[] = []
    let toolSubset: string[] | undefined

    let projectCards: number
    let workingSet: number
    let selectedContext: number
    let sessionBudget: number
    let historyIndex: number
    let stateSummary: number

    const actualSelected = measured.actualSelectedTokens ?? 0
    const selectedMax = Math.floor(pool * profile.selected.maxPct)

    if (level === 0) {
      // Normal — use elastic allocation
      const slots = this.allocate(measured)
      return {
        level,
        slots,
        actions,
        toolSubset
      }
    } else if (level === 1) {
      // Reduced: halve maxes, compress tool output
      projectCards = Math.min(Math.floor(profile.projectCards.max === Infinity ? pool : profile.projectCards.max / 2), pool)
      projectCards = Math.max(profile.projectCards.min, projectCards)
      let remaining = pool - projectCards

      historyIndex = Math.min(profile.historyIndex.min, remaining)
      remaining -= historyIndex

      stateSummary = Math.min(profile.stateSummary.min, remaining)
      remaining -= stateSummary

      const halvedWorkingSetMax = Math.floor(profile.workingSet.max * 0.5)
      workingSet = Math.min(halvedWorkingSetMax, remaining)
      workingSet = Math.max(profile.workingSet.min, Math.min(workingSet, remaining))
      remaining -= workingSet

      const halvedSelectedMax = Math.floor(selectedMax * 0.5)
      selectedContext = Math.min(actualSelected, halvedSelectedMax, remaining)
      remaining -= selectedContext

      sessionBudget = Math.min(profile.session.max, remaining)
      sessionBudget = Math.max(0, sessionBudget)
      remaining -= sessionBudget

      actions.push({
        type: 'compress_tool_output',
        params: {
          toolCaps: { read: 2000, grep: 1500, glob: 500, bash: 1500, fetch: 1500, _default: 2000 },
          totalBudget: Math.floor(pool * 0.35)
        }
      })
      actions.push({ type: 'trim_selected', params: { targetTokens: selectedContext } })
    } else if (level === 2) {
      // Minimal: collapse to mins
      projectCards = Math.min(profile.projectCards.min, pool)
      let remaining = pool - projectCards

      workingSet = 0
      selectedContext = 0
      historyIndex = Math.min(profile.historyIndex.min, remaining)
      remaining -= historyIndex

      stateSummary = Math.min(profile.stateSummary.min, remaining)
      remaining -= stateSummary

      sessionBudget = Math.min(profile.session.min, remaining)
      remaining -= sessionBudget

      actions.push({ type: 'drop_selected' })
      actions.push({ type: 'trim_session', params: { targetTokens: sessionBudget } })
      actions.push({
        type: 'trim_old_tool_results',
        params: { keepCount: 3, capTokens: 512 }
      })
      actions.push({ type: 'reduce_tools' })

      toolSubset = [...(TOOL_GROUPS.core ?? [])]
    } else {
      // Emergency (L3): zero all slots
      projectCards = 0
      workingSet = 0
      selectedContext = 0
      sessionBudget = 0
      historyIndex = 0
      stateSummary = 0

      actions.push({
        type: 'emergency_strip',
        params: { capTokens: 2048 }
      })

      toolSubset = [...(TOOL_GROUPS.core ?? [])]
    }

    const usedBySlots = projectCards + workingSet + selectedContext + sessionBudget + historyIndex + stateSummary
    const messages = Math.max(0, pool - usedBySlots)

    return {
      level,
      slots: {
        systemIdentity: measured.systemIdentity,
        packFragments: level >= 2 ? Math.floor(measured.packFragments * 0.5) : measured.packFragments,
        toolSchemas: measured.toolSchemas,
        projectCards,
        workingSet,
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
