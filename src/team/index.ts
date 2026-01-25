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
 *   createAutoTeamRuntime
 * } from 'agent-foundry/team'
 * import { defineLLMAgent } from 'agent-foundry'
 *
 * // Define typed agents
 * const researcher = defineLLMAgent({
 *   id: 'researcher',
 *   inputSchema: z.object({ topic: z.string() }),
 *   outputSchema: z.object({ findings: z.array(z.string()) }),
 *   system: 'You are a researcher.',
 *   buildPrompt: ({ topic }) => `Research: ${topic}`
 * })
 *
 * const writer = defineLLMAgent({
 *   id: 'writer',
 *   inputSchema: z.object({ findings: z.array(z.string()) }),
 *   outputSchema: z.object({ title: z.string(), content: z.string() }),
 *   system: 'You are a writer.',
 *   buildPrompt: ({ findings }) => `Write article based on: ${findings.join(', ')}`
 * })
 *
 * // Define team - agentHandle auto-creates runners
 * const team = defineTeam({
 *   id: 'my-team',
 *   agents: {
 *     researcher: agentHandle('researcher', researcher),
 *     writer: agentHandle('writer', writer),
 *   },
 *   state: stateConfig.memory('my-team'),
 *   flow: seq(
 *     step(researcher)
 *       .in(state.initial<{ topic: string }>())
 *       .out(state.path('research')),
 *     step(writer)
 *       .in(mapInput(state.path('research'), r => ({ findings: r.findings })))
 *       .out(state.path('article'))
 *   )
 * })
 *
 * // Create runtime - no agentInvoker switch needed!
 * const runtime = createAutoTeamRuntime({
 *   team,
 *   context: { getLanguageModel: () => openai('gpt-4o') }
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
  AgentRunner,
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
  createAutoTeamRuntime,
  createPassthroughInvoker,
  createMockInvoker,
  canUseAutoRuntime,
  getMissingRunners
} from './team-runtime.js'

export type {
  TeamRunResult,
  TeamTraceEvent,
  TeamRuntimeConfig,
  AutoTeamRuntimeConfig,
  TeamUsageStats
} from './team-runtime.js'

// Runtime Events
export {
  TeamEventEmitter,
  createEventEmitter,
  generateSpanId,
  generateRunId
} from './runtime/index.js'

export type {
  TeamRuntimeEvents,
  TokenUsage,
  BaseEvent,
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
