/**
 * Agent Registry - Discover and route to agents within a team
 *
 * The registry provides agent discovery, catalog generation for LLM routing,
 * and capability-based agent lookup.
 */

import type { AgentHandle, TeamDefinition } from './define-team.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Agent catalog entry for LLM consumption
 */
export interface AgentCatalogEntry {
  /** Agent ID */
  id: string
  /** Role description */
  role?: string
  /** Detailed description */
  description?: string
  /** Capabilities for routing */
  capabilities: string[]
  /** Cost tier for budget consideration */
  costTier?: 'cheap' | 'medium' | 'expensive'
  /** IO permissions */
  ioPermissions?: AgentPermission[]
  /** Interface schemas */
  interfaces?: {
    inputSchema?: unknown
    outputSchema?: unknown
    examples?: Array<{ input: unknown; outputSummary: string }>
  }
  /** Handoff targets */
  handoffs?: AgentHandoff[]
}

/**
 * Agent permission descriptor
 */
export interface AgentPermission {
  /** Operation type */
  op: string
  /** Scope patterns */
  scope?: string[]
}

/**
 * Agent handoff descriptor
 */
export interface AgentHandoff {
  /** Target agent ID */
  to: string
  /** When to handoff (description or predicate) */
  when?: string | unknown
  /** Transfer mode */
  transfer?: { mode: 'minimal' | 'scoped' | 'full'; allowNamespaces?: string[] }
}

/**
 * Agent catalog data (full catalog for ctx.get)
 */
export interface AgentCatalogData {
  /** Team ID */
  teamId: string
  /** Team name */
  teamName?: string
  /** Generated timestamp */
  generatedAt: number
  /** Agent entries */
  agents: AgentCatalogEntry[]
}

/**
 * Parameters for catalog queries
 */
export interface AgentCatalogParams {
  /** Filter by capability */
  capability?: string
  /** Filter by role */
  role?: string
  /** Include detailed descriptions */
  verbose?: boolean
}

// ============================================================================
// Agent Registry
// ============================================================================

/**
 * Registry for agents within a team
 */
export class AgentRegistry {
  private agents = new Map<string, AgentHandle>()
  private teamId: string
  private teamName?: string

  constructor(teamId: string, teamName?: string) {
    this.teamId = teamId
    this.teamName = teamName
  }

  /**
   * Register an agent
   */
  register(handle: AgentHandle): void {
    if (this.agents.has(handle.id)) {
      throw new Error(`Agent already registered: ${handle.id}`)
    }
    this.agents.set(handle.id, handle)
  }

  /**
   * Register multiple agents
   */
  registerAll(handles: Record<string, AgentHandle>): void {
    for (const handle of Object.values(handles)) {
      this.register(handle)
    }
  }

  /**
   * Get an agent by ID
   */
  get(id: string): AgentHandle | undefined {
    return this.agents.get(id)
  }

  /**
   * Check if agent exists
   */
  has(id: string): boolean {
    return this.agents.has(id)
  }

  /**
   * List all agent IDs
   */
  list(): string[] {
    return Array.from(this.agents.keys())
  }

  /**
   * Find agents by capability
   */
  findByCapability(capability: string): AgentHandle[] {
    const results: AgentHandle[] = []
    for (const handle of this.agents.values()) {
      if (handle.capabilities?.includes(capability)) {
        results.push(handle)
      }
    }
    return results
  }

  /**
   * Find agents by role
   */
  findByRole(role: string): AgentHandle[] {
    const results: AgentHandle[] = []
    for (const handle of this.agents.values()) {
      if (handle.role === role) {
        results.push(handle)
      }
    }
    return results
  }

  /**
   * Generate catalog for LLM consumption
   */
  getCatalog(params?: AgentCatalogParams): AgentCatalogData {
    const agents: AgentCatalogEntry[] = []

    for (const handle of this.agents.values()) {
      // Apply filters
      if (params?.capability && !handle.capabilities?.includes(params.capability)) {
        continue
      }
      if (params?.role && handle.role !== params.role) {
        continue
      }

      const entry: AgentCatalogEntry = {
        id: handle.id,
        role: handle.role,
        capabilities: handle.capabilities ?? []
      }

      // Add verbose details if requested
      if (params?.verbose) {
        entry.description = this.getAgentDescription(handle)
        entry.interfaces = this.getAgentInterfaces(handle)
      }

      agents.push(entry)
    }

    return {
      teamId: this.teamId,
      teamName: this.teamName,
      generatedAt: Date.now(),
      agents
    }
  }

  /**
   * Format catalog for LLM prompt
   */
  formatForLLM(params?: AgentCatalogParams): string {
    const catalog = this.getCatalog(params)
    const lines: string[] = [
      `# Agent Catalog for ${catalog.teamName ?? catalog.teamId}`,
      '',
      `Available agents: ${catalog.agents.length}`,
      ''
    ]

    for (const agent of catalog.agents) {
      lines.push(`## ${agent.id}`)
      if (agent.role) {
        lines.push(`Role: ${agent.role}`)
      }
      if (agent.capabilities.length > 0) {
        lines.push(`Capabilities: ${agent.capabilities.join(', ')}`)
      }
      if (agent.description) {
        lines.push(`Description: ${agent.description}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private getAgentDescription(handle: AgentHandle): string | undefined {
    const agent = handle.agent as Record<string, unknown>
    if (typeof agent?.description === 'string') {
      return agent.description
    }
    return undefined
  }

  private getAgentInterfaces(handle: AgentHandle): AgentCatalogEntry['interfaces'] | undefined {
    const agent = handle.agent as Record<string, unknown>
    if (typeof agent?.inputSchema === 'object' || typeof agent?.outputSchema === 'object') {
      return {
        inputSchema: agent.inputSchema,
        outputSchema: agent.outputSchema
      }
    }
    return undefined
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an agent registry from a team definition
 */
export function createAgentRegistry(team: TeamDefinition): AgentRegistry {
  const registry = new AgentRegistry(team.id, team.name)
  registry.registerAll(team.agents)
  return registry
}
