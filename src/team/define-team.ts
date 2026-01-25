/**
 * defineTeam - Main entry point for defining multi-agent teams
 *
 * A team bundles agents, shared state, channels, and a flow specification
 * into a runnable collaborative unit.
 */

import type { FlowSpec, TransferSpec } from './flow/ast.js'
import type { ReducerSpec } from './flow/reducers.js'
import type { BlackboardConfig } from './state/blackboard.js'
import type { AgentDefinition } from '../types/agent.js'

// ============================================================================
// Types
// ============================================================================

export type TeamId = string

/**
 * Agent handle within a team
 */
export interface AgentHandle {
  /** Unique ID within the team */
  id: string
  /** Role description */
  role?: string
  /** Capabilities for routing */
  capabilities?: string[]
  /** The actual agent definition or instance */
  agent: AgentDefinition | unknown
}

/**
 * Channel configuration
 */
export interface ChannelConfig {
  /** Channel type */
  kind: 'pubsub' | 'reqrep'
  /** Message schema (JSON Schema or Zod) */
  schema?: unknown
  /** Message retention in milliseconds */
  retentionMs?: number
}

/**
 * Validator registration
 */
export interface ValidatorRegistration {
  /** Unique validator ID */
  id: string
  /** Human-readable description */
  description: string
  /** Validation function */
  validate: (input: unknown) => ValidatorResult
}

/**
 * Validator result
 */
export interface ValidatorResult {
  /** Whether validation passed */
  ok: boolean
  /** Issues found */
  issues?: ValidatorIssue[]
  /** Optional score (0-1) */
  score?: number
}

/**
 * Validator issue
 */
export interface ValidatorIssue {
  /** Severity level */
  severity: 'critical' | 'major' | 'minor' | 'nit'
  /** Issue message */
  message: string
  /** Location in the input */
  location?: {
    path?: string
    line?: number
  }
}

/**
 * Team default settings
 */
export interface TeamDefaults {
  /** Default transfer mode */
  transfer?: TransferSpec
  /** Max concurrent agent executions */
  concurrency?: number
  /** Timeout settings */
  timeouts?: {
    /** Per-agent timeout in seconds */
    agentSec?: number
    /** Total flow timeout in seconds */
    flowSec?: number
  }
}

/**
 * Team definition
 */
export interface TeamDefinition {
  /** Unique team ID */
  id: TeamId
  /** Human-readable name */
  name?: string
  /** Description */
  description?: string

  /** Agents in this team */
  agents: Record<string, AgentHandle>

  /** Shared state configuration */
  state?: BlackboardConfig

  /** Channel configurations */
  channels?: Record<string, ChannelConfig>

  /** Custom reducers for joins */
  reducers?: ReducerSpec[]

  /** Custom validators for gates */
  validators?: ValidatorRegistration[]

  /** Policies to apply */
  policies?: unknown[]

  /** Additional context sources */
  contextSources?: unknown[]

  /** The flow specification */
  flow: FlowSpec

  /** Default settings */
  defaults?: TeamDefaults
}

// ============================================================================
// defineTeam Function
// ============================================================================

/**
 * Define a multi-agent team
 *
 * @example
 * const writingTeam = defineTeam({
 *   id: 'writing-team',
 *   name: 'Writing Team',
 *
 *   agents: {
 *     researcher: { id: 'researcher', role: 'researcher', agent: researcherAgent },
 *     drafter: { id: 'drafter', role: 'drafter', agent: drafterAgent },
 *     critic: { id: 'critic', role: 'critic', agent: criticAgent },
 *   },
 *
 *   state: {
 *     storage: 'memory',
 *     namespace: 'writing',
 *   },
 *
 *   flow: seq(
 *     invoke('researcher', input.initial()),
 *     invoke('drafter', input.prev()),
 *     loop(
 *       seq(
 *         invoke('critic', input.state('draft')),
 *         invoke('drafter', input.prev())
 *       ),
 *       until.noCriticalIssues('reviews'),
 *       { maxIters: 3 }
 *     )
 *   ),
 *
 *   defaults: {
 *     transfer: { mode: 'scoped', allowNamespaces: ['writing'] },
 *     concurrency: 4,
 *     timeouts: { agentSec: 120, flowSec: 1200 },
 *   },
 * })
 */
export function defineTeam(definition: TeamDefinition): TeamDefinition {
  // Validate required fields
  if (!definition.id) {
    throw new Error('Team definition must have an id')
  }

  if (!definition.agents || Object.keys(definition.agents).length === 0) {
    throw new Error('Team definition must have at least one agent')
  }

  if (!definition.flow) {
    throw new Error('Team definition must have a flow')
  }

  // Validate agent handles
  for (const [key, handle] of Object.entries(definition.agents)) {
    if (!handle.id) {
      throw new Error(`Agent handle '${key}' must have an id`)
    }
    if (!handle.agent) {
      throw new Error(`Agent handle '${key}' must have an agent`)
    }
  }

  // Return the definition (could add transformations here)
  return definition
}

// ============================================================================
// Helper: Create Agent Handle
// ============================================================================

/**
 * Create an agent handle for use in defineTeam
 */
export function agentHandle(
  id: string,
  agent: AgentDefinition | unknown,
  options?: {
    role?: string
    capabilities?: string[]
  }
): AgentHandle {
  return {
    id,
    agent,
    role: options?.role,
    capabilities: options?.capabilities
  }
}

// ============================================================================
// Helper: State Config Builder
// ============================================================================

export const stateConfig = {
  /**
   * Memory-based blackboard (default)
   */
  memory: (namespace: string): BlackboardConfig => ({
    storage: 'memory',
    namespace
  }),

  /**
   * SQLite-based blackboard (persistent)
   */
  sqlite: (namespace: string, options?: { versioning?: 'optimistic' | 'appendOnly' }): BlackboardConfig => ({
    storage: 'sqlite',
    namespace,
    versioning: options?.versioning ?? 'optimistic'
  })
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if value is a TeamDefinition
 */
export function isTeamDefinition(value: unknown): value is TeamDefinition {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.agents === 'object' &&
    obj.agents !== null &&
    typeof obj.flow === 'object' &&
    obj.flow !== null
  )
}
