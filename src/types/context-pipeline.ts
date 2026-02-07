/**
 * Context Pipeline Types - Shared types used by Kernel V2 and WorkingSet Builder
 *
 * V1 context pipeline has been removed; Kernel V2 is now mandatory.
 * Retains types still referenced by workingset-builder.ts.
 */

import type { Runtime } from './runtime.js'

// ============ Budget Types ============

/**
 * Budget allocation type for a phase
 */
export type PhaseBudgetType = 'reserved' | 'percentage' | 'remaining' | 'fixed'

/**
 * Budget specification for a phase
 */
export interface PhaseBudget {
  /** Budget type */
  type: PhaseBudgetType
  /** Token count (for 'reserved' and 'fixed' types) */
  tokens?: number
  /** Percentage value 0-100 (for 'percentage' type) */
  value?: number
  /** Minimum guaranteed tokens */
  minTokens?: number
}

// ============ Context Fragment ============

/**
 * A single piece of assembled context
 */
export interface ContextFragment {
  /** Source identifier (e.g., 'system', 'project-cards:project.rules', 'file:./src/main.ts') */
  source: string
  /** Rendered content to include in context */
  content: string
  /** Estimated token count */
  tokens: number
  /** Optional metadata for debugging/tracking */
  metadata?: Record<string, unknown>
}

// ============ Context Selection ============

/**
 * Type of context selection
 */
export type ContextSelectionType = 'memory' | 'file' | 'messages' | 'url' | 'custom'

/**
 * A user-specified context selection
 */
export interface ContextSelection {
  /** Type of selection */
  type: ContextSelectionType
  /** Reference (memory key, file path, message range, URL, etc.) */
  ref: string
  /** Optional maximum tokens for this selection */
  maxTokens?: number
  /** Custom resolver for 'custom' type */
  resolve?: (runtime: Runtime) => Promise<ContextFragment>
}

// ============ Assembly Context ============

/**
 * Context passed to phase.assemble()
 */
export interface AssemblyContext {
  /** Runtime environment */
  runtime: Runtime
  /** Total token budget for entire context */
  totalBudget: number
  /** Budget allocated to this phase */
  allocatedBudget: number
  /** Tokens already used by previous phases */
  usedBudget: number
  /** Remaining token budget */
  remainingBudget: number
  /** User-provided context selections */
  selectedContext?: ContextSelection[]
  /** Messages excluded from session phase */
  excludedMessages: unknown[]
}

// ============ Context Phase ============

/**
 * A context assembly phase (used by WorkingSet Builder)
 */
export interface ContextPhase {
  /** Phase ID */
  id: string
  /** Priority (higher = earlier in assembly) */
  priority: number
  /** Budget specification */
  budget: PhaseBudget
  /** Assemble context for this phase */
  assemble: (ctx: AssemblyContext) => Promise<ContextFragment[]>
  /** Optional: check if phase should be enabled */
  enabled?: (ctx: AssemblyContext) => boolean
}
