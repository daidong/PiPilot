# Multi-Agent Team System

The Team module provides primitives and combinators for building multi-agent collaborative workflows in Agent Foundry.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Defining Teams](#defining-teams)
- [Flow Specification](#flow-specification)
- [Input Selectors](#input-selectors)
- [Reducers](#reducers)
- [Shared State (Blackboard)](#shared-state-blackboard)
- [Channels](#channels)
- [Protocol Templates](#protocol-templates)
- [Handoff Mechanism](#handoff-mechanism)
- [Agent Bridge](#agent-bridge)
- [Complete Example](#complete-example)

---

## Overview

The Team system enables:

- **Flow-based orchestration**: Define how agents collaborate using composable flow combinators
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
import {
  defineTeam,
  agentHandle,
  seq,
  invoke,
  input,
  createTeamRuntime,
  createPassthroughInvoker
} from 'agent-foundry/team'

// 1. Define agents
const researcherAgent = { /* your agent */ }
const writerAgent = { /* your agent */ }

// 2. Define team
const team = defineTeam({
  id: 'writing-team',
  agents: {
    researcher: agentHandle('researcher', researcherAgent),
    writer: agentHandle('writer', writerAgent)
  },
  flow: seq(
    invoke('researcher', input.initial()),
    invoke('writer', input.prev())
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

## Flow Specification

Flows define how agents collaborate. They are composable and serializable.

### seq(...steps)

Execute steps sequentially. Each step receives the previous step's output.

```typescript
import { seq, invoke, input } from 'agent-foundry/team'

const flow = seq(
  invoke('researcher', input.initial()),
  invoke('analyzer', input.prev()),
  invoke('writer', input.prev())
)
```

### par(...branches, options?)

Execute branches in parallel, then join results.

```typescript
import { par, invoke, input } from 'agent-foundry/team'

const flow = par(
  invoke('analyst1', input.initial()),
  invoke('analyst2', input.initial()),
  invoke('analyst3', input.initial()),
  {
    join: { reducerId: 'merge' }  // Combine results
  }
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
import { loop, seq, invoke, input, until } from 'agent-foundry/team'

const flow = loop(
  seq(
    invoke('critic', input.prev()),
    invoke('refiner', input.prev())
  ),
  until.custom('reviews.approved'),  // Stop when approved
  { maxIters: 5 }  // Maximum iterations
)
```

**Until Conditions:**

```typescript
until.maxIterations(5)          // Stop after N iterations
until.custom('state.path')      // Stop when state path is truthy
until.noCriticalIssues('reviews')  // Stop when no critical issues
```

### invoke(agent, inputSelector)

Invoke a specific agent with input.

```typescript
const step = invoke('writer', input.prev())
```

### race(...contenders, options?)

Execute multiple flows, take the first successful result.

```typescript
import { race, invoke, input } from 'agent-foundry/team'

const flow = race(
  invoke('fast-model', input.initial()),
  invoke('accurate-model', input.initial()),
  {
    winner: { type: 'firstSuccess' }
  }
)
```

**Winner Types:**

| Type | Description |
|------|-------------|
| `firstSuccess` | First non-error result |
| `firstComplete` | First to complete (even if error) |

### supervise(supervisor, workers, options?)

Supervisor pattern: one agent coordinates others.

```typescript
import { supervise, invoke, input } from 'agent-foundry/team'

const flow = supervise(
  invoke('manager', input.initial()),  // Supervisor
  [
    invoke('worker1', input.prev()),
    invoke('worker2', input.prev())
  ],
  {
    strategy: 'parallel',  // or 'sequential'
    maxRounds: 3
  }
)
```

### gate(validator, flow, options?)

Conditional execution based on validation.

```typescript
import { gate, invoke, input } from 'agent-foundry/team'

const flow = gate(
  'quality-validator',  // Validator ID
  invoke('publisher', input.prev()),
  {
    fallback: invoke('improver', input.prev())  // If validation fails
  }
)
```

---

## Input Selectors

Input selectors specify what data an agent receives.

```typescript
import { input } from 'agent-foundry/team'

// Initial input to the team
input.initial()

// Output from previous step
input.prev()

// Value from shared state
input.state('research.findings')

// Literal value
input.literal({ prompt: 'Analyze this' })

// Merge multiple state paths
input.merge(['research', 'context'])

// Output from specific parallel branch (0-indexed)
input.branch(0)

// Select specific field from previous output
input.select('summary')
```

---

## Reducers

Reducers combine results from parallel execution.

### Built-in Reducers

```typescript
import { merge, collect, first, vote } from 'agent-foundry/team'

// Deep merge objects
par(branch1, branch2, { join: { reducerId: 'merge' } })

// Collect into array
par(branch1, branch2, { join: { reducerId: 'collect' } })

// Take first result
par(branch1, branch2, { join: { reducerId: 'first' } })

// Majority voting
par(branch1, branch2, branch3, { join: { reducerId: 'vote' } })
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
par(branch1, branch2, { join: { reducerId: 'weighted-merge' } })
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

// Register custom protocol
registry.register({
  id: 'my-protocol',
  name: 'My Custom Protocol',
  description: 'A custom workflow',
  requiredRoles: ['main', 'helper'],
  build: (config) => seq(
    invoke(config.agents.main, input.initial()),
    invoke(config.agents.helper, input.prev())
  )
})
```

### Protocol Examples

#### Pipeline

```typescript
const flow = pipeline.build({
  agents: { stages: ['extract', 'transform', 'load'] }
})
// Results in: seq(invoke('extract'), invoke('transform'), invoke('load'))
```

#### Fan-Out Fan-In

```typescript
const flow = fanOutFanIn.build({
  agents: { workers: ['worker1', 'worker2', 'worker3'] },
  options: { reducer: 'merge' }
})
// Results in: par(invoke('worker1'), invoke('worker2'), invoke('worker3'), { join: 'merge' })
```

#### Supervisor

```typescript
const flow = supervisorProtocol.build({
  agents: {
    supervisor: 'manager',
    workers: ['dev1', 'dev2', 'dev3']
  },
  options: { strategy: 'parallel' }
})
```

#### Critic-Refine Loop

```typescript
const flow = criticRefineLoop.build({
  agents: {
    producer: 'writer',
    critic: 'reviewer',
    refiner: 'editor'
  },
  options: { maxIterations: 3 }
})
// Results in: seq(invoke('writer'), loop(seq(invoke('reviewer'), invoke('editor')), until, { maxIters: 3 }))
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

## Complete Example

A complete example of a research and writing team:

```typescript
import {
  defineTeam,
  agentHandle,
  stateConfig,
  seq,
  par,
  loop,
  invoke,
  input,
  until,
  createBridgedTeamRuntime,
  createMapBasedResolver,
  createChannelHub,
  criticRefineLoop
} from 'agent-foundry/team'

// Define agents (your actual agent implementations)
const researcherAgent = createResearcherAgent()
const writerAgent = createWriterAgent()
const criticAgent = createCriticAgent()
const editorAgent = createEditorAgent()

// Create channel hub for real-time communication
const channelHub = createChannelHub({ retentionMs: 300000 })

// Define team
const writingTeam = defineTeam({
  id: 'writing-team',
  name: 'Research & Writing Team',
  description: 'A team that researches topics and produces polished articles',

  agents: {
    researcher: agentHandle('researcher', researcherAgent, {
      role: 'Research Specialist',
      capabilities: ['web-search', 'document-analysis']
    }),
    writer: agentHandle('writer', writerAgent, {
      role: 'Content Writer',
      capabilities: ['article-writing', 'summarization']
    }),
    critic: agentHandle('critic', criticAgent, {
      role: 'Quality Critic',
      capabilities: ['review', 'feedback']
    }),
    editor: agentHandle('editor', editorAgent, {
      role: 'Editor',
      capabilities: ['editing', 'polishing']
    })
  },

  // Shared state for all agents
  state: stateConfig.memory('writing-team'),

  // Communication channels
  channels: {
    progress: { kind: 'pubsub', retentionMs: 60000 },
    feedback: { kind: 'reqrep' }
  },

  // Flow: Research -> Write -> Critique/Refine Loop -> Final Edit
  flow: seq(
    // Phase 1: Research
    invoke('researcher', input.initial()),

    // Phase 2: Initial Draft
    invoke('writer', input.prev()),

    // Phase 3: Critique and Refine (up to 3 iterations)
    loop(
      seq(
        invoke('critic', input.prev()),
        invoke('writer', input.prev())
      ),
      until.custom('reviews.approved'),
      { maxIters: 3 }
    ),

    // Phase 4: Final Polish
    invoke('editor', input.prev())
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

// Create runtime with bridge
const { runtime, bridge } = createBridgedTeamRuntime(
  {
    team: writingTeam,
    agentResolver: createMapBasedResolver({
      researcher: researcherAgent,
      writer: writerAgent,
      critic: criticAgent,
      editor: editorAgent
    }),
    channelHub,
    onError: (error, agentId) => {
      console.error(`Error in ${agentId}:`, error.message)
    }
  }
)

// Subscribe to progress updates
channelHub.subscribe('progress.*', (msg) => {
  console.log(`[${msg.topic}]`, msg.payload)
})

// Execute the team
async function runWritingTeam(topic: string) {
  console.log(`Starting research on: ${topic}`)

  const result = await runtime.run({
    topic,
    requirements: 'Write a comprehensive 2000-word article'
  })

  if (result.success) {
    console.log('\n=== Final Article ===')
    console.log(result.output)

    // Print execution stats
    console.log('\n=== Execution Stats ===')
    console.log(`Total steps: ${result.trace.length}`)
    console.log(`Researcher invocations: ${bridge.getInvocationCount('researcher')}`)
    console.log(`Writer invocations: ${bridge.getInvocationCount('writer')}`)
    console.log(`Critic invocations: ${bridge.getInvocationCount('critic')}`)
    console.log(`Editor invocations: ${bridge.getInvocationCount('editor')}`)
  } else {
    console.error('Team execution failed:', result.error)
  }

  return result
}

// Run
runWritingTeam('The Future of AI in Healthcare')
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
  invoke,
  race,
  supervise,
  gate,

  // Input Selectors
  input,

  // Until Conditions
  until,

  // Reducers
  merge,
  collect,
  first,
  vote,

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
type FlowSpec = SeqSpec | ParSpec | LoopSpec | InvokeSpec | RaceSpec | SuperviseSpec | GateSpec
interface InputSpec { ... }
interface JoinSpec { ... }
interface UntilSpec { ... }

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
