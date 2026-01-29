/**
 * Context Assembly Pipeline
 *
 * A phased, priority-aware context assembly system that:
 * - Executes phases in priority order (highest first)
 * - Manages token budgets across phases
 * - Supports various budget types (reserved, percentage, remaining, fixed)
 * - Tracks excluded messages for index phase compression
 */

import type {
  ContextPipeline,
  ContextPhase,
  PhaseBudget,
  AssemblyContext,
  AssembledContext,
  PhaseResult,
  ContextFragment,
  ContextSelection
} from '../types/context-pipeline.js'
import type { Runtime } from '../types/runtime.js'
import type { Message } from '../types/session.js'

/**
 * Configuration for creating a context pipeline
 */
export interface ContextPipelineConfig {
  /** Phases to register (optional, can register later) */
  phases?: ContextPhase[]
}

/**
 * Create a context pipeline
 */
export function createContextPipeline(config: ContextPipelineConfig = {}): ContextPipeline {
  const phases: Map<string, ContextPhase> = new Map()

  // Register initial phases
  if (config.phases) {
    for (const phase of config.phases) {
      phases.set(phase.id, phase)
    }
  }

  /**
   * Get phases sorted by priority (descending)
   */
  function getSortedPhases(): ContextPhase[] {
    return [...phases.values()].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Calculate budget allocations for all phases
   */
  function calculateAllocations(totalBudget: number): Map<string, number> {
    const allocations = new Map<string, number>()
    const sortedPhases = getSortedPhases()

    // First pass: calculate reserved and fixed budgets
    let reservedTotal = 0
    const reservedPhases: ContextPhase[] = []
    const percentagePhases: ContextPhase[] = []
    const remainingPhases: ContextPhase[] = []

    for (const phase of sortedPhases) {
      const budget = phase.budget

      if (budget.type === 'reserved' || budget.type === 'fixed') {
        const tokens = budget.tokens ?? 0
        allocations.set(phase.id, tokens)
        reservedTotal += tokens
        reservedPhases.push(phase)
      } else if (budget.type === 'percentage') {
        percentagePhases.push(phase)
      } else if (budget.type === 'remaining') {
        remainingPhases.push(phase)
      }
    }

    // Calculate available budget after reserved allocations
    const availableAfterReserved = Math.max(0, totalBudget - reservedTotal)

    // Second pass: calculate percentage budgets
    let percentageTotal = 0
    for (const phase of percentagePhases) {
      const percentage = phase.budget.value ?? 0
      const tokens = Math.floor(availableAfterReserved * (percentage / 100))
      allocations.set(phase.id, tokens)
      percentageTotal += tokens
    }

    // Third pass: distribute remaining budget
    const remainingBudget = Math.max(0, availableAfterReserved - percentageTotal)

    if (remainingPhases.length > 0) {
      // If multiple 'remaining' phases, distribute equally
      const perPhase = Math.floor(remainingBudget / remainingPhases.length)
      for (const phase of remainingPhases) {
        allocations.set(phase.id, perPhase)
      }
    }

    return allocations
  }

  /**
   * Assemble context using all phases
   */
  async function assemble(options: {
    runtime: Runtime
    totalBudget: number
    selectedContext?: ContextSelection[]
    messages?: Message[]
    externalBudgets?: {
      pinned?: number
      selected?: number
      session?: number
      index?: number
    }
  }): Promise<AssembledContext> {
    const { runtime, totalBudget, selectedContext, externalBudgets } = options

    // Calculate budget allocations (use external budgets if provided by BudgetCoordinator)
    const allocations = calculateAllocations(totalBudget)

    // Override with external budgets when coordinated
    if (externalBudgets) {
      if (externalBudgets.pinned !== undefined) allocations.set('pinned', externalBudgets.pinned)
      if (externalBudgets.selected !== undefined) allocations.set('selected', externalBudgets.selected)
      if (externalBudgets.session !== undefined) allocations.set('session', externalBudgets.session)
      if (externalBudgets.index !== undefined) allocations.set('index', externalBudgets.index)
    }

    // Get sorted phases
    const sortedPhases = getSortedPhases()

    // Track assembly state
    let usedBudget = 0
    const phaseResults: PhaseResult[] = []
    const allFragments: ContextFragment[] = []
    let excludedMessages: Message[] = []

    // Execute phases in priority order
    for (const phase of sortedPhases) {
      const allocatedBudget = allocations.get(phase.id) ?? 0

      // Build assembly context
      const ctx: AssemblyContext = {
        runtime,
        totalBudget,
        usedBudget,
        remainingBudget: totalBudget - usedBudget,
        selectedContext,
        excludedMessages
      }

      // Check if phase is enabled
      if (phase.enabled && !phase.enabled(ctx)) {
        phaseResults.push({
          phaseId: phase.id,
          fragments: [],
          tokens: 0,
          allocatedBudget
        })
        continue
      }

      // Execute phase assembly
      try {
        const fragments = await phase.assemble(ctx)

        // Calculate tokens used
        let phaseTokens = 0
        for (const fragment of fragments) {
          phaseTokens += fragment.tokens
        }

        // Trim fragments if over budget
        const trimmedFragments = trimFragmentsToFit(fragments, allocatedBudget)

        // Recalculate actual tokens after trimming
        let actualTokens = 0
        for (const frag of trimmedFragments) {
          actualTokens += frag.tokens
        }

        // Log when content is trimmed to fit budget
        if (actualTokens < phaseTokens) {
          console.error(
            `[Pipeline] Phase "${phase.id}" trimmed: ${phaseTokens} → ${actualTokens} tokens (budget: ${allocatedBudget}, fragments: ${fragments.length} → ${trimmedFragments.length})`
          )
        }

        phaseResults.push({
          phaseId: phase.id,
          fragments: trimmedFragments,
          tokens: actualTokens,
          allocatedBudget
        })

        allFragments.push(...trimmedFragments)
        usedBudget += actualTokens

        // Special handling for session phase - track excluded messages
        if (phase.id === 'session') {
          // Session phase should set excludedMessages on context
          // This is done within the session phase itself
        }
      } catch (error) {
        // Log error but continue with other phases
        console.error(`[Pipeline] Phase ${phase.id} failed:`, error)
        phaseResults.push({
          phaseId: phase.id,
          fragments: [],
          tokens: 0,
          allocatedBudget
        })
      }
    }

    // Build final content
    const content = allFragments
      .map(f => f.content)
      .join('\n\n')

    // Get compressed history from index phase result
    const indexResult = phaseResults.find(r => r.phaseId === 'index')
    const compressedHistoryMeta = indexResult?.fragments[0]?.metadata

    // Extract selected phase content separately for message injection (Change 5)
    const selectedResult = phaseResults.find(r => r.phaseId === 'selected')
    const selectedContent = selectedResult?.fragments
      .map(f => f.content)
      .join('\n\n') || undefined

    return {
      content,
      totalTokens: usedBudget,
      phases: phaseResults,
      excludedMessages,
      compressedHistory: compressedHistoryMeta?.compressedHistory as AssembledContext['compressedHistory'],
      selectedContent
    }
  }

  /**
   * Trim fragments to fit within budget
   */
  function trimFragmentsToFit(
    fragments: ContextFragment[],
    maxTokens: number
  ): ContextFragment[] {
    if (maxTokens <= 0) return []

    const result: ContextFragment[] = []
    let usedTokens = 0

    for (const fragment of fragments) {
      if (usedTokens + fragment.tokens <= maxTokens) {
        result.push(fragment)
        usedTokens += fragment.tokens
      } else {
        // Try to include partial content
        const remainingTokens = maxTokens - usedTokens
        if (remainingTokens > 50) { // Only include if meaningful
          const truncatedContent = truncateToTokens(fragment.content, remainingTokens)
          result.push({
            ...fragment,
            content: truncatedContent + '\n[...truncated]',
            tokens: remainingTokens
          })
        }
        break
      }
    }

    return result
  }

  /**
   * Truncate content to fit within token limit
   */
  function truncateToTokens(content: string, maxTokens: number): string {
    const maxChars = maxTokens * 3 - 20 // Leave room for truncation marker
    if (content.length <= maxChars) return content
    return content.slice(0, maxChars)
  }

  // Return pipeline instance
  return {
    registerPhase(phase: ContextPhase): void {
      phases.set(phase.id, phase)
    },

    getPhases(): ContextPhase[] {
      return getSortedPhases()
    },

    assemble,

    calculateAllocations
  }
}

/**
 * Create default budget allocation for a phase
 */
export function createBudget(
  type: PhaseBudget['type'],
  value?: number
): PhaseBudget {
  if (type === 'reserved' || type === 'fixed') {
    return { type, tokens: value }
  } else if (type === 'percentage') {
    return { type, value }
  } else {
    return { type }
  }
}

/**
 * Default phase priorities
 */
export const PHASE_PRIORITIES = {
  system: 100,
  pinned: 90,
  selected: 80,
  session: 50,
  index: 30
} as const

/**
 * Default phase budgets
 */
export const DEFAULT_BUDGETS = {
  system: createBudget('reserved', 2000),
  pinned: createBudget('reserved', 2000),
  selected: createBudget('percentage', 30),
  session: createBudget('remaining'),
  index: createBudget('fixed', 500)
} as const
