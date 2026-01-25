/**
 * Agent Bridge - Connect Team Runtime with Agent Framework
 *
 * This module bridges the multi-agent team system with the existing
 * Agent framework, allowing real agents to be used in team flows.
 */

import type { Agent, AgentRunResult } from '../types/agent.js'
import type { AgentInvoker, ExecutionContext } from './flow/executor.js'
import type { TeamDefinition, AgentHandle } from './define-team.js'
import type { ChannelHub } from './channels/channel.js'
import { parseHandoff, type HandoffResult } from './flow/handoff.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Agent instance with its handle
 */
export interface ResolvedAgent {
  handle: AgentHandle
  agent: Agent
}

/**
 * Agent resolver function
 */
export type AgentResolver = (agentId: string, handle: AgentHandle) => Promise<Agent | null>

/**
 * Bridge configuration
 */
export interface AgentBridgeConfig {
  /** Team definition */
  team: TeamDefinition
  /** Agent resolver - resolves agent handles to actual agent instances */
  agentResolver: AgentResolver
  /** Optional channel hub for agent communication */
  channelHub?: ChannelHub
  /** Message transform before sending to agent */
  inputTransform?: (input: unknown, agentId: string) => unknown
  /** Message transform after receiving from agent */
  outputTransform?: (output: unknown, agentId: string) => unknown
  /** Error handler */
  onError?: (error: Error, agentId: string) => void
  /** Handoff handler */
  onHandoff?: (handoff: HandoffResult, fromAgentId: string) => void
}

/**
 * Bridge trace event
 */
export interface BridgeTraceEvent {
  type: 'bridge.resolve' | 'bridge.invoke' | 'bridge.complete' | 'bridge.error'
  runId: string
  ts: number
  agentId: string
  durationMs?: number
  error?: string
}

// ============================================================================
// Agent Bridge
// ============================================================================

/**
 * AgentBridge connects the team runtime with actual agent instances
 */
export class AgentBridge {
  private config: AgentBridgeConfig
  private resolvedAgents = new Map<string, Agent>()
  private invocationCount = new Map<string, number>()

  constructor(config: AgentBridgeConfig) {
    this.config = config
  }

  /**
   * Create an AgentInvoker for use with TeamRuntime
   */
  createInvoker(): AgentInvoker {
    return async (agentId: string, input: unknown, _ctx: ExecutionContext): Promise<unknown> => {
      try {
        // Resolve agent if not already resolved
        const agent = await this.resolveAgent(agentId)

        // Transform input
        const transformedInput = this.config.inputTransform
          ? this.config.inputTransform(input, agentId)
          : input

        // Track invocation
        const count = this.invocationCount.get(agentId) ?? 0
        this.invocationCount.set(agentId, count + 1)

        // Run agent
        const result = await this.runAgent(agent, agentId, transformedInput, _ctx)

        // Transform output
        const transformedOutput = this.config.outputTransform
          ? this.config.outputTransform(result, agentId)
          : result

        // Check for handoff
        const handoff = parseHandoff(transformedOutput)
        if (handoff && this.config.onHandoff) {
          this.config.onHandoff(handoff, agentId)
        }

        return transformedOutput
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        this.config.onError?.(err, agentId)
        throw err
      }
    }
  }

  /**
   * Resolve an agent by ID
   */
  async resolveAgent(agentId: string): Promise<Agent> {
    // Check cache
    const cached = this.resolvedAgents.get(agentId)
    if (cached) {
      return cached
    }

    // Find handle in team definition
    const handle = this.config.team.agents[agentId]
    if (!handle) {
      throw new Error(`Agent not found in team: ${agentId}`)
    }

    // If handle.agent is already an Agent instance, use it directly
    if (this.isAgent(handle.agent)) {
      this.resolvedAgents.set(agentId, handle.agent as Agent)
      return handle.agent as Agent
    }

    // Use resolver to get agent
    const agent = await this.config.agentResolver(agentId, handle)
    if (!agent) {
      throw new Error(`Failed to resolve agent: ${agentId}`)
    }

    this.resolvedAgents.set(agentId, agent)
    return agent
  }

  /**
   * Get invocation count for an agent
   */
  getInvocationCount(agentId: string): number {
    return this.invocationCount.get(agentId) ?? 0
  }

  /**
   * Get all resolved agents
   */
  getResolvedAgents(): Map<string, Agent> {
    return new Map(this.resolvedAgents)
  }

  /**
   * Clear agent cache
   */
  clearCache(): void {
    this.resolvedAgents.clear()
    this.invocationCount.clear()
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async runAgent(
    agent: Agent,
    _agentId: string,
    input: unknown,
    _ctx: ExecutionContext
  ): Promise<unknown> {
    // Convert input to message format if needed
    const message = this.formatInputAsMessage(input)

    // Run the agent
    // The agent's run method should accept a message and return a result
    const result = await agent.run(message)

    // Extract output from result
    return this.extractOutput(result)
  }

  private formatInputAsMessage(input: unknown): string {
    if (typeof input === 'string') {
      return input
    }
    if (typeof input === 'object' && input !== null) {
      // Check for common message patterns
      const obj = input as Record<string, unknown>
      if (typeof obj['message'] === 'string') {
        return obj['message']
      }
      if (typeof obj['content'] === 'string') {
        return obj['content']
      }
      if (typeof obj['query'] === 'string') {
        return obj['query']
      }
      if (typeof obj['task'] === 'string') {
        return obj['task']
      }
      // Default: stringify the object
      return JSON.stringify(input)
    }
    return String(input)
  }

  private extractOutput(result: AgentRunResult): unknown {
    // AgentRunResult has output as a string
    // Return the output directly
    return result.output
  }

  private isAgent(value: unknown): value is Agent {
    if (typeof value !== 'object' || value === null) {
      return false
    }
    const obj = value as Record<string, unknown>
    return typeof obj['run'] === 'function'
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an agent bridge
 */
export function createAgentBridge(config: AgentBridgeConfig): AgentBridge {
  return new AgentBridge(config)
}

/**
 * Create a simple agent resolver that uses pre-registered agents
 */
export function createMapBasedResolver(
  agents: Map<string, Agent> | Record<string, Agent>
): AgentResolver {
  const agentMap = agents instanceof Map ? agents : new Map(Object.entries(agents))

  return async (agentId: string) => {
    return agentMap.get(agentId) ?? null
  }
}

/**
 * Create an agent resolver that creates agents on demand
 */
export function createFactoryResolver(
  factory: (agentId: string, handle: AgentHandle) => Promise<Agent>
): AgentResolver {
  return factory
}

// ============================================================================
// Convenience: Create Team Runtime with Bridge
// ============================================================================

import { TeamRuntime, createTeamRuntime, type TeamRuntimeConfig } from './team-runtime.js'

/**
 * Create a team runtime with agent bridge
 */
export function createBridgedTeamRuntime(
  bridgeConfig: AgentBridgeConfig,
  runtimeConfig?: Partial<Omit<TeamRuntimeConfig, 'team' | 'agentInvoker'>>
): { runtime: TeamRuntime; bridge: AgentBridge } {
  const bridge = createAgentBridge(bridgeConfig)

  const runtime = createTeamRuntime({
    team: bridgeConfig.team,
    agentInvoker: bridge.createInvoker(),
    ...runtimeConfig
  })

  return { runtime, bridge }
}
