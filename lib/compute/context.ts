/**
 * Compute Context — minimal dependency bundle injected into each backend
 * at construction time. Replaces the ResearchToolContext reach-through
 * that PR #62 used, and removes the `createSubAgent` reverse-dependency
 * smell flagged in the PR review.
 */

import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
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
   * Construct a pi-mono sub-agent for backends that need one (e.g.
   * Modal's plan agent which sandboxes script analysis).
   *
   * Why a factory and not the Agent class + key resolver: model
   * resolution (piModel construction from modelId, provider inference,
   * fallback chain) is non-trivial and lives in the coordinator. The
   * factory captures all that complexity once at ComputeContext build
   * time, so backends don't reimplement it. This is the dependency
   * injection point that was missing in PR #62 (where createSubAgent
   * leaked onto CoordinatorConfig, exposing it as caller-facing API).
   *
   * Backends that don't need sub-agents can ignore this.
   * Returns undefined when no model is configured (chat-disabled
   * coordinator); backends should handle gracefully.
   */
  createSubAgent?(opts: { systemPrompt: string; tools: AgentTool[]; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' }): Agent
}
