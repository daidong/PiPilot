/**
 * Compute Context — minimal dependency bundle injected into each backend
 * at construction time. Replaces the ResearchToolContext reach-through
 * that PR #62 used, and removes the `createSubAgent` reverse-dependency
 * smell flagged in the PR review.
 */

import type { Agent } from '@mariozechner/pi-agent-core'
import type { ComputeEvent } from './events.js'

export interface ComputeContext {
  readonly projectPath: string
  readonly workspacePath: string

  /**
   * Per-backend resolved credentials. Loaded from settings/env at
   * registration time. Keys are backend-defined.
   */
  getCredentials(): Record<string, string | undefined>

  /**
   * Per-backend cost threshold in USD. Backends with hasCost=false
   * ignore this. Live accessor — re-reads settings on each call.
   */
  getCostThresholdUsd(): number

  /**
   * Emit an event to the Registry, which fans it out to subscribers.
   * Replaces the modal-specific onModalCostKilled/onModalRunUpdate
   * callbacks that polluted CoordinatorConfig in PR #62.
   */
  emit(event: ComputeEvent): void

  /**
   * Pi-mono Agent class for backends that need a sub-agent (e.g. Modal's
   * plan agent which sandboxes script analysis). Provided as a class
   * reference rather than a factory closing over coordinator internals,
   * so backends are responsible for constructing with the right config.
   */
  readonly AgentClass: typeof Agent

  /**
   * Resolve the API key for a given provider — backends pass this to
   * AgentClass when constructing sub-agents.
   */
  resolveApiKey(provider: string): string | undefined

  /** Default model id (for sub-agents). */
  readonly defaultModelId: string
}
