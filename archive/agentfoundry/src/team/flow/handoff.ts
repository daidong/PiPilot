/**
 * Handoff - Transfer control between agents
 *
 * Handoffs allow an agent to explicitly transfer control to another agent,
 * optionally with transformed context.
 */

import type { InputRef, TransferSpec } from './ast.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Handoff specification
 */
export interface HandoffSpec {
  /** Target agent ID */
  targetAgent: string
  /** Input to pass to target */
  input: InputRef
  /** Context transfer mode */
  transfer?: TransferSpec
  /** Reason for handoff */
  reason?: string
  /** Metadata for tracking */
  metadata?: Record<string, unknown>
}

/**
 * Handoff result returned from agent
 */
export interface HandoffResult {
  /** Indicates this is a handoff */
  type: 'handoff'
  /** Target agent to hand off to */
  target: string
  /** Data to pass to target */
  data?: unknown
  /** Reason for handoff */
  reason?: string
  /** Transfer mode */
  transfer?: TransferSpec
}

/**
 * Agent result - either completed or handoff
 */
export type AgentResult =
  | { type: 'complete'; output: unknown }
  | HandoffResult

/**
 * Handoff trace event
 */
export interface HandoffTraceEvent {
  type: 'handoff.initiated' | 'handoff.accepted' | 'handoff.rejected'
  runId: string
  ts: number
  fromAgent: string
  toAgent: string
  reason?: string
  metadata?: Record<string, unknown>
}

// ============================================================================
// Handoff Detection and Processing
// ============================================================================

/**
 * Check if a result is a handoff request
 */
export function isHandoffResult(result: unknown): result is HandoffResult {
  if (typeof result !== 'object' || result === null) {
    return false
  }
  const obj = result as Record<string, unknown>
  return obj['type'] === 'handoff' && typeof obj['target'] === 'string'
}

/**
 * Create a handoff result
 */
export function createHandoff(
  target: string,
  options?: {
    data?: unknown
    reason?: string
    transfer?: TransferSpec
  }
): HandoffResult {
  return {
    type: 'handoff',
    target,
    data: options?.data,
    reason: options?.reason,
    transfer: options?.transfer
  }
}

/**
 * Parse handoff from agent output
 *
 * Agents can return handoff in different formats:
 * 1. Direct HandoffResult object
 * 2. Object with handoff_to field
 * 3. JSON string containing handoff
 */
export function parseHandoff(output: unknown): HandoffResult | null {
  // Direct handoff result
  if (isHandoffResult(output)) {
    return output
  }

  // Object with handoff_to field
  if (typeof output === 'object' && output !== null) {
    const obj = output as Record<string, unknown>

    // Check for handoff_to pattern
    if (typeof obj['handoff_to'] === 'string') {
      return {
        type: 'handoff',
        target: obj['handoff_to'],
        data: obj['data'] ?? obj['context'],
        reason: obj['reason'] as string | undefined
      }
    }

    // Check for transfer_to pattern (alternative naming)
    if (typeof obj['transfer_to'] === 'string') {
      return {
        type: 'handoff',
        target: obj['transfer_to'],
        data: obj['data'] ?? obj['context'],
        reason: obj['reason'] as string | undefined
      }
    }
  }

  // String that might be JSON
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      return parseHandoff(parsed)
    } catch {
      // Not JSON, not a handoff
    }
  }

  return null
}

// ============================================================================
// Handoff Chain Execution
// ============================================================================

/**
 * Configuration for handoff chain execution
 */
export interface HandoffChainConfig {
  /** Maximum handoffs before stopping */
  maxHandoffs: number
  /** Allowed target agents */
  allowedTargets?: string[]
  /** Track handoff history */
  trackHistory?: boolean
}

/**
 * Handoff chain state
 */
export interface HandoffChainState {
  /** Original input */
  originalInput: unknown
  /** Current input for next agent */
  currentInput: unknown
  /** Handoff history */
  history: Array<{
    from: string
    to: string
    reason?: string
    ts: number
  }>
  /** Current agent */
  currentAgent: string
  /** Number of handoffs so far */
  handoffCount: number
}

/**
 * Execute a chain of handoffs until completion or limit
 */
export async function executeHandoffChain(
  startAgent: string,
  input: unknown,
  invokeAgent: (agentId: string, agentInput: unknown) => Promise<unknown>,
  config: HandoffChainConfig
): Promise<{
  finalAgent: string
  output: unknown
  handoffHistory: HandoffChainState['history']
  completed: boolean
}> {
  const state: HandoffChainState = {
    originalInput: input,
    currentInput: input,
    history: [],
    currentAgent: startAgent,
    handoffCount: 0
  }

  while (state.handoffCount <= config.maxHandoffs) {
    // Invoke current agent
    const result = await invokeAgent(state.currentAgent, state.currentInput)

    // Check for handoff
    const handoff = parseHandoff(result)

    if (!handoff) {
      // No handoff, agent completed
      return {
        finalAgent: state.currentAgent,
        output: result,
        handoffHistory: state.history,
        completed: true
      }
    }

    // Validate target
    if (config.allowedTargets && !config.allowedTargets.includes(handoff.target)) {
      throw new Error(`Handoff to '${handoff.target}' not allowed. Allowed: ${config.allowedTargets.join(', ')}`)
    }

    // Record handoff
    if (config.trackHistory) {
      state.history.push({
        from: state.currentAgent,
        to: handoff.target,
        reason: handoff.reason,
        ts: Date.now()
      })
    }

    // Update state
    state.currentInput = handoff.data ?? state.currentInput
    state.currentAgent = handoff.target
    state.handoffCount++
  }

  // Max handoffs reached
  return {
    finalAgent: state.currentAgent,
    output: { error: `Max handoffs (${config.maxHandoffs}) reached` },
    handoffHistory: state.history,
    completed: false
  }
}
