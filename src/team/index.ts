/**
 * Team Module - Multi-Agent Collaboration
 *
 * This module provides primitives and combinators for building
 * multi-agent collaborative workflows.
 *
 * @example
 * ```typescript
 * import {
 *   defineTeam,
 *   seq, par, loop, invoke,
 *   input, until, join,
 *   createTeamRuntime
 * } from 'agent-foundry/team'
 *
 * const team = defineTeam({
 *   id: 'my-team',
 *   agents: {
 *     researcher: { id: 'researcher', agent: researcherAgent },
 *     writer: { id: 'writer', agent: writerAgent },
 *   },
 *   flow: seq(
 *     invoke('researcher', input.initial()),
 *     invoke('writer', input.prev())
 *   )
 * })
 *
 * const runtime = createTeamRuntime({
 *   team,
 *   agentInvoker: myAgentInvoker
 * })
 *
 * const result = await runtime.run({ topic: 'AI Safety' })
 * ```
 */

// Define Team
export {
  defineTeam,
  agentHandle,
  stateConfig,
  isTeamDefinition
} from './define-team.js'

export type {
  TeamId,
  TeamDefinition,
  AgentHandle,
  ChannelConfig,
  ValidatorRegistration,
  ValidatorResult,
  ValidatorIssue,
  TeamDefaults
} from './define-team.js'

// Agent Registry
export {
  AgentRegistry,
  createAgentRegistry
} from './agent-registry.js'

export type {
  AgentCatalogEntry,
  AgentCatalogData,
  AgentCatalogParams,
  AgentPermission,
  AgentHandoff
} from './agent-registry.js'

// Team Runtime
export {
  TeamRuntime,
  createTeamRuntime,
  createPassthroughInvoker,
  createMockInvoker
} from './team-runtime.js'

export type {
  TeamRunResult,
  TeamTraceEvent,
  TeamRuntimeConfig
} from './team-runtime.js'

// Flow (re-export all)
export * from './flow/index.js'

// State (re-export all)
export * from './state/index.js'

// Channels
export {
  ChannelHub,
  createChannelHub
} from './channels/index.js'

export type {
  ChannelMessage,
  ChannelSubscription,
  ChannelTraceEvent,
  ChannelTraceContext,
  ChannelHubConfig
} from './channels/index.js'

// Protocols
export {
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline,
  builtinProtocols,
  ProtocolRegistry,
  createProtocolRegistry
} from './protocols/index.js'

export type {
  ProtocolTemplate,
  ProtocolConfig
} from './protocols/index.js'

// Agent Bridge
export {
  AgentBridge,
  createAgentBridge,
  createMapBasedResolver,
  createFactoryResolver,
  createBridgedTeamRuntime
} from './agent-bridge.js'

export type {
  ResolvedAgent,
  AgentResolver,
  AgentBridgeConfig,
  BridgeTraceEvent
} from './agent-bridge.js'
