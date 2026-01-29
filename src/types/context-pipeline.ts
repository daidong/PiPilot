/**
 * Context Pipeline Types - Context Assembly Pipeline Type Definitions
 *
 * Provides types for the phased, priority-aware context assembly pipeline:
 * - 5 built-in phases: system, pinned, selected, session, index
 * - User selection injection via agent.run(prompt, { selectedContext })
 * - History compression with addressable segments for LLM retrieval
 * - ctx-expand tool for LLM to request specific context on demand
 */

import type { Runtime } from './runtime.js'
import type { Message } from './session.js'

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
}

// ============ Context Fragment ============

/**
 * A single piece of assembled context
 */
export interface ContextFragment {
  /** Source identifier (e.g., 'system', 'pinned:project.rules', 'file:./src/main.ts') */
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

// ============ History Compression ============

/**
 * A compressed segment of conversation history
 */
export interface HistorySegment {
  /** Unique segment ID (e.g., 'seg-0', 'seg-1') */
  id: string
  /** Message index range [start, end) */
  range: [number, number]
  /** Summary of segment content */
  summary: string
  /** Extracted keywords for search */
  keywords: string[]
  /** Number of messages in segment */
  messageCount: number
}

/**
 * Compressed history result
 */
export interface CompressedHistory {
  /** Overall summary of compressed history */
  summary: string
  /** Addressable segments */
  segments: HistorySegment[]
  /** Total tokens for the compressed representation */
  tokens: number
}

/**
 * History compressor interface
 */
export interface HistoryCompressor {
  /**
   * Compress messages into addressable segments
   * @param messages Messages to compress
   * @param maxTokens Maximum tokens for compressed output
   * @returns Compressed history with addressable segments
   */
  compress(messages: Message[], maxTokens: number): Promise<CompressedHistory>
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
  /** Tokens already used by previous phases */
  usedBudget: number
  /** Remaining token budget */
  remainingBudget: number
  /** User-provided context selections (for selected phase) */
  selectedContext?: ContextSelection[]
  /** Messages excluded from session phase (for index phase) */
  excludedMessages: Message[]
  /** Compressed history (populated by index phase) */
  compressedHistory?: CompressedHistory
}

// ============ Context Phase ============

/**
 * A context assembly phase
 */
export interface ContextPhase {
  /** Phase ID (unique identifier) */
  id: string
  /** Priority (higher = earlier in assembly, e.g., system=100, session=50, index=30) */
  priority: number
  /** Budget specification */
  budget: PhaseBudget
  /** Assemble context for this phase */
  assemble: (ctx: AssemblyContext) => Promise<ContextFragment[]>
  /** Optional: check if phase should be enabled */
  enabled?: (ctx: AssemblyContext) => boolean
}

// ============ Assembled Context ============

/**
 * Phase assembly result
 */
export interface PhaseResult {
  /** Phase ID */
  phaseId: string
  /** Fragments assembled by this phase */
  fragments: ContextFragment[]
  /** Total tokens used by this phase */
  tokens: number
  /** Allocated budget for this phase */
  allocatedBudget: number
}

/**
 * Final assembled context result
 */
export interface AssembledContext {
  /** Full rendered context content */
  content: string
  /** Total tokens in assembled context */
  totalTokens: number
  /** Results from each phase */
  phases: PhaseResult[]
  /** Messages that were excluded from session (for ctx-expand) */
  excludedMessages: Message[]
  /** Compressed history (for ctx-expand) */
  compressedHistory?: CompressedHistory
  /** Selected context content extracted for separate message injection */
  selectedContent?: string
}

// ============ Pipeline Configuration ============

/**
 * Compression configuration
 */
export interface CompressionConfig {
  /** Segment size (number of messages per segment, default: 20) */
  segmentSize?: number
  /** Maximum keywords per segment (default: 10) */
  maxKeywordsPerSegment?: number
  /** Custom compressor implementation */
  compressor?: HistoryCompressor
}

/**
 * Phase configuration override
 */
export interface PhaseConfig {
  /** Phase ID to configure */
  id: string
  /** Override enabled state */
  enabled?: boolean
  /** Override budget */
  budget?: PhaseBudget
  /** Override priority */
  priority?: number
}

/**
 * Pipeline configuration
 */
export interface PipelineConfig {
  /** Enable the context assembly pipeline */
  enabled: boolean
  /** Total token budget (default: detected from model or 100000) */
  totalBudget?: number
  /** Custom phases to add or override built-in phases */
  phases?: PhaseConfig[]
  /** History compression configuration */
  compressionConfig?: CompressionConfig
}

// ============ Pipeline Interface ============

/**
 * Context pipeline instance
 */
export interface ContextPipeline {
  /**
   * Register a phase
   */
  registerPhase(phase: ContextPhase): void

  /**
   * Get all registered phases (sorted by priority descending)
   */
  getPhases(): ContextPhase[]

  /**
   * Assemble context with the given options
   */
  assemble(options: {
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
  }): Promise<AssembledContext>

  /**
   * Calculate budget allocations for all phases
   */
  calculateAllocations(totalBudget: number): Map<string, number>
}

// ============ Utility Types ============

/**
 * Extended runtime with compressor
 */
export interface RuntimeWithCompressor extends Runtime {
  /** History compressor for ctx-expand tool */
  compressor?: HistoryCompressor
  /** Compressed history cache for current session */
  compressedHistory?: CompressedHistory
}
