/**
 * Shared context selection types used by agent runtime and app coordinators.
 */

import type { Runtime } from './runtime.js'

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
