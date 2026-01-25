# Multi-Agent Team System

The Team module provides primitives and combinators for building multi-agent collaborative workflows in Agent Foundry.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Defining Teams](#defining-teams)
- [Contract-First API](#contract-first-api)
- [Flow Specification](#flow-specification)
- [Reducers](#reducers)
- [Shared State (Blackboard)](#shared-state-blackboard)
- [Channels](#channels)
- [Protocol Templates](#protocol-templates)
- [Handoff Mechanism](#handoff-mechanism)
- [Agent Bridge](#agent-bridge)
- [Runtime Events](#runtime-events)
- [Complete Example](#complete-example)

---

## Overview

The Team system enables:

- **Flow-based orchestration**: Define how agents collaborate using composable flow combinators
- **Contract-first design**: Zod schemas define typed contracts between agents
- **Parallel execution**: Run agents concurrently with join/reduce operations
- **Shared state**: Blackboard pattern for inter-agent communication
- **Pub/Sub channels**: Real-time messaging between agents
- **Protocol templates**: Pre-built patterns for common workflows
- **Handoff**: Dynamic control transfer between agents

```
┌─────────────────────────────────────────────────────────────────┐
│                        Team Runtime                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐                    │
│   │ Agent A │───▶│ Agent B │───▶│ Agent C │   Sequential       │
│   └─────────┘    └─────────┘    └─────────┘                    │
│                                                                 │
│   ┌─────────┐                                                   │
│   │ Agent D │──┐                                                │
│   └─────────┘  │                                                │
│                ├──▶ [Reducer] ──▶ Output      Parallel          │
│   ┌─────────┐  │                                                │
│   │ Agent E │──┘                                                │
│   └─────────┘                                                   │
│                                                                 │
│   ┌─────────────────────────────────────────┐                  │
│   │            Shared Blackboard            │                  │
│   └─────────────────────────────────────────┘                  │
│                                                                 │
│   ┌─────────────────────────────────────────┐                  │
│   │            Channel Hub                  │                  │
│   └─────────────────────────────────────────┘                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```typescript
import { z } from 'zod'
import {
  defineTeam,
  agentHandle,
  seq,
  step,
  state,
  createTeamRuntime,
  createPassthroughInvoker
} from 'agent-foundry/team'
import { defineLLMAgent } from 'agent-foundry'

// 1. Define agents with contracts
const researcher = defineLLMAgent({
  id: 'researcher',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ findings: z.string() }),
  system: 'You are a research specialist.',
  buildPrompt: ({ topic }) => `Research: ${topic}`
})

const writer = defineLLMAgent({
  id: 'writer',
  inputSchema: z.object({ findings: z.string() }),
  outputSchema: z.object({ article: z.string() }),
  system: 'You are a content writer.',
  buildPrompt: ({ findings }) => `Write article based on: ${findings}`
})

// 2. Define team with typed flow
const team = defineTeam({
  id: 'writing-team',
  agents: {
    researcher: agentHandle('researcher', researcher),
    writer: agentHandle('writer', writer)
  },
  flow: seq(
    step(researcher)
      .in(state.initial<{ topic: string }>())
      .out(state.path<{ findings: string }>('research')),
    step(writer)
      .in(state.path<{ findings: string }>('research'))
      .out(state.path<{ article: string }>('article'))
  )
})

// 3. Create runtime
const runtime = createTeamRuntime({
  team,
  agentInvoker: createPassthroughInvoker()
})

// 4. Execute
const result = await runtime.run({ topic: 'AI Safety' })
console.log(result.output)
```

---

## Defining Teams

### defineTeam(definition)

Creates a team definition with agents and flow specification.

```typescript
import { defineTeam, agentHandle, stateConfig } from 'agent-foundry/team'

const team = defineTeam({
  // Required
  id: 'my-team',
  agents: {
    agent1: agentHandle('agent1', myAgent1),
    agent2: agentHandle('agent2', myAgent2)
  },
  flow: seq(...),

  // Optional
  name: 'My Team',
  description: 'A collaborative team',

  // Shared state
  state: stateConfig.memory('my-namespace'),

  // Channel configurations
  channels: {
    updates: { kind: 'pubsub', retentionMs: 60000 },
    rpc: { kind: 'reqrep' }
  },

  // Custom reducers
  reducers: [
    { id: 'custom-merge', fn: (results) => ({ ...results }) }
  ],

  // Custom validators
  validators: [
    {
      id: 'quality-check',
      description: 'Check output quality',
      validate: (input) => ({ ok: input.score > 0.8 })
    }
  ],

  // Default settings
  defaults: {
    concurrency: 4,
    timeouts: { agentSec: 120, flowSec: 1200 }
  }
})
```

### agentHandle(id, agent, options?)

Creates an agent handle for use in defineTeam.

```typescript
const handle = agentHandle('researcher', researcherAgent, {
  role: 'Research Specialist',
  capabilities: ['web-search', 'document-analysis', 'summarization']
})
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Unique agent identifier |
| `agent` | `Agent` | Agent instance |
| `options.role` | `string` | Role description |
| `options.capabilities` | `string[]` | Agent capabilities for routing |

---

## Contract-First API

The contract-first API uses Zod schemas to define typed contracts between agents.

### Benefits

- **Type Safety**: Full TypeScript support with Zod schemas
- **No JSON Parsing**: Objects flow directly between agents
- **Edge Transformations**: Use `mapInput()` for data transformation
- **Step Builder**: Fluent API with `step().in().out()`
- **Code Reduction**: ~70% less code compared to string-based I/O

### defineLLMAgent()

Create type-safe LLM agents with schema validation.

```typescript
import { z } from 'zod'
import { defineLLMAgent } from 'agent-foundry'

// Define contracts
const InputSchema = z.object({
  userRequest: z.string()
})

const OutputSchema = z.object({
  queries: z.array(z.string()),
  focusAreas: z.array(z.string())
})

// Create agent
const planner = defineLLMAgent({
  id: 'planner',
  description: 'Query Planning Specialist',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  system: 'You are a query planning specialist...',
  buildPrompt: ({ userRequest }) =>
    `Analyze this request and create search queries:\n\n"${userRequest}"`
})
```

### step() Builder

Fluent API for defining flow steps with type checking.

```typescript
import { step, state, mapInput } from 'agent-foundry/team'

// Basic step with state output
step(planner)
  .in(state.initial<{ userRequest: string }>())
  .out(state.path<QueryPlan>('plan'))

// With name and tags
step(reviewer)
  .in(state.path<SearchResults>('search'))
  .name('Review results')
  .tags('review', 'validation')
  .out(state.path<ReviewResult>('review'))

// Without state output (uses previous output)
step(validator)
  .in(state.path('data'))
  .build()
```

### mapInput()

Transform data between steps without agent modification.

```typescript
import { mapInput, state } from 'agent-foundry/team'

// Transform plan to searcher input
step(searcher)
  .in(mapInput(
    state.path<QueryPlan>('plan'),
    (plan) => ({
      queries: plan.searchQueries,
      sources: plan.searchStrategy.suggestedSources
    })
  ))
  .out(state.path<SearchResults>('search'))

// Chain transformations
step(formatter)
  .in(mapInput(
    state.path<ReviewResult>('review'),
    (review) => ({
      papers: review.relevantPapers.map(p => ({
        title: p.title,
        year: p.year
      }))
    })
  ))
  .build()
```

### Typed State References

Type-safe state path references.

```typescript
import { state } from 'agent-foundry/team'

// State paths with type annotations
state.initial<{ userRequest: string }>()   // Initial input
state.path<QueryPlan>('plan')               // State path
state.prev<SearchResults>()                 // Previous output
state.const({ limit: 10 })                  // Constant value
```

### branch() and noop

Conditional flow without agent logic pollution.

```typescript
import { branch, noop, step, state, mapInput } from 'agent-foundry/team'

// Only refine if not approved
branch({
  when: (s: any) => s.review?.approved === false,
  then: step(searcher)
    .in(mapInput(
      state.path<ReviewResult>('review'),
      (r) => ({
        queries: r.additionalQueries || [],
        sources: ['arxiv', 'semantic_scholar']
      })
    ))
    .out(state.path<SearchResults>('search')),
  else: noop
})
```

---

## Flow Specification

Flows define how agents collaborate. They are composable and serializable.

### seq(...steps)

Execute steps sequentially. Each step receives the previous step's output.

```typescript
import { seq, step, state } from 'agent-foundry/team'

const flow = seq(
  step(researcher).in(state.initial()).out(state.path('research')),
  step(analyzer).in(state.path('research')).out(state.path('analysis')),
  step(writer).in(state.path('analysis')).out(state.path('draft'))
)
```

### par(branches, joinSpec, options?)

Execute branches in parallel, then join results.

```typescript
import { par, step, state, join } from 'agent-foundry/team'

const flow = par(
  [
    step(analyst1).in(state.initial()).build(),
    step(analyst2).in(state.initial()).build(),
    step(analyst3).in(state.initial()).build()
  ],
  join('merge')  // Combine results
)
```

**Join Options:**

| Reducer | Description |
|---------|-------------|
| `merge` | Deep merge all results into one object |
| `collect` | Collect results into an array |
| `first` | Take the first successful result |
| `vote` | Majority voting (for classification) |

### loop(body, until, options?)

Repeat a flow until a condition is met.

```typescript
import { loop, seq, step, state } from 'agent-foundry/team'

const flow = loop(
  seq(
    step(critic).in(state.path('draft')).out(state.path('review')),
    step(refiner).in(state.path('review')).out(state.path('draft'))
  ),
  { type: 'field-eq', path: 'review.approved', value: true },  // Until condition
  { maxIters: 5 }  // Maximum iterations
)
```

**Until Conditions:**

```typescript
// Stop when field equals value
{ type: 'field-eq', path: 'review.approved', value: true }

// Stop after N iterations
{ type: 'max-iterations', count: 5 }

// Stop based on predicate
{ type: 'predicate', predicate: { op: 'eq', path: 'done', value: true } }
```

### race(contenders, winner, options?)

Execute multiple flows, take the winner based on strategy.

```typescript
import { race, step, state } from 'agent-foundry/team'

const flow = race(
  [
    step(fastModel).in(state.initial()).build(),
    step(accurateModel).in(state.initial()).build()
  ],
  { type: 'firstSuccess' }
)
```

**Winner Types:**

| Type | Description |
|------|-------------|
| `firstSuccess` | First non-error result |
| `firstComplete` | First to complete (even if error) |
| `highestScore` | Highest score at specified path |

### supervise(supervisor, workers, joinSpec, strategy, options?)

Supervisor pattern: one agent coordinates others.

```typescript
import { supervise, step, state, join } from 'agent-foundry/team'

const flow = supervise(
  step(manager).in(state.initial()).build(),  // Supervisor
  par([
    step(worker1).in(state.prev()).build(),
    step(worker2).in(state.prev()).build()
  ], join('merge')),
  join('merge'),
  'parallel'  // or 'sequential'
)
```

### gate(gateSpec, onPass, onFail, options?)

Conditional execution based on validation.

```typescript
import { gate, step, state } from 'agent-foundry/team'

const flow = gate(
  { type: 'predicate', predicate: { op: 'eq', path: 'quality.score', value: true } },
  step(publisher).in(state.prev()).build(),  // If validation passes
  step(improver).in(state.prev()).build()    // If validation fails
)
```

---

## Reducers

Reducers combine results from parallel execution.

### Built-in Reducers

```typescript
import { par, join } from 'agent-foundry/team'

// Deep merge objects
par(branches, join('merge'))

// Collect into array
par(branches, join('collect'))

// Take first result
par(branches, join('first'))

// Majority voting
par(branches, join('vote'))
```

### Custom Reducers

```typescript
const team = defineTeam({
  // ...
  reducers: [
    {
      id: 'weighted-merge',
      fn: (results) => {
        // Custom logic to combine results
        return weightedAverage(results)
      }
    }
  ]
})

// Use in flow
par(branches, join('weighted-merge'))
```

---

## Shared State (Blackboard)

The Blackboard provides shared state for agents to read and write.

### Configuration

```typescript
import { stateConfig } from 'agent-foundry/team'

const team = defineTeam({
  // Memory-based (default)
  state: stateConfig.memory('my-namespace'),

  // SQLite-based (persistent)
  state: stateConfig.sqlite('my-namespace', { versioning: 'optimistic' })
})
```

### Using Blackboard

```typescript
import { createBlackboard } from 'agent-foundry/team'

const blackboard = createBlackboard({
  storage: 'memory',
  namespace: 'my-team'
})

// Write
blackboard.set('research.findings', { data: [...] })
blackboard.merge('context', { additional: 'info' })

// Read
const findings = blackboard.get('research.findings')
const all = blackboard.getAll()

// Computed values
blackboard.setComputed('summary', () => summarize(blackboard.get('findings')))

// Transactions
await blackboard.transaction(async (tx) => {
  tx.set('step1', 'done')
  tx.set('step2', 'done')
})

// Subscribe to changes
const unsub = blackboard.subscribe('research.*', (key, value) => {
  console.log(`${key} changed:`, value)
})
```

---

## Channels

Channels enable real-time communication between agents.

### Creating a Channel Hub

```typescript
import { createChannelHub } from 'agent-foundry/team'

const hub = createChannelHub({
  retentionMs: 60000,  // Keep messages for 1 minute
  maxQueueSize: 1000
})
```

### Pub/Sub Pattern

```typescript
// Subscribe (supports wildcards)
const subscription = hub.subscribe('updates.*', (message) => {
  console.log('Received:', message.topic, message.payload)
})

// With filter
hub.subscribe('updates.*', (message) => {
  console.log(message)
}, {
  filter: (msg) => msg.payload.priority === 'high'
})

// Publish
hub.publish('updates.status', { progress: 50, status: 'running' })

// Unsubscribe
subscription.unsubscribe()
```

### Request/Response Pattern

```typescript
// Handler
hub.subscribe('questions', async (message, reply) => {
  const answer = await computeAnswer(message.payload.question)
  reply({ answer })
})

// Request (with timeout)
const response = await hub.request('questions', {
  question: 'What is the capital of France?'
}, { timeoutMs: 5000 })

console.log(response.answer)  // 'Paris'
```

### Message History

```typescript
// Get recent messages
const recent = hub.getHistory('updates.*', { limit: 10 })

// Clear history
hub.clearHistory('updates.*')
```

---

## Protocol Templates

Pre-built patterns for common multi-agent workflows.

### Available Protocols

| Protocol | Description | Required Roles |
|----------|-------------|----------------|
| `pipeline` | Sequential processing | `stages: string[]` |
| `fanOutFanIn` | Parallel with merge | `workers: string[]` |
| `supervisorProtocol` | Supervisor pattern | `supervisor`, `workers` |
| `criticRefineLoop` | Iterative refinement | `producer`, `critic`, `refiner` |
| `debate` | Debate + judge | `debaters`, `judge` |
| `voting` | Majority voting | `voters: string[]` |
| `raceProtocol` | First wins | `racers: string[]` |
| `gatedPipeline` | Pipeline with gates | `stages`, `validators?` |

### Using Protocol Templates

```typescript
import { pipeline, debate, createProtocolRegistry } from 'agent-foundry/team'

// Direct usage
const pipelineFlow = pipeline.build({
  agents: {
    stages: ['preprocessor', 'analyzer', 'formatter']
  }
})

// With options
const debateFlow = debate.build({
  agents: {
    debaters: ['advocate', 'critic'],
    judge: 'arbiter'
  },
  options: {
    rounds: 3
  }
})

// Via Registry
const registry = createProtocolRegistry()

// List available protocols
console.log(registry.list())  // ['pipeline', 'fan-out-fan-in', 'supervisor', ...]

// Build from registry
const flow = registry.build('critic-refine-loop', {
  agents: {
    producer: 'writer',
    critic: 'editor',
    refiner: 'rewriter'
  },
  options: {
    maxIterations: 5
  }
})
```

---

## Handoff Mechanism

Agents can dynamically hand off control to other agents.

### Creating Handoffs

```typescript
import { createHandoff } from 'agent-foundry/team'

// Simple handoff
const handoff = createHandoff('specialist-agent')

// With data
const handoff = createHandoff('specialist-agent', {
  data: { context: 'Need help with...', priority: 'high' },
  reason: 'Complex technical question requires expert'
})

// With transfer specification
const handoff = createHandoff('specialist-agent', {
  data: { task: 'Analyze document' },
  transfer: { mode: 'minimal' }  // Transfer mode
})
```

### Detecting Handoffs

```typescript
import { isHandoffResult, parseHandoff } from 'agent-foundry/team'

// Check if result is a handoff
if (isHandoffResult(agentOutput)) {
  console.log('Agent wants to hand off to:', agentOutput.target)
}

// Parse handoff from various formats
const handoff = parseHandoff(agentOutput)
if (handoff) {
  console.log('Handoff to:', handoff.target)
  console.log('Data:', handoff.data)
  console.log('Reason:', handoff.reason)
}
```

### Executing Handoff Chains

```typescript
import { executeHandoffChain } from 'agent-foundry/team'

const result = await executeHandoffChain(
  'initial-agent',          // Starting agent
  { question: 'How to...' }, // Initial input
  async (agentId, input) => {
    // Your invoker function
    return await invokeAgent(agentId, input)
  },
  {
    maxHandoffs: 5,           // Maximum handoff depth
    trackHistory: true,       // Track handoff chain
    allowedTargets: ['a', 'b', 'c']  // Restrict targets
  }
)

console.log(result.completed)      // Did chain complete?
console.log(result.finalAgent)     // Final agent in chain
console.log(result.output)         // Final output
console.log(result.handoffHistory) // Chain history
// [{ from: 'agent1', to: 'agent2', reason: '...', ts: 1234567890 }, ...]
```

---

## Agent Bridge

Connect the team system with actual Agent instances.

### Creating a Bridge

```typescript
import {
  createAgentBridge,
  createMapBasedResolver,
  createFactoryResolver
} from 'agent-foundry/team'

// Map-based resolver (pre-created agents)
const bridge = createAgentBridge({
  team,
  agentResolver: createMapBasedResolver({
    researcher: researcherAgent,
    writer: writerAgent
  })
})

// Factory resolver (create on demand)
const bridge = createAgentBridge({
  team,
  agentResolver: createFactoryResolver(async (agentId, handle) => {
    return await createAgentForRole(handle.role)
  })
})
```

### Using the Bridge

```typescript
const bridge = createAgentBridge({
  team,
  agentResolver: createMapBasedResolver(agents),

  // Transform input before sending to agent
  inputTransform: (input, agentId) => {
    return { ...input, agentId }
  },

  // Transform output after receiving from agent
  outputTransform: (output, agentId) => {
    return { ...output, source: agentId }
  },

  // Error handler
  onError: (error, agentId) => {
    console.error(`Agent ${agentId} failed:`, error)
  },

  // Handoff handler
  onHandoff: (handoff, fromAgentId) => {
    console.log(`Handoff from ${fromAgentId} to ${handoff.target}`)
  }
})

// Create invoker for runtime
const invoker = bridge.createInvoker()

// Get stats
console.log(bridge.getInvocationCount('researcher'))
console.log(bridge.getResolvedAgents())

// Clear cache
bridge.clearCache()
```

### Bridged Runtime (Convenience)

```typescript
import { createBridgedTeamRuntime } from 'agent-foundry/team'

const { runtime, bridge } = createBridgedTeamRuntime({
  team,
  agentResolver: createMapBasedResolver(agents)
})

const result = await runtime.run({ topic: 'AI Safety' })
console.log(result.output)
console.log(bridge.getInvocationCount('researcher'))
```

---

## Runtime Events

Subscribe to team execution events for observability.

### Event Types

| Event | Description |
|-------|-------------|
| `team.started` | Team execution started |
| `team.completed` | Team execution completed successfully |
| `team.failed` | Team execution failed |
| `agent.started` | Agent invocation started |
| `agent.completed` | Agent invocation completed |
| `agent.failed` | Agent invocation failed |
| `step.started` | Flow step started |
| `step.completed` | Flow step completed |
| `step.failed` | Flow step failed |
| `loop.iteration` | Loop iteration executed |
| `loop.completed` | Loop finished |
| `branch.decision` | Branch condition evaluated |
| `state.updated` | State value changed |

### Subscribing to Events

```typescript
import { createTeamRuntime } from 'agent-foundry/team'

const runtime = createTeamRuntime({ team, agentInvoker })

// Subscribe to agent events
runtime.on('agent.started', ({ agentId, step, input }) => {
  console.log(`[Step ${step}] Starting ${agentId}`)
})

runtime.on('agent.completed', ({ agentId, durationMs, tokens }) => {
  console.log(`${agentId} completed in ${durationMs}ms`)
  if (tokens) {
    console.log(`  Tokens: ${tokens.totalTokens}`)
  }
})

// Subscribe to team lifecycle
runtime.on('team.started', ({ teamId, input }) => {
  console.log(`Team ${teamId} started with input:`, input)
})

runtime.on('team.completed', ({ teamId, steps, durationMs }) => {
  console.log(`Team ${teamId} completed in ${durationMs}ms (${steps} steps)`)
})

runtime.on('team.failed', ({ teamId, error }) => {
  console.error(`Team ${teamId} failed:`, error.message)
})

// One-time subscription
runtime.once('team.completed', ({ output }) => {
  console.log('Final output:', output)
})

// Unsubscribe
const unsubscribe = runtime.on('agent.started', handler)
unsubscribe() // Stop receiving events
```

### Direct Emitter Access

```typescript
const emitter = runtime.getEventEmitter()

emitter.on('loop.iteration', ({ loopId, iteration, maxIterations }) => {
  console.log(`Loop ${loopId}: iteration ${iteration}/${maxIterations}`)
})

emitter.on('branch.decision', ({ branchId, taken }) => {
  console.log(`Branch ${branchId} took: ${taken}`)
})
```

### Event Payloads

```typescript
// Agent events include token usage
interface AgentCompletedEvent {
  agentId: string
  runId: string
  output: unknown
  durationMs: number
  step: number
  tokens?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  ts: number
}

// Loop events track iterations
interface LoopIterationEvent {
  loopId: string
  runId: string
  iteration: number
  maxIterations: number
  continuing: boolean
  ts: number
}

// State events track changes
interface StateUpdatedEvent {
  path: string
  value: unknown
  previousValue?: unknown
  runId: string
  updatedBy?: string
  ts: number
}
```

---

## Complete Example

A complete example of a literature research team using contract-first API:

```typescript
import { z } from 'zod'
import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  loop,
  step,
  state,
  mapInput,
  branch,
  noop,
  createBridgedTeamRuntime,
  createMapBasedResolver,
  createChannelHub
} from 'agent-foundry/team'
import { defineLLMAgent } from 'agent-foundry'

// ============= Schemas (Contracts) =============

const QueryPlanSchema = z.object({
  searchQueries: z.array(z.string()),
  searchStrategy: z.object({
    focusAreas: z.array(z.string()),
    suggestedSources: z.array(z.string())
  })
})

const SearchResultsSchema = z.object({
  papers: z.array(z.object({
    title: z.string(),
    authors: z.array(z.string()),
    abstract: z.string()
  })),
  totalFound: z.number()
})

const ReviewResultSchema = z.object({
  approved: z.boolean(),
  relevantPapers: z.array(z.object({
    title: z.string(),
    relevanceScore: z.number()
  })),
  additionalQueries: z.array(z.string()).optional()
})

// ============= Agents =============

const planner = defineLLMAgent({
  id: 'planner',
  inputSchema: z.object({ userRequest: z.string() }),
  outputSchema: QueryPlanSchema,
  system: 'You are a query planning specialist.',
  buildPrompt: ({ userRequest }) =>
    `Create search queries for: "${userRequest}"`
})

const searcher = defineLLMAgent({
  id: 'searcher',
  inputSchema: z.object({
    queries: z.array(z.string()),
    sources: z.array(z.string())
  }),
  outputSchema: SearchResultsSchema,
  system: 'You are a literature search specialist.',
  buildPrompt: ({ queries }) =>
    `Search for papers matching: ${queries.join(', ')}`
})

const reviewer = defineLLMAgent({
  id: 'reviewer',
  inputSchema: SearchResultsSchema,
  outputSchema: ReviewResultSchema,
  system: 'You are a research quality reviewer.',
  buildPrompt: (results) =>
    `Review these ${results.papers.length} papers for relevance.`
})

// ============= Team Definition =============

const team = defineTeam({
  id: 'literature-research',
  name: 'Literature Research Team',
  description: 'A team that researches academic literature',

  agents: {
    planner: agentHandle('planner', planner, {
      role: 'Query Planning Specialist',
      capabilities: ['query-planning', 'strategy']
    }),
    searcher: agentHandle('searcher', searcher, {
      role: 'Literature Search Specialist',
      capabilities: ['search', 'document-retrieval']
    }),
    reviewer: agentHandle('reviewer', reviewer, {
      role: 'Quality Reviewer',
      capabilities: ['review', 'quality-assessment']
    })
  },

  // Shared state configuration
  state: stateConfig.memory('literature-research'),

  // Communication channels
  channels: {
    progress: { kind: 'pubsub', retentionMs: 60000 },
    feedback: { kind: 'reqrep' }
  },

  // Flow: Plan -> Search -> Review Loop
  flow: seq(
    // Step 1: Create search plan
    step(planner)
      .in(state.initial<{ userRequest: string }>())
      .name('Create search plan')
      .out(state.path<z.infer<typeof QueryPlanSchema>>('plan')),

    // Step 2: Execute search (with transformation)
    step(searcher)
      .in(mapInput(
        state.path<z.infer<typeof QueryPlanSchema>>('plan'),
        (plan) => ({
          queries: plan.searchQueries,
          sources: plan.searchStrategy.suggestedSources
        })
      ))
      .name('Execute search')
      .out(state.path<z.infer<typeof SearchResultsSchema>>('search')),

    // Step 3: Review loop
    loop(
      seq(
        step(reviewer)
          .in(state.path<z.infer<typeof SearchResultsSchema>>('search'))
          .name('Review results')
          .out(state.path<z.infer<typeof ReviewResultSchema>>('review')),

        branch({
          when: (s: any) => !s.review?.approved,
          then: step(searcher)
            .in(mapInput(
              state.path<z.infer<typeof ReviewResultSchema>>('review'),
              (r) => ({
                queries: r.additionalQueries || [],
                sources: ['arxiv', 'semantic_scholar']
              })
            ))
            .name('Additional search')
            .out(state.path<z.infer<typeof SearchResultsSchema>>('search')),
          else: noop
        })
      ),
      { type: 'field-eq', path: 'review.approved', value: true },
      { maxIters: 2 }
    )
  ),

  // Default settings
  defaults: {
    concurrency: 2,
    timeouts: {
      agentSec: 120,
      flowSec: 600
    }
  }
})

// ============= Runtime =============

// Create channel hub for real-time communication
const channelHub = createChannelHub({ retentionMs: 300000 })

// Create runtime with bridge
const { runtime, bridge } = createBridgedTeamRuntime({
  team,
  agentResolver: createMapBasedResolver({
    planner,
    searcher,
    reviewer
  }),
  channelHub,
  onError: (error, agentId) => {
    console.error(`Error in ${agentId}:`, error.message)
  }
})

// Subscribe to events
runtime.on('agent.started', ({ agentId, step }) => {
  console.log(`[Step ${step}] Starting ${agentId}`)
})

runtime.on('agent.completed', ({ agentId, durationMs }) => {
  console.log(`${agentId} completed in ${durationMs}ms`)
})

runtime.on('loop.iteration', ({ iteration, maxIterations }) => {
  console.log(`Review loop: iteration ${iteration}/${maxIterations}`)
})

// Subscribe to progress updates
channelHub.subscribe('progress.*', (msg) => {
  console.log(`[${msg.topic}]`, msg.payload)
})

// Execute the team
async function runResearchTeam(request: string) {
  console.log(`Starting research: ${request}`)

  const result = await runtime.run({ userRequest: request })

  if (result.success) {
    console.log('\n=== Results ===')
    console.log(result.output)

    // Print execution stats
    console.log('\n=== Execution Stats ===')
    console.log(`Planner invocations: ${bridge.getInvocationCount('planner')}`)
    console.log(`Searcher invocations: ${bridge.getInvocationCount('searcher')}`)
    console.log(`Reviewer invocations: ${bridge.getInvocationCount('reviewer')}`)
  } else {
    console.error('Team execution failed:', result.error)
  }

  return result
}

// Run
runResearchTeam('Find papers on transformer architectures in vision models')
```

---

## API Reference Summary

### Core Exports

```typescript
import {
  // Team Definition
  defineTeam,
  agentHandle,
  stateConfig,
  isTeamDefinition,

  // Flow Combinators
  seq,
  par,
  loop,
  map,
  choose,
  race,
  supervise,
  gate,
  join,
  transfer,

  // Contract-First API
  step,
  state,
  mapInput,
  branch,
  noop,

  // Runtime
  TeamRuntime,
  createTeamRuntime,
  createPassthroughInvoker,
  createMockInvoker,

  // State
  Blackboard,
  createBlackboard,

  // Channels
  ChannelHub,
  createChannelHub,

  // Protocols
  pipeline,
  fanOutFanIn,
  supervisorProtocol,
  criticRefineLoop,
  debate,
  voting,
  raceProtocol,
  gatedPipeline,
  ProtocolRegistry,
  createProtocolRegistry,
  builtinProtocols,

  // Handoff
  createHandoff,
  parseHandoff,
  isHandoffResult,
  executeHandoffChain,

  // Agent Bridge
  AgentBridge,
  createAgentBridge,
  createBridgedTeamRuntime,
  createMapBasedResolver,
  createFactoryResolver
} from 'agent-foundry/team'
```

### Types

```typescript
// Team
type TeamId = string
interface TeamDefinition { ... }
interface AgentHandle { ... }
interface TeamDefaults { ... }

// Flow
type FlowSpec = SeqSpec | ParSpec | LoopSpec | InvokeSpec | RaceSpec | SuperviseSpec | GateSpec | BranchSpec | NoopSpec
interface InputRef { ... }
interface JoinSpec { ... }
interface UntilSpec { ... }

// Contract-First
interface TypedStateRef<T> { ... }
interface MappedInputRef<S, T> { ... }
interface StepBuilder<I, O> { ... }

// Runtime
interface TeamRunResult { success: boolean; output: unknown; trace: TeamTraceEvent[] }
interface TeamRuntimeConfig { ... }
interface ExecutionContext { ... }

// State
interface BlackboardConfig { storage: 'memory' | 'sqlite'; namespace: string; ... }

// Channels
interface ChannelMessage { topic: string; payload: unknown; ts: number; ... }
interface ChannelSubscription { unsubscribe: () => void }

// Handoff
interface HandoffResult { type: 'handoff'; target: string; data?: unknown; reason?: string }
interface HandoffChainResult { completed: boolean; finalAgent: string; output: unknown; handoffHistory: [...] }

// Bridge
interface AgentBridgeConfig { team: TeamDefinition; agentResolver: AgentResolver; ... }
type AgentResolver = (agentId: string, handle: AgentHandle) => Promise<Agent | null>
```
