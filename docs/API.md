# Agent Foundry API Documentation

## Table of Contents

- [Agent API](#agent-api)
- [Configuration API](#configuration-api)
- [Tool Recommendation API](#tool-recommendation-api)
- [Factory Functions](#factory-functions)
- [Context Sources](#context-sources)
- [Packs](#packs)
- [Core Components](#core-components)
- [Types](#types)
- [LLM API](#llm-api)
- [MCP API](#mcp-api)
- [Team API](#team-api)

---

## Agent API

### createAgent(config: CreateAgentOptions): Agent

Creates an agent with default settings and automatic provider detection. Automatically loads `agent.yaml` from the working directory if present.

```typescript
import { createAgent } from 'agent-foundry'

// Simple usage - loads agent.yaml if present
const agent = createAgent({
  apiKey: 'sk-...'
})

// Full programmatic configuration
const agent = createAgent({
  apiKey: 'sk-...',
  model: 'gpt-4o',
  packs: [packs.standard()],
  skipConfigFile: true  // Don't load agent.yaml
})
```

#### CreateAgentOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `apiKey` | `string` | No | LLM API key. Falls back to env vars. |
| `model` | `string` | No | Model ID. Auto-detected from API key. |
| `packs` | `Pack[]` | No | Packs to load. Default from agent.yaml or `[packs.standard()]` |
| `maxSteps` | `number` | No | Max execution steps. Default: 30 |
| `maxTokens` | `number` | No | Max tokens. Default: 100000 |
| `projectPath` | `string` | No | Working directory. Default: `process.cwd()` |
| `configDir` | `string` | No | Directory to search for agent.yaml. Default: projectPath |
| `skipConfigFile` | `boolean` | No | Skip loading agent.yaml. Default: false |
| `identity` | `string` | No | Agent identity/persona |
| `constraints` | `string[]` | No | Behavioral constraints |
| `policies` | `Policy[]` | No | Additional policies |
| `onStream` | `(text: string) => void` | No | Text streaming callback |
| `onToolCall` | `(tool: string, input: unknown) => void` | No | Tool call callback |
| `onToolResult` | `(tool: string, result: unknown) => void` | No | Tool result callback |
| `onApprovalRequired` | `(message: string, timeout?: number) => Promise<boolean>` | No | Approval handler |

#### Configuration Priority

When multiple configuration sources exist, they are merged in this order (later overrides earlier):

1. Default values
2. `agent.yaml` file (if present and `skipConfigFile` is not true)
3. Function parameters

### defineAgent(definition: AgentDefinition): (config: AgentConfig) => Agent

Creates an agent factory with predefined configuration.

```typescript
import { defineAgent } from 'agent-foundry'

const myAgentFactory = defineAgent({
  id: 'my-agent',
  name: 'My Agent',
  identity: 'You are a helpful assistant.',
  constraints: ['Be concise'],
  packs: [packs.core()]
})

const agent = myAgentFactory({ apiKey: '...' })
```

#### AgentDefinition

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier |
| `name` | `string` | Yes | Display name |
| `version` | `string` | No | Version string |
| `identity` | `string` | Yes | Agent identity prompt |
| `constraints` | `string[]` | Yes | Behavioral constraints |
| `packs` | `Pack[]` | Yes | Packs to load |
| `policies` | `Policy[]` | No | Additional policies |
| `model` | `{ default: string, maxTokens?: number }` | No | Model configuration |
| `maxSteps` | `number` | No | Max steps |

### Agent Interface

```typescript
interface Agent {
  id: string
  run(prompt: string): Promise<AgentRunResult>
  stop(): void
  destroy(): Promise<void>
}

interface AgentRunResult {
  success: boolean
  output: string
  error?: string
  steps: number
  trace: TraceEvent[]
  durationMs: number
}
```

---

## Configuration API

Functions for loading and managing `agent.yaml` configuration files.

### loadConfig(filepath: string): AgentYAMLConfig

Load a configuration file.

```typescript
import { loadConfig } from 'agent-foundry'

const config = loadConfig('./agent.yaml')
console.log(config.id, config.packs)
```

### tryLoadConfig(dir?: string): AgentYAMLConfig | null

Try to load a configuration file from a directory. Returns null if not found.

```typescript
import { tryLoadConfig } from 'agent-foundry'

const config = tryLoadConfig()  // Searches current directory
const config2 = tryLoadConfig('/path/to/project')
```

### saveConfig(config: AgentYAMLConfig, filepath?: string): void

Save a configuration to a YAML file.

```typescript
import { saveConfig } from 'agent-foundry'

saveConfig({
  id: 'my-agent',
  name: 'My Agent',
  packs: ['safe', 'compute']
}, 'agent.yaml')
```

### findConfigFile(dir?: string): string | null

Find a configuration file in a directory.

```typescript
import { findConfigFile } from 'agent-foundry'

const path = findConfigFile()  // Searches for agent.yaml, agent.yml, etc.
```

### validateConfig(config: AgentYAMLConfig): string[]

Validate a configuration. Returns array of error messages (empty if valid).

```typescript
import { validateConfig } from 'agent-foundry'

const errors = validateConfig(config)
if (errors.length > 0) {
  console.error('Invalid config:', errors)
}
```

### AgentYAMLConfig

```typescript
interface AgentYAMLConfig {
  id: string                           // Required
  name?: string
  identity?: string
  constraints?: string[]
  packs?: Array<string | PackConfigEntry>
  mcp?: MCPConfigEntry[]
  model?: {
    default?: string
    maxTokens?: number
    temperature?: number
  }
  maxSteps?: number
  custom?: Record<string, unknown>
}

interface PackConfigEntry {
  name: string
  options?: Record<string, unknown>
}

interface MCPConfigEntry {
  name: string
  package?: string
  transport: {
    type: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
  }
  env?: string[]
}
```

---

## Tool Recommendation API

Functions for recommending tools based on agent descriptions.

### createRecommender(llmClient?, config?): ToolRecommender

Create a tool recommender.

```typescript
import { createRecommender, createLLMClient } from 'agent-foundry'

// With LLM for intelligent recommendations
const llmClient = createLLMClient({
  provider: 'openai',
  model: 'gpt-4o',
  config: { apiKey: 'sk-...' }
})
const recommender = createRecommender(llmClient)

// Without LLM (keyword-based only)
const simpleRecommender = createRecommender()
```

### ToolRecommender.recommend(description: string): Promise<RecommendationResult>

Get tool recommendations based on a description.

```typescript
const result = await recommender.recommend(
  'An agent that searches GitHub repos and creates issues'
)

console.log(result.packs)       // Recommended packs
console.log(result.mcpServers)  // Recommended MCP servers
console.log(result.warnings)    // Security warnings
console.log(result.understoodRequirements)  // Parsed requirements
```

### ToolRecommender.refineWithFeedback(current, feedback): Promise<RecommendationResult>

Refine recommendations based on user feedback.

```typescript
const refined = await recommender.refineWithFeedback(
  result,
  'I also need database access'
)
```

### RecommendationResult

```typescript
interface RecommendationResult {
  packs: PackRecommendation[]
  mcpServers: MCPRecommendation[]
  requiredEnvVars: Record<string, string>
  warnings: string[]
  understoodRequirements: string[]
}

interface PackRecommendation {
  name: string
  reason: string
  confidence: number  // 0-1
  riskLevel: 'safe' | 'elevated' | 'high'
  tools: string[]
}

interface MCPRecommendation {
  name: string
  package: string
  reason: string
  confidence: number
  riskLevel: 'safe' | 'elevated' | 'high'
  envVars?: string[]
  installCommand: string
}
```

### Catalog Functions

```typescript
import {
  toolCatalog,
  packCatalog,
  mcpCatalog,
  matchToolsByKeywords,
  matchPacksByKeywords,
  matchMCPByKeywords,
  getMCPByCategory,
  getPopularMCP
} from 'agent-foundry'

// Get all tool metadata
console.log(toolCatalog)

// Search by keywords
const packs = matchPacksByKeywords('github code review')
const servers = matchMCPByKeywords('database sql')

// Get MCP servers by category
const dbServers = getMCPByCategory('database')

// Get popular servers
const popular = getPopularMCP()
```

### CLI Wizard

```typescript
import { runInitWizard } from 'agent-foundry'

// Run interactive CLI wizard
await runInitWizard()  // Without LLM
await runInitWizard('sk-xxx')  // With LLM for better recommendations
```

---

## Factory Functions

### defineTool(config): Tool

Define a custom tool.

```typescript
import { defineTool } from 'agent-foundry'

const myTool = defineTool({
  name: 'my-tool',
  description: 'Tool description for LLM',
  parameters: {
    input: { type: 'string', required: true, description: 'Input value' }
  },
  execute: async (input, context) => {
    return { success: true, data: { result: input.input } }
  }
})
```

#### Tool Parameters

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Tool name |
| `description` | `string` | Yes | Description for LLM |
| `parameters` | `Record<string, ParameterDefinition>` | Yes | Parameter definitions |
| `execute` | `(input, context) => Promise<ToolResult>` | Yes | Execution function |

#### ParameterDefinition

| Property | Type | Description |
|----------|------|-------------|
| `type` | `'string' \| 'number' \| 'boolean' \| 'array' \| 'object'` | Parameter type |
| `description` | `string` | Parameter description |
| `required` | `boolean` | Is required |
| `default` | `any` | Default value |
| `items` | `object` | Array item schema |

### defineGuardPolicy(config): Policy

Define a guard policy (allow/deny/require_approval).

```typescript
import { defineGuardPolicy } from 'agent-foundry'

const myPolicy = defineGuardPolicy({
  id: 'my-policy',
  description: 'Policy description',
  priority: 10,  // Lower = higher priority
  match: (ctx) => ctx.tool === 'bash',
  decide: (ctx) => {
    if (dangerous(ctx.input)) {
      return { action: 'deny', reason: 'Too dangerous' }
    }
    return { action: 'allow' }
  }
})
```

### defineMutatePolicy(config): Policy

Define a mutate policy (transform input).

```typescript
import { defineMutatePolicy } from 'agent-foundry'

const addLimit = defineMutatePolicy({
  id: 'add-limit',
  description: 'Add default limit',
  match: (ctx) => ctx.tool === 'grep',
  transforms: (ctx) => [
    { op: 'set', path: 'limit', value: 100 }
  ]
})
```

### defineObservePolicy(config): Policy

Define an observe policy (logging, alerts).

```typescript
import { defineObservePolicy } from 'agent-foundry'

const logAll = defineObservePolicy({
  id: 'log-all',
  description: 'Log all tool calls',
  match: () => true,
  observe: (ctx) => ({
    record: { tool: ctx.tool, input: ctx.input }
  })
})
```

### defineContextSource(config): ContextSource

Define a context source.

```typescript
import { defineContextSource } from 'agent-foundry'

const projectContext = defineContextSource({
  id: 'project-context',
  description: 'Project information',
  costTier: 'cheap',  // 'cheap' | 'normal' | 'expensive'
  cache: { ttlMs: 60000 },  // Optional caching
  fetch: async (params, runtime) => ({
    rendered: 'Project info...',
    provenance: { source: 'config' },
    coverage: { complete: true }
  })
})
```

### definePack(config): Pack

Define a pack (bundle of tools, policies, context sources).

```typescript
import { definePack } from 'agent-foundry'

const myPack = definePack({
  id: 'my-pack',
  description: 'A custom pack',
  tools: [...],
  policies: [...],
  contextSources: [...],
  onInit: async (runtime) => { /* initialize */ },
  onDestroy: async (runtime) => { /* cleanup */ }
})
```

---

### defineProvider(config): ToolProvider

Define a provider (plugin) that returns packs.

```typescript
import { defineProvider, definePack, defineTool } from 'agent-foundry'

const provider = defineProvider({
  manifest: {
    id: 'acme.weather',
    name: 'Acme Weather Tools',
    version: '1.0.0'
  },
  createPacks: () => [
    definePack({
      id: 'acme.weather.pack',
      description: 'Weather tools',
      tools: [
        defineTool({
          name: 'get_weather',
          description: 'Fetch weather by city',
          parameters: { city: { type: 'string', required: true } },
          execute: async () => ({ success: true, data: { ok: true } })
        })
      ]
    })
  ]
})
```

---

### ProviderRegistry

Load providers and collect packs.

```typescript
import { ProviderRegistry, createAgent } from 'agent-foundry'

const registry = new ProviderRegistry()
await registry.loadFromFile({ manifestPath: '/path/to/agentfoundry.provider.json' })

const packs = await registry.collectPacks()
const agent = createAgent({ packs })
```

---

## Context Sources

Context sources provide read-only access to various data sources. Use `ctx.get(sourceId, params)` to fetch data.

### Namespaces Overview

| Namespace | Purpose | Sources |
|-----------|---------|---------|
| `repo.*` | Repository/codebase context | repo.index, repo.search, repo.symbols, repo.file, repo.git |
| `session.*` | Conversation history | session.recent, session.search, session.thread, session.history |
| `memory.*` | Key-value storage | memory.get, memory.search, memory.list |
| `facts.*` | Long-term facts | facts.list |
| `decisions.*` | Decision tracking | decisions.list |
| `docs.*` | Document library | docs.index, docs.search, docs.open |
| `ctx.*` | Meta/discovery | ctx.catalog, ctx.describe, ctx.route |

### Context Source Kinds

| Kind | Purpose | Example |
|------|---------|---------|
| `index` | Overview/listing | docs.index, repo.index |
| `search` | Find by query | docs.search, repo.search |
| `open` | Read content | docs.open, repo.file |
| `get` | Exact lookup | memory.get, ctx.describe |

### repo.* - Repository Context

```typescript
// List repository structure
ctx.get("repo.index")
ctx.get("repo.index", { path: "src/", depth: 2 })

// Search code
ctx.get("repo.search", { query: "authentication", fileTypes: ["ts"] })

// Get symbols (functions, classes)
ctx.get("repo.symbols", { path: "src/core/" })

// Read file content
ctx.get("repo.file", { path: "src/index.ts" })

// Git information
ctx.get("repo.git")  // status, recent commits
```

### session.* - Session Context

```typescript
// Get recent conversation turns
ctx.get("session.recent", { turns: 10 })

// Search conversation history
ctx.get("session.search", { query: "database design", k: 5 })

// Expand context around a message
ctx.get("session.thread", { anchorMessageId: "msg_xxx", windowTurns: 5 })
```

### memory.* - Key-Value Memory

```typescript
// Get value by key
ctx.get("memory.get", { namespace: "user", key: "preferences" })

// Search memory
ctx.get("memory.search", { namespace: "user", query: "theme" })

// List keys in namespace
ctx.get("memory.list", { namespace: "user" })
```

### facts.* & decisions.* - Long-term Memory

```typescript
// List learned facts
ctx.get("facts.list")
ctx.get("facts.list", { topics: ["preference"], confidence: "confirmed" })

// List decisions
ctx.get("decisions.list")
ctx.get("decisions.list", { status: "active" })
```

### docs.* - Document Library

Requires building an index first: `agent-foundry index-docs --paths docs`

```typescript
// List indexed documents
ctx.get("docs.index")
ctx.get("docs.index", { type: "markdown", sortBy: "modified" })

// Search documents
ctx.get("docs.search", { query: "API authentication" })
ctx.get("docs.search", { query: "setup", limit: 10 })

// Read document content
ctx.get("docs.open", { path: "docs/guide.md" })
ctx.get("docs.open", { path: "docs/guide.md", startLine: 100, lineLimit: 50 })
ctx.get("docs.open", { path: "docs/api.md", chunkId: "chunk_002" })
ctx.get("docs.open", { path: "docs/guide.md", includeOutline: true })
```

### ctx.* - Discovery & Routing

```typescript
// List available context sources
ctx.get("ctx.catalog")
ctx.get("ctx.catalog", { namespace: "docs" })
ctx.get("ctx.catalog", { kind: "search" })

// Get full documentation for a source
ctx.get("ctx.describe", { id: "docs.search" })

// Get routing recommendations based on intent
ctx.get("ctx.route", { intent: "search", query: "authentication" })
ctx.get("ctx.route", { intent: "browse", namespace: "docs" })
ctx.get("ctx.route", { intent: "auto", query: "find all API endpoints" })
```

#### Route Intents

| Intent | Purpose |
|--------|---------|
| `search` | Find something by query |
| `browse` | Get an overview/index |
| `read` | Read specific content |
| `lookup` | Get specific item by key |
| `explore` | Understand structure |
| `remember` | Store information (suggests tools) |
| `recall` | Retrieve stored info |
| `auto` | Auto-detect from query |

### ContextResult Structure

All context sources return a `ContextResult`:

```typescript
interface ContextResult<T = unknown> {
  success?: boolean
  data?: T
  error?: string
  rendered: string  // Human-readable output
  provenance: {
    operations: string[]
    durationMs: number
    cached?: boolean
  }
  coverage: {
    complete: boolean
    limitations?: string[]
    suggestions?: string[]
  }
  kindEcho?: {
    source: string
    kind: ContextKind
    paramsUsed: Record<string, unknown>
  }
  next?: Array<{
    source: string
    params: Record<string, unknown>
    why: string
    confidence: number
  }>
}
```

---

## Packs

Packs bundle tools, policies, context sources, and prompt fragments.

### Available Packs

#### Core Packs

| Pack | Risk | Description |
|------|------|-------------|
| `safe()` | Safe | Core tools: read, write, edit, glob, grep, ctx-get |
| `exec()` | High | Shell execution: bash |
| `network()` | Elevated | HTTP requests: fetch |
| `compute()` | Elevated | LLM sub-calls |

#### Domain Packs

| Pack | Risk | Description |
|------|------|-------------|
| `repo()` | Safe | Repository context sources |
| `git()` | Elevated | Git operations |
| `exploration()` | Safe | Code exploration tools |
| `python()` | Elevated | Python execution |
| `browserPack()` | Elevated | Browser automation |

#### Memory Packs

| Pack | Risk | Description |
|------|------|-------------|
| `kvMemory()` | Safe | Key-value memory: memory.get, memory.search, memory.list + memory-set, memory-delete tools |
| `sessionMemory()` | Safe | Session history + facts/decisions: session.recent, session.search, session.thread, facts.list, decisions.list + fact-remember, fact-forget tools |
| `docs()` | Safe | Document library: docs.index, docs.search, docs.open |
| `discovery()` | Safe | Context discovery: ctx.catalog, ctx.describe, ctx.route |

#### Composite Packs

| Pack | Contents |
|------|----------|
| `minimal()` | safe |
| `standard()` | safe + execDev + repo + git + exploration |
| `full()` | safe + exec + network + compute + repo + git + exploration |
| `strict()` | safe only |

### Usage

```typescript
import { createAgent, packs } from 'agent-foundry'

// Use individual packs
const agent = createAgent({
  packs: [
    packs.safe(),
    packs.repo(),
    packs.kvMemory(),
    packs.docs(),
    packs.discovery()
  ]
})

// Use composite packs
const agent2 = createAgent({
  packs: [packs.standard(), packs.kvMemory(), packs.docs()]
})

// Access pack namespace
packs.safe()
packs.exec()
packs.kvMemory()
packs.sessionMemory()
packs.docs()
packs.discovery()
```

### Pack Configuration

Some packs accept options:

```typescript
// Exec pack with restrictions
packs.exec({ allowedCommands: ['git', 'npm'] })

// Network pack with domain restrictions
packs.network({ allowedDomains: ['api.github.com'] })

// Compute pack with token limits
packs.compute({ maxTokensPerCall: 4000, maxCallsPerSession: 10 })
```

---

## Core Components

### EventBus

Event system for framework events.

```typescript
import { EventBus } from 'agent-foundry'

const eventBus = new EventBus()

// Subscribe
eventBus.on('file:write', (data) => console.log(data))

// Emit
eventBus.emit('file:write', { path: '/test.txt' })

// Unsubscribe
eventBus.off('file:write', handler)

// Clear all
eventBus.clear()
```

### TraceCollector

Collect execution traces.

```typescript
import { TraceCollector } from 'agent-foundry'

const trace = new TraceCollector('session-id')

trace.record({ type: 'custom.event', data: { key: 'value' } })

const events = trace.getEvents()
trace.clear()
```

### PolicyEngine

Manage and evaluate policies.

```typescript
import { PolicyEngine } from 'agent-foundry'

const engine = new PolicyEngine({ trace, eventBus })

engine.register(myPolicy)
engine.registerAll([policy1, policy2])

const result = await engine.evaluateBefore(context)
// { allowed: boolean, reason?: string, input?: any, transforms?: Transform[] }

await engine.evaluateAfter(context)
```

### ToolRegistry

Manage tool registration and execution.

```typescript
import { ToolRegistry } from 'agent-foundry'

const registry = new ToolRegistry()

registry.register(myTool)
registry.registerAll([tool1, tool2])

const result = await registry.call('tool-name', input, context)

const schemas = registry.generateToolSchemas()
```

### ContextManager

Manage context sources and caching.

```typescript
import { ContextManager } from 'agent-foundry'

const manager = new ContextManager()

manager.register(myContextSource)

const result = await manager.get('source-id', params)
// { rendered: string, provenance: object, coverage: object }

manager.clearCache()
```

---

## Types

### Transform

Declarative input transformation.

```typescript
type Transform =
  | { op: 'set'; path: string; value: any }
  | { op: 'delete'; path: string }
  | { op: 'append'; path: string; value: any }
  | { op: 'limit'; path: string; max: number }
  | { op: 'clamp'; path: string; min?: number; max?: number }
  | { op: 'normalize_path'; path: string }
```

### PolicyContext

Context passed to policy functions.

```typescript
interface PolicyContext {
  tool: string
  operation?: string
  input: unknown
  params?: unknown
  result?: unknown
  agentId: string
  sessionId: string
  step: number
}
```

### ToolContext

Context passed to tool execute functions.

```typescript
interface ToolContext {
  runtime: Runtime
  abortSignal: AbortSignal
}
```

### Runtime

Runtime environment for tools.

```typescript
interface Runtime {
  projectPath: string
  sessionId: string
  agentId: string
  step: number
  io: RuntimeIO
  eventBus: EventBus
  trace: TraceCollector
  tokenBudget: TokenBudget
  toolRegistry: ToolRegistry
  policyEngine: PolicyEngine
  contextManager: ContextManager
  sessionState: SessionState
}
```

---

## LLM API

### createLLMClient(config): LLMClient

Create an LLM client.

```typescript
import { createLLMClient } from 'agent-foundry'

const client = createLLMClient({
  provider: 'openai',  // or 'anthropic'
  model: 'gpt-4o',
  config: { apiKey: '...' }
})
```

### streamWithCallbacks(client, options, callbacks)

Stream LLM responses with callbacks.

```typescript
import { streamWithCallbacks } from 'agent-foundry'

const response = await streamWithCallbacks(
  client,
  {
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [...],
    maxTokens: 4096
  },
  {
    onText: (text) => process.stdout.write(text),
    onToolCall: (call) => console.log(call),
    onFinish: (result) => console.log('Done', result.usage)
  }
)
```

### Supported Models

#### OpenAI
- `gpt-4o` - Latest GPT-4 Omni
- `gpt-4o-mini` - Smaller, faster GPT-4
- `gpt-4-turbo` - GPT-4 Turbo
- `gpt-4` - GPT-4
- `gpt-3.5-turbo` - GPT-3.5 Turbo
- `o1` - O1 reasoning model
- `o1-mini` - O1 mini

#### Anthropic
- `claude-3-5-sonnet-20241022` - Claude 3.5 Sonnet
- `claude-3-opus-20240229` - Claude 3 Opus
- `claude-3-sonnet-20240229` - Claude 3 Sonnet
- `claude-3-haiku-20240307` - Claude 3 Haiku

### Helper Functions

```typescript
import {
  detectProviderFromApiKey,
  supportsTools,
  supportsVision,
  supportsReasoning,
  getModel,
  getAllModels
} from 'agent-foundry'

// Detect provider from API key prefix
detectProviderFromApiKey('sk-...') // 'openai'
detectProviderFromApiKey('sk-ant-...') // 'anthropic'

// Check model capabilities
supportsTools('gpt-4o') // true
supportsVision('claude-3-opus-20240229') // true
supportsReasoning('o1') // true

// Get model info
const model = getModel('gpt-4o')
// { id, name, provider, capabilities, cost, limits, ... }
```

---

## MCP API

MCP (Model Context Protocol) allows you to connect to external tool servers. For guidance on when to use MCP vs local tools, see [MCP-GUIDE.md](./MCP-GUIDE.md).

> **Key Principle**: Use existing MCP servers for common capabilities. Write local tools (`defineTool`) for your business logic. You should never need to implement an MCP server yourself.

### createStdioMCPProvider(options): MCPProvider

Create an MCP provider that connects to a local MCP server via STDIO.

```typescript
import { createStdioMCPProvider } from 'agent-foundry'

const filesystemMCP = createStdioMCPProvider({
  id: 'filesystem',
  name: 'File System',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
  cwd: process.cwd(),  // Optional: working directory
  env: { /* environment variables */ },  // Optional
  toolPrefix: 'fs'  // Optional: prefix for tool names
})
```

#### Options

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier |
| `name` | `string` | Yes | Display name |
| `command` | `string` | Yes | Command to execute |
| `args` | `string[]` | No | Command arguments |
| `cwd` | `string` | No | Working directory |
| `env` | `Record<string, string>` | No | Environment variables |
| `toolPrefix` | `string` | No | Prefix for tool names to avoid conflicts |

### createHttpMCPProvider(options): MCPProvider

Create an MCP provider that connects to a remote MCP server via HTTP.

```typescript
import { createHttpMCPProvider } from 'agent-foundry'

const remoteMCP = createHttpMCPProvider({
  id: 'my-service',
  name: 'My Service',
  url: 'https://mcp.example.com',
  headers: {
    'Authorization': `Bearer ${process.env.API_TOKEN}`
  },
  toolPrefix: 'svc'
})
```

#### Options

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier |
| `name` | `string` | Yes | Display name |
| `url` | `string` | Yes | MCP server URL |
| `headers` | `Record<string, string>` | No | HTTP headers (e.g., auth) |
| `toolPrefix` | `string` | No | Prefix for tool names |

### createMCPProvider(config): MCPProvider

Create an MCP provider with full configuration (multiple servers).

```typescript
import { createMCPProvider } from 'agent-foundry'

const provider = createMCPProvider({
  id: 'my-mcp-provider',
  name: 'My MCP Provider',
  servers: [
    {
      id: 'github',
      name: 'GitHub',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github']
      },
      toolPrefix: 'gh'
    },
    {
      id: 'db',
      name: 'Database',
      transport: {
        type: 'http',
        url: 'https://db-mcp.internal.com'
      },
      toolPrefix: 'db'
    }
  ]
})
```

### Using MCP with Agents

```typescript
import { createAgent, createStdioMCPProvider } from 'agent-foundry'

// Create MCP providers
const githubMCP = createStdioMCPProvider({
  id: 'github',
  name: 'GitHub',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
})

// Create agent with MCP provider
const agent = createAgent({
  providers: [githubMCP],
  // ... other config
})

// MCP tools are automatically available to the agent
// Tool names are prefixed: github.create_issue, github.list_repos, etc.
```

### Common MCP Servers

| Package | Description |
|---------|-------------|
| `@modelcontextprotocol/server-filesystem` | File system operations |
| `@modelcontextprotocol/server-github` | GitHub API |
| `@modelcontextprotocol/server-postgres` | PostgreSQL database |
| `@modelcontextprotocol/server-sqlite` | SQLite database |
| `@modelcontextprotocol/server-slack` | Slack integration |
| `@modelcontextprotocol/server-puppeteer` | Browser automation |

Find more at: https://github.com/modelcontextprotocol/servers

### When to Use STDIO vs HTTP

| Use Case | Transport | Reason |
|----------|-----------|--------|
| Local file access | STDIO | Needs local filesystem |
| Data stays local | STDIO | Privacy/security |
| Hosted service | HTTP | Remote infrastructure |
| Shared across team | HTTP | Centralized server |
| No network needed | STDIO | Offline capability |

---

## Team API

The Team API provides primitives for building multi-agent collaborative workflows. For comprehensive documentation, see [TEAM.md](./TEAM.md).

### defineTeam(definition): TeamDefinition

Define a multi-agent team with agents and a flow specification.

```typescript
import { z } from 'zod'
import { defineTeam, agentHandle, seq, step, state } from 'agent-foundry/team'

const team = defineTeam({
  id: 'my-team',
  name: 'My Team',
  agents: {
    researcher: agentHandle('researcher', researcherAgent),
    writer: agentHandle('writer', writerAgent)
  },
  flow: seq(
    step(researcherAgent)
      .in(state.initial<{ topic: string }>())
      .out(state.path('research')),
    step(writerAgent)
      .in(state.path('research'))
      .out(state.path('article'))
  )
})
```

#### TeamDefinition

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | Yes | Unique team identifier |
| `name` | `string` | No | Display name |
| `description` | `string` | No | Team description |
| `agents` | `Record<string, AgentHandle>` | Yes | Agents in the team |
| `flow` | `FlowSpec` | Yes | Flow specification |
| `state` | `BlackboardConfig` | No | Shared state configuration |
| `channels` | `Record<string, ChannelConfig>` | No | Channel configurations |
| `reducers` | `ReducerSpec[]` | No | Custom reducers |
| `validators` | `ValidatorRegistration[]` | No | Custom validators |
| `defaults` | `TeamDefaults` | No | Default settings |

### agentHandle(id, agent, options?): AgentHandle

Create an agent handle for use in defineTeam.

```typescript
const handle = agentHandle('researcher', myAgent, {
  role: 'researcher',
  capabilities: ['search', 'analyze']
})
```

### createTeamRuntime(config): TeamRuntime

Create a runtime to execute team flows.

```typescript
import { createTeamRuntime, createPassthroughInvoker } from 'agent-foundry/team'

const runtime = createTeamRuntime({
  team,
  agentInvoker: createPassthroughInvoker()
})

const result = await runtime.run({ topic: 'AI' })
```

#### TeamRuntimeConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `team` | `TeamDefinition` | Yes | Team definition |
| `agentInvoker` | `AgentInvoker` | Yes | Function to invoke agents |
| `reducers` | `Map<string, Reducer>` | No | Custom reducers |
| `validators` | `Map<string, Validator>` | No | Custom validators |
| `channelHub` | `ChannelHub` | No | Channel hub for communication |

### Contract-First API

The recommended approach using type-safe Zod schemas:

```typescript
import { z } from 'zod'
import { step, state, mapInput, branch, noop } from 'agent-foundry/team'
import { defineLLMAgent } from 'agent-foundry'

// Define agent with contracts
const planner = defineLLMAgent({
  id: 'planner',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ queries: z.array(z.string()) }),
  system: 'You are a planner.',
  buildPrompt: ({ topic }) => `Plan research on: ${topic}`
})

// Use step() builder for flow
step(planner)
  .in(state.initial<{ topic: string }>())
  .name('Create plan')
  .out(state.path('plan'))

// Transform data with mapInput()
step(searcher)
  .in(mapInput(state.path('plan'), (p) => ({ queries: p.queries })))
  .out(state.path('results'))

// Conditional branching
branch({
  when: (s) => s.review?.approved === false,
  then: step(refiner).in(state.path('review')).build(),
  else: noop
})
```

### Flow Combinators

```typescript
import { seq, par, loop, race, supervise, gate, join, step, state } from 'agent-foundry/team'

// Sequential execution
seq(
  step(agent1).in(state.initial()).out(state.path('result1')),
  step(agent2).in(state.path('result1')).out(state.path('result2'))
)

// Parallel execution with join
par(
  [
    step(analyst1).in(state.initial()).build(),
    step(analyst2).in(state.initial()).build()
  ],
  join('merge')
)

// Loop with condition
loop(
  seq(
    step(critic).in(state.path('draft')).out(state.path('review')),
    step(refiner).in(state.path('review')).out(state.path('draft'))
  ),
  { type: 'field-eq', path: 'review.approved', value: true },  // Until condition
  { maxIters: 5 }
)

// Race (first success wins)
race(
  [
    step(fastModel).in(state.initial()).build(),
    step(accurateModel).in(state.initial()).build()
  ],
  { type: 'firstSuccess' }
)

// Supervisor pattern
supervise(
  step(manager).in(state.initial()).build(),
  par([step(worker1).in(state.prev()).build()], join('merge')),
  join('merge'),
  'parallel'
)

// Conditional gate
gate(
  { type: 'predicate', predicate: { op: 'eq', path: 'quality', value: true } },
  step(publisher).in(state.prev()).build(),
  step(improver).in(state.prev()).build()
)
```

### Typed State References

```typescript
import { state } from 'agent-foundry/team'

state.initial<{ topic: string }>()    // Initial team input with type
state.path<QueryPlan>('plan')         // State path with type
state.prev<SearchResults>()           // Previous output with type
state.const({ limit: 10 })            // Constant value
```

### Until Conditions

```typescript
// Stop when field equals value
{ type: 'field-eq', path: 'review.approved', value: true }

// Stop after N iterations
{ type: 'max-iterations', count: 5 }

// Stop based on predicate
{ type: 'predicate', predicate: { op: 'eq', path: 'done', value: true } }
```

### Built-in Reducers

| Reducer | Description |
|---------|-------------|
| `merge` | Deep merge objects |
| `collect` | Collect into array |
| `first` | Take first result |
| `vote` | Majority voting |

### Protocol Templates

```typescript
import { pipeline, fanOutFanIn, supervisorProtocol, createProtocolRegistry } from 'agent-foundry/team'

// Direct usage
const flow = pipeline.build({
  agents: { stages: ['a', 'b', 'c'] }
})

// Via registry
const registry = createProtocolRegistry()
const flow2 = registry.build('debate', {
  agents: { debaters: ['pro', 'con'], judge: 'arbiter' }
})
```

### Channels

```typescript
import { createChannelHub } from 'agent-foundry/team'

const hub = createChannelHub({ retentionMs: 60000 })

// Pub/Sub
const sub = hub.subscribe('topic.*', (msg) => console.log(msg))
hub.publish('topic.update', { data: 'value' })
sub.unsubscribe()

// Request/Response
hub.subscribe('rpc.endpoint', async (msg, reply) => {
  reply({ result: 'ok' })
})
const response = await hub.request('rpc.endpoint', { query: 'data' })
```

### Handoff

```typescript
import { createHandoff, parseHandoff, executeHandoffChain } from 'agent-foundry/team'

// Create handoff
const handoff = createHandoff('target-agent', {
  data: { context: 'info' },
  reason: 'Need specialist'
})

// Parse handoff from output
const parsed = parseHandoff(agentOutput)

// Execute handoff chain
const result = await executeHandoffChain(
  'start-agent',
  initialInput,
  invoker,
  { maxHandoffs: 5, trackHistory: true }
)
```

### Agent Bridge

```typescript
import {
  createAgentBridge,
  createBridgedTeamRuntime,
  createMapBasedResolver
} from 'agent-foundry/team'

// Create bridge with real agents
const { runtime, bridge } = createBridgedTeamRuntime({
  team,
  agentResolver: createMapBasedResolver({
    researcher: realResearcherAgent,
    writer: realWriterAgent
  })
})

const result = await runtime.run(input)
console.log(bridge.getInvocationCount('researcher'))
