/**
 * Team Module - Multi-Agent Collaboration
 *
 * This module provides primitives and combinators for building
 * multi-agent collaborative workflows using a schema-free approach.
 *
 * @example
 * ```typescript
 * import {
 *   defineTeam, agentHandle, stateConfig,
 *   seq, loop, simpleStep, simpleBranch,
 *   createAutoTeamRuntime
 * } from 'agent-foundry/team'
 * import { defineAgent, packs } from 'agent-foundry'
 *
 * // Define schema-free agents with JSON output mode
 * const planner = defineAgent({
 *   id: 'planner',
 *   name: 'Research Planner',
 *   identity: 'You are a research planner. Output JSON with searchQueries array.',
 *   constraints: ['Always output valid JSON'],
 *   packs: [packs.safe()],
 *   model: { default: 'gpt-4o' }
 * })
 *
 * const searcher = defineAgent({
 *   id: 'searcher',
 *   name: 'Paper Searcher',
 *   identity: 'You search academic papers. Output JSON with papers array.',
 *   constraints: ['Always output valid JSON'],
 *   packs: [packs.safe(), packs.network()],
 *   model: { default: 'gpt-4o' }
 * })
 *
 * // Create agent instances
 * const plannerAgent = planner({ apiKey: 'sk-xxx' })
 * const searcherAgent = searcher({ apiKey: 'sk-xxx' })
 *
 * // Helper to create runners
 * const createRunner = (agent) => async (input) => {
 *   const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
 *   const result = await agent.run(inputStr)
 *   return parseJsonOutput(result.output)
 * }
 *
 * // Define team with schema-free flow
 * const team = defineTeam({
 *   id: 'research-team',
 *   agents: {
 *     planner: agentHandle('planner', plannerAgent, { runner: createRunner(plannerAgent) }),
 *     searcher: agentHandle('searcher', searcherAgent, { runner: createRunner(searcherAgent) }),
 *   },
 *   state: stateConfig.memory('research-team'),
 *   flow: seq(
 *     simpleStep('planner').from('initial').to('plan'),
 *     simpleStep('searcher').from('plan').to('papers'),
 *     loop(
 *       seq(
 *         simpleStep('reviewer').from('papers').to('feedback'),
 *         simpleBranch({
 *           if: (s) => s?.feedback?.approved === false,
 *           then: simpleStep('searcher').from('feedback').to('papers'),
 *           else: { kind: 'noop' }
 *         })
 *       ),
 *       { type: 'field-eq', path: 'feedback.approved', value: true },
 *       { maxIters: 3 }
 *     )
 *   )
 * })
 *
 * // Create runtime
 * const runtime = createAutoTeamRuntime({ team, context: {} })
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
  TeamDefaults,
  IsolationConfig,
  PermissionRule
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
  TeamUsageStats,
  TeamState
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

// Utilities (format helpers)
export {
  format,
  formatJson,
  formatList,
  formatBullets,
  formatKeyValue,
  formatTable,
  formatTruncated
} from './utils/index.js'

export type {
  FormatOptions
} from './utils/index.js'
