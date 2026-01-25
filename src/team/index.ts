/**
 * Team Module - Multi-Agent Collaboration
 *
 * This module provides primitives and combinators for building
 * multi-agent collaborative workflows using a contract-first approach.
 *
 * @example
 * ```typescript
 * import { z } from 'zod'
 * import {
 *   defineTeam, agentHandle, stateConfig,
 *   seq, step, state, mapInput,
 *   createTeamRuntime
 * } from 'agent-foundry/team'
 *
 * // Define typed schemas
 * const ResearchSchema = z.object({ findings: z.array(z.string()) })
 * const ArticleSchema = z.object({ title: z.string(), content: z.string() })
 *
 * const team = defineTeam({
 *   id: 'my-team',
 *   agents: {
 *     researcher: agentHandle('researcher', researcherAgent),
 *     writer: agentHandle('writer', writerAgent),
 *   },
 *   state: stateConfig.memory('my-team'),
 *   flow: seq(
 *     step(researcher)
 *       .in(state.initial<{ topic: string }>())
 *       .name('Research topic')
 *       .out(state.path<z.infer<typeof ResearchSchema>>('research')),
 *     step(writer)
 *       .in(mapInput(state.path('research'), r => ({ findings: r.findings })))
 *       .name('Write article')
 *       .out(state.path<z.infer<typeof ArticleSchema>>('article'))
 *   )
 * })
 *
 * const runtime = createTeamRuntime({ team, agentInvoker })
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

// Runtime Events
export {
  TeamEventEmitter,
  createEventEmitter
} from './runtime/index.js'

export type {
  TeamRuntimeEvents,
  TokenUsage,
  TeamStartedEvent,
  TeamCompletedEvent,
  TeamFailedEvent,
  AgentStartedEvent,
  AgentCompletedEvent,
  AgentFailedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  StepFailedEvent,
  LoopIterationEvent,
  LoopCompletedEvent,
  StateUpdatedEvent,
  BranchDecisionEvent,
  SelectDecisionEvent,
  EventHandler,
  Unsubscribe,
  EventPayload,
  ITeamEventEmitter
} from './runtime/index.js'

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
