# Agent Foundry

A powerful AI agent framework with a **three-axis orthogonal architecture** for building intelligent, controllable, and context-aware agents.

## Architecture Overview

Agent Foundry is built on three orthogonal axes:

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Foundry                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────┐    ┌──────────┐    ┌─────────────────┐       │
│   │  Tools  │    │ Policies │    │ Context Sources │       │
│   └────┬────┘    └────┬─────┘    └────────┬────────┘       │
│        │              │                    │                │
│   Operations     Access Control      Information            │
│   agents can     (Guard→Mutate→     providers for           │
│   execute        Observe)           agents                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

- **Tools**: Operations that agents can execute (file I/O, shell, HTTP, etc.)
- **Policies**: Rules controlling what operations are allowed (three-phase pipeline)
- **Context Sources**: Read-only information providers (`ctx.get()` API)

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Tools](#cli-tools)
- [Configuration](#configuration)
- [Tools](#tools)
- [Policies](#policies)
- [Context Sources](#context-sources)
- [Packs](#packs)
- [MCP Integration](#mcp-integration)
- [Multi-Agent Teams](#multi-agent-teams)
- [API Reference](#api-reference)
- [Advanced Usage](#advanced-usage)

## Installation

```bash
npm install agent-foundry
```

Or use directly with npx:

```bash
npx agent-foundry <command>
```

## Quick Start

### Option 1: CLI Setup (Recommended)

```bash
# Interactive setup with intelligent recommendations
npx agent-foundry init --api-key sk-xxx

# This generates:
# - agent.yaml (configuration)
# - .env.example (environment variables template)
```

Then use in your code:

```typescript
import { createAgent } from 'agent-foundry'

// Automatically loads agent.yaml
const agent = createAgent({
  apiKey: process.env.OPENAI_API_KEY,
  onStream: (text) => process.stdout.write(text)
})

const result = await agent.run('What files are in this project?')
console.log(result.output)

await agent.destroy()
```

### Option 2: Programmatic Setup

```typescript
import { createAgent, packs } from 'agent-foundry'

const agent = createAgent({
  apiKey: process.env.OPENAI_API_KEY,
  packs: [
    packs.standard(),      // Core tools + repo + git
    packs.kvMemory(),      // Key-value memory
    packs.docs(),          // Document library
    packs.discovery()      // Context discovery
  ],
  identity: 'You are a helpful coding assistant.',
  constraints: ['Always explain your reasoning'],
  onStream: (text) => process.stdout.write(text)
})

const result = await agent.run('Analyze the codebase structure')
await agent.destroy()
```

## CLI Tools

### init - Interactive Setup

```bash
npx agent-foundry init [--api-key <key>]
```

Creates `agent.yaml` through an interactive wizard:
1. Describe your agent in natural language
2. Review recommended packs and MCP servers
3. Refine through conversation
4. Generate configuration files

### validate - Check Configuration

```bash
npx agent-foundry validate
```

Validates `agent.yaml` for:
- Required fields
- Valid pack names
- Configuration syntax

### index-docs - Build Document Index

```bash
npx agent-foundry index-docs [options]
```

Build a searchable document index for the `docs.*` context sources:

```bash
# Index docs directory
npx agent-foundry index-docs --paths docs -v

# Multiple directories
npx agent-foundry index-docs --paths docs,wiki,notes

# Markdown only
npx agent-foundry index-docs --ext .md

# Incremental update
npx agent-foundry index-docs --incremental
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--paths, -p` | `./docs` | Directories to scan |
| `--ext, -e` | `.md,.txt` | File extensions |
| `--exclude, -x` | - | Exclude patterns |
| `--chunk-size` | `500` | Tokens per chunk |
| `--overlap` | `50` | Chunk overlap tokens |
| `--output, -o` | `.agent-foundry` | Output directory |
| `--incremental, -i` | - | Incremental mode |
| `--verbose, -v` | - | Verbose output |

## Configuration

### agent.yaml

```yaml
# Required: Unique identifier
id: my-agent

# Optional: Display name
name: My Coding Assistant

# Optional: Agent identity/persona
identity: |
  You are a helpful coding assistant specializing in TypeScript.
  You write clean, well-documented code.

# Optional: Behavioral constraints
constraints:
  - Always explain your reasoning
  - Ask for clarification when uncertain
  - Never modify files without explicit permission

# Packs to load (string or object with options)
packs:
  - safe
  - repo
  - kv-memory
  - docs
  - discovery
  - name: exec
    options:
      allowedCommands: [npm, git, ls]
  - name: network
    options:
      allowedDomains: [api.github.com]

# MCP server configurations
mcp:
  - name: github
    package: "@modelcontextprotocol/server-github"
    transport:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      - GITHUB_TOKEN

# Model configuration
model:
  default: gpt-4o
  maxTokens: 16384
  temperature: 0.7

# Maximum execution steps
maxSteps: 30

# Custom configuration
custom:
  myOption: value
```

### Configuration Priority

Settings are merged in this order (later overrides earlier):

1. Default values
2. `agent.yaml` file
3. Function parameters

```typescript
// Uses agent.yaml
const agent1 = createAgent({ apiKey: 'sk-xxx' })

// Override model from agent.yaml
const agent2 = createAgent({
  apiKey: 'sk-xxx',
  model: 'gpt-4-turbo'
})

// Skip agent.yaml entirely
const agent3 = createAgent({
  apiKey: 'sk-xxx',
  skipConfigFile: true,
  packs: [packs.safe()]
})
```

## Tools

Tools are operations that agents can execute.

### Built-in Tools

| Tool | Pack | Description |
|------|------|-------------|
| `read` | safe | Read file content |
| `write` | safe | Write file content |
| `edit` | safe | Edit file (old_string → new_string) |
| `glob` | safe | Match files with patterns |
| `grep` | safe | Search content in files |
| `ctx-get` | safe | Get context from sources |
| `bash` | exec | Execute shell commands |
| `fetch` | network | HTTP requests |
| `llm-call` | compute | LLM sub-calls |
| `memory-set` | kv-memory | Store key-value data |
| `memory-delete` | kv-memory | Delete stored data |
| `fact-remember` | session-memory | Store facts/decisions |
| `fact-forget` | session-memory | Remove facts/decisions |

### Define Custom Tools

```typescript
import { defineTool } from 'agent-foundry'

const weatherTool = defineTool({
  name: 'get-weather',
  description: 'Get current weather for a city',
  parameters: {
    city: {
      type: 'string',
      required: true,
      description: 'City name'
    },
    units: {
      type: 'string',
      required: false,
      default: 'celsius',
      enum: ['celsius', 'fahrenheit']
    }
  },
  execute: async (input, context) => {
    const { city, units } = input
    // Fetch weather data...
    return {
      success: true,
      data: { temperature: 22, condition: 'sunny' }
    }
  }
})
```

### Using Tools in Agents

```typescript
import { createAgent, definePack } from 'agent-foundry'

const myPack = definePack({
  id: 'my-tools',
  description: 'My custom tools',
  tools: [weatherTool]
})

const agent = createAgent({
  apiKey: 'sk-xxx',
  packs: [packs.safe(), myPack]
})
```

## Policies

Policies control what operations are allowed through a three-phase pipeline:

```
Guard Phase → Mutate Phase → Execute Tool → Observe Phase
```

### Guard Policies (Allow/Deny/Approval)

```typescript
import { defineGuardPolicy } from 'agent-foundry'

// Block dangerous commands
const noDestructive = defineGuardPolicy({
  id: 'no-destructive',
  description: 'Block destructive commands',
  priority: 10,  // Lower = higher priority
  match: (ctx) => ctx.tool === 'bash',
  decide: (ctx) => {
    const cmd = ctx.input.command
    if (cmd.includes('rm -rf') || cmd.includes('DROP TABLE')) {
      return { action: 'deny', reason: 'Destructive command blocked' }
    }
    if (cmd.includes('sudo')) {
      return { action: 'require_approval', reason: 'Sudo requires approval' }
    }
    return { action: 'allow' }
  }
})
```

### Mutate Policies (Transform Input)

```typescript
import { defineMutatePolicy } from 'agent-foundry'

// Auto-add limits to grep
const autoLimit = defineMutatePolicy({
  id: 'auto-limit-grep',
  description: 'Add default limit to grep',
  match: (ctx) => ctx.tool === 'grep',
  transforms: (ctx) => {
    if (!ctx.input.limit) {
      return [{ op: 'set', path: 'limit', value: 100 }]
    }
    return []
  }
})
```

### Observe Policies (Logging/Alerts)

```typescript
import { defineObservePolicy } from 'agent-foundry'

// Audit all tool calls
const audit = defineObservePolicy({
  id: 'audit-all',
  description: 'Log all tool calls',
  match: () => true,
  observe: (ctx) => ({
    record: {
      timestamp: Date.now(),
      tool: ctx.tool,
      input: ctx.input,
      agentId: ctx.agentId
    }
  })
})
```

### Built-in Policies

| Policy | Type | Description |
|--------|------|-------------|
| `noDestructive` | Guard | Block rm -rf, DROP TABLE, etc. |
| `noSecretFilesRead` | Guard | Block reading .env, credentials |
| `noSecretFilesWrite` | Guard | Block writing to secret files |
| `autoLimitGrep` | Mutate | Add default limit to grep |
| `autoLimitGlob` | Mutate | Add ignore patterns to glob |
| `normalizeReadPaths` | Mutate | Normalize file paths |
| `auditAllCalls` | Observe | Log all tool calls |

## Context Sources

Context sources provide read-only information to agents via `ctx.get()`.

### Namespace Overview

| Namespace | Purpose | Sources |
|-----------|---------|---------|
| `repo.*` | Repository context | repo.index, repo.search, repo.symbols, repo.file, repo.git |
| `session.*` | Conversation history | session.recent, session.search, session.thread |
| `memory.*` | Key-value storage | memory.get, memory.search, memory.list |
| `facts.*` | Long-term facts | facts.list |
| `decisions.*` | Decision tracking | decisions.list |
| `docs.*` | Document library | docs.index, docs.search, docs.open |
| `ctx.*` | Discovery/routing | ctx.catalog, ctx.describe, ctx.route |

### Context Source Kinds

| Kind | Purpose | Example |
|------|---------|---------|
| `index` | Overview/listing | docs.index, repo.index |
| `search` | Find by query | docs.search, repo.search |
| `open` | Read content | docs.open, repo.file |
| `get` | Exact lookup | memory.get, ctx.describe |

### Using Context Sources

Agents use the `ctx-get` tool to access context:

```typescript
// In agent prompts or tool calls:
ctx.get("docs.index")
ctx.get("docs.search", { query: "authentication" })
ctx.get("docs.open", { path: "docs/guide.md" })
ctx.get("repo.search", { query: "handleLogin", fileTypes: ["ts"] })
ctx.get("session.recent", { turns: 10 })
ctx.get("memory.get", { namespace: "user", key: "preferences" })
ctx.get("ctx.route", { intent: "search", query: "API endpoints" })
```

### Repository Context (repo.*)

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
ctx.get("repo.git")
```

### Document Library (docs.*)

First, build the index:

```bash
npx agent-foundry index-docs --paths docs -v
```

Then use in your agent:

```typescript
// List documents
ctx.get("docs.index")
ctx.get("docs.index", { type: "markdown", sortBy: "modified" })

// Search documents
ctx.get("docs.search", { query: "API authentication" })

// Read document content
ctx.get("docs.open", { path: "docs/guide.md" })
ctx.get("docs.open", { path: "docs/guide.md", startLine: 100 })
ctx.get("docs.open", { path: "docs/api.md", includeOutline: true })
```

### Session & Memory (session.*, memory.*, facts.*, decisions.*)

```typescript
// Recent conversation
ctx.get("session.recent", { turns: 10 })

// Search conversation history
ctx.get("session.search", { query: "database design", k: 5 })

// Key-value memory
ctx.get("memory.get", { namespace: "user", key: "preferences" })
ctx.get("memory.list", { namespace: "user" })

// Long-term facts
ctx.get("facts.list", { topics: ["preference"], confidence: "confirmed" })

// Decisions
ctx.get("decisions.list", { status: "active" })
```

### Discovery & Routing (ctx.*)

```typescript
// List all available context sources
ctx.get("ctx.catalog")
ctx.get("ctx.catalog", { namespace: "docs" })

// Get detailed documentation for a source
ctx.get("ctx.describe", { id: "docs.search" })

// Get routing recommendations based on intent
ctx.get("ctx.route", { intent: "search", query: "authentication" })
ctx.get("ctx.route", { intent: "browse", namespace: "docs" })
ctx.get("ctx.route", { intent: "auto", query: "find all API endpoints" })
```

**Route Intents:**

| Intent | Purpose |
|--------|---------|
| `search` | Find by query |
| `browse` | Get overview/index |
| `read` | Read specific content |
| `lookup` | Exact key lookup |
| `explore` | Understand structure |
| `remember` | Store information |
| `recall` | Retrieve stored info |
| `auto` | Auto-detect from query |

### Define Custom Context Sources

```typescript
import { defineContextSource } from 'agent-foundry'

const projectInfo = defineContextSource({
  id: 'project.info',
  kind: 'get',
  description: 'Get project information',
  shortDescription: 'Project info',
  resourceTypes: ['project'],
  params: [],
  examples: [
    { description: 'Get info', params: {}, resultSummary: 'Project metadata' }
  ],
  costTier: 'cheap',
  cache: { ttlMs: 60000 },
  render: { maxTokens: 500, truncateStrategy: 'tail' },

  fetch: async (params, runtime) => {
    const pkg = await readPackageJson(runtime.projectPath)
    return {
      data: { name: pkg.name, version: pkg.version },
      rendered: `# Project: ${pkg.name}\nVersion: ${pkg.version}`,
      provenance: { operations: [], durationMs: 10 },
      coverage: { complete: true }
    }
  }
})
```

## Packs

Packs bundle tools, policies, context sources, and prompt fragments.

### Available Packs

#### Core Packs

| Pack | Risk | Contents |
|------|------|----------|
| `safe()` | Safe | read, write, edit, glob, grep, ctx-get |
| `exec()` | High | bash |
| `network()` | Elevated | fetch |
| `compute()` | Elevated | llm-call, llm-expand, llm-filter |

#### Domain Packs

| Pack | Risk | Contents |
|------|------|----------|
| `repo()` | Safe | Repository context sources |
| `git()` | Elevated | Git operations |
| `exploration()` | Safe | Code exploration guidelines |
| `python()` | Elevated | Python execution |
| `browserPack()` | Elevated | Browser automation |

#### Memory & Context Packs

| Pack | Risk | Contents |
|------|------|----------|
| `kvMemory()` | Safe | memory.get/search/list + memory-set/delete tools |
| `sessionMemory()` | Safe | session.* + facts.* + decisions.* + fact tools |
| `docs()` | Safe | docs.index/search/open (requires index-docs) |
| `discovery()` | Safe | ctx.catalog/describe/route |

#### Composite Packs

| Pack | Contents |
|------|----------|
| `minimal()` | safe |
| `standard()` | safe + execDev + repo + git + exploration |
| `full()` | safe + exec + network + compute + repo + git + exploration |
| `strict()` | safe only |

### Using Packs

```typescript
import { createAgent, packs } from 'agent-foundry'

const agent = createAgent({
  apiKey: 'sk-xxx',
  packs: [
    packs.standard(),
    packs.kvMemory(),
    packs.docs(),
    packs.discovery()
  ]
})
```

### Pack Options

```typescript
// Exec with command restrictions
packs.exec({ allowedCommands: ['git', 'npm', 'ls'] })

// Network with domain whitelist
packs.network({ allowedDomains: ['api.github.com', 'api.openai.com'] })

// Compute with token limits
packs.compute({ maxTokensPerCall: 4000, maxCallsPerSession: 10 })
```

### Define Custom Packs

```typescript
import { definePack } from 'agent-foundry'

const myPack = definePack({
  id: 'my-pack',
  description: 'My custom pack',
  tools: [myTool1, myTool2],
  policies: [myPolicy],
  contextSources: [myContextSource],
  promptFragment: `
## My Pack Usage
Use myTool1 for X, myTool2 for Y.
  `,
  onInit: async (runtime) => {
    // Initialize resources
  },
  onDestroy: async (runtime) => {
    // Cleanup resources
  }
})
```

## MCP Integration

MCP (Model Context Protocol) lets you connect to external tool servers.

### STDIO Transport (Local)

```typescript
import { createStdioMCPProvider, createAgent } from 'agent-foundry'

const githubMCP = createStdioMCPProvider({
  id: 'github',
  name: 'GitHub',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  toolPrefix: 'gh'
})

const agent = createAgent({
  apiKey: 'sk-xxx',
  providers: [githubMCP]
})
```

### HTTP Transport (Remote)

```typescript
import { createHttpMCPProvider } from 'agent-foundry'

const remoteMCP = createHttpMCPProvider({
  id: 'my-service',
  name: 'My Service',
  url: 'https://mcp.example.com',
  headers: { 'Authorization': `Bearer ${process.env.API_TOKEN}` },
  toolPrefix: 'svc'
})
```

### Configuration in agent.yaml

```yaml
mcp:
  - name: github
    package: "@modelcontextprotocol/server-github"
    transport:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      - GITHUB_TOKEN

  - name: postgres
    package: "@modelcontextprotocol/server-postgres"
    transport:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-postgres"]
    env:
      - POSTGRES_CONNECTION_STRING
```

### Popular MCP Servers

| Package | Description |
|---------|-------------|
| `@modelcontextprotocol/server-filesystem` | File operations |
| `@modelcontextprotocol/server-github` | GitHub API |
| `@modelcontextprotocol/server-postgres` | PostgreSQL |
| `@modelcontextprotocol/server-sqlite` | SQLite |
| `@modelcontextprotocol/server-slack` | Slack |
| `@modelcontextprotocol/server-puppeteer` | Browser automation |
| `@modelcontextprotocol/server-brave-search` | Web search |

## Multi-Agent Teams

Agent Foundry supports multi-agent collaboration through the Team module. Define teams of agents that work together using flow-based orchestration patterns.

### Quick Example

```typescript
import {
  defineTeam, agentHandle,
  seq, par, invoke, input,
  createTeamRuntime, createPassthroughInvoker
} from 'agent-foundry/team'

// Define a research and writing team
const team = defineTeam({
  id: 'research-writing-team',
  agents: {
    researcher: agentHandle('researcher', researcherAgent),
    writer: agentHandle('writer', writerAgent),
    editor: agentHandle('editor', editorAgent)
  },
  flow: seq(
    invoke('researcher', input.initial()),  // Research the topic
    invoke('writer', input.prev()),          // Write based on research
    invoke('editor', input.prev())           // Edit the draft
  )
})

// Create runtime and execute
const runtime = createTeamRuntime({
  team,
  agentInvoker: createPassthroughInvoker()
})

const result = await runtime.run({ topic: 'AI Safety' })
console.log(result.output)
```

### Flow Combinators

| Combinator | Description |
|------------|-------------|
| `seq(...steps)` | Execute steps sequentially |
| `par(...branches)` | Execute branches in parallel |
| `loop(body, until, opts)` | Repeat until condition met |
| `invoke(agent, input)` | Invoke an agent |
| `race(...contenders)` | First successful result wins |
| `supervise(supervisor, workers)` | Supervisor coordinates workers |
| `gate(validator, flow)` | Conditional execution |

### Input Selectors

```typescript
input.initial()           // Initial input to the team
input.prev()              // Output from previous step
input.state('path.to.key') // Value from shared state
input.literal({ value })   // Literal value
input.merge(['a', 'b'])    // Merge multiple paths
```

### Built-in Protocol Templates

Pre-built patterns for common multi-agent workflows:

| Protocol | Description |
|----------|-------------|
| `pipeline` | Sequential processing stages |
| `fanOutFanIn` | Parallel workers with merge |
| `supervisorProtocol` | Manager coordinating workers |
| `criticRefineLoop` | Iterative refinement with critic |
| `debate` | Multiple debaters + judge |
| `voting` | Parallel voters with vote aggregation |
| `raceProtocol` | First successful result wins |
| `gatedPipeline` | Pipeline with validation gates |

```typescript
import { pipeline, createProtocolRegistry } from 'agent-foundry/team'

// Use protocol template
const flow = pipeline.build({
  agents: { stages: ['analyzer', 'transformer', 'validator'] }
})

// Or use registry
const registry = createProtocolRegistry()
const debateFlow = registry.build('debate', {
  agents: {
    debaters: ['proponent', 'opponent'],
    judge: 'arbiter'
  }
})
```

### Channels for Agent Communication

Agents can communicate through pub/sub and request/response channels:

```typescript
import { createChannelHub } from 'agent-foundry/team'

const hub = createChannelHub({ retentionMs: 60000 })

// Pub/Sub
hub.subscribe('updates.*', (msg) => console.log(msg))
hub.publish('updates.status', { progress: 50 })

// Request/Response
hub.subscribe('questions', async (msg, reply) => {
  reply({ answer: 'Yes' })
})
const response = await hub.request('questions', { q: 'Ready?' })
```

### Agent Handoff

Agents can hand off control to other agents:

```typescript
import { createHandoff, executeHandoffChain } from 'agent-foundry/team'

// Agent creates a handoff
const handoff = createHandoff('specialist-agent', {
  data: { context: 'Need expert help' },
  reason: 'Complex technical question'
})

// Execute handoff chain
const result = await executeHandoffChain(
  'initial-agent',
  { question: 'How to...' },
  invoker,
  { maxHandoffs: 5, trackHistory: true }
)
```

For comprehensive documentation, see [Team API Reference](docs/TEAM.md).

## API Reference

### createAgent(config)

Create an agent instance.

```typescript
const agent = createAgent({
  // Required
  apiKey: string,

  // Model
  model?: string,              // e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022'

  // Capabilities
  packs?: Pack[],              // Packs to load
  providers?: MCPProvider[],   // MCP providers

  // Limits
  maxSteps?: number,           // Max execution steps (default: 30)
  maxTokens?: number,          // Max tokens (default: 100000)

  // Identity
  identity?: string,           // Agent persona
  constraints?: string[],      // Behavioral constraints

  // Paths
  projectPath?: string,        // Working directory
  configDir?: string,          // Config file directory
  skipConfigFile?: boolean,    // Skip agent.yaml

  // Callbacks
  onStream?: (text: string) => void,
  onToolCall?: (tool: string, input: unknown) => void,
  onToolResult?: (tool: string, result: unknown) => void,
  onApprovalRequired?: (message: string) => Promise<boolean>,

  // Additional
  policies?: Policy[],         // Extra policies
})
```

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

### defineAgent(definition)

Create an agent factory with predefined configuration.

```typescript
const myAgentFactory = defineAgent({
  id: 'my-agent',
  name: 'My Agent',
  identity: 'You are a helpful assistant.',
  constraints: ['Be concise'],
  packs: [packs.standard()],
  model: { default: 'gpt-4o', maxTokens: 100000 },
  maxSteps: 50
})

const agent = myAgentFactory({ apiKey: 'sk-xxx' })
```

## Advanced Usage

### Different LLM Providers

```typescript
// OpenAI GPT-4 (Chat Completions API)
const gpt4Agent = createAgent({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o'
})

// OpenAI GPT-5 (Responses API - requires strict schemas)
const gpt5Agent = createAgent({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-5.2'
})

// Anthropic (API key starts with 'sk-ant-')
const anthropicAgent = createAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-3-5-sonnet-20241022'
})
```

> **Note**: GPT-5.x and o-series models use OpenAI's Responses API which requires strict JSON schemas.
> Agent Foundry handles this automatically through schema coercion. See [Schema Coercion](docs/SCHEMA-COERCION.md) for details.

### Custom Approval Handler

```typescript
const agent = createAgent({
  apiKey: 'sk-xxx',
  onApprovalRequired: async (message, timeout) => {
    console.log(`Approval needed: ${message}`)
    const answer = await promptUser('Approve? (y/n)')
    return answer === 'y'
  }
})
```

### Event Handling

```typescript
import { EventBus } from 'agent-foundry'

const eventBus = new EventBus()

eventBus.on('file:write', (data) => {
  console.log(`File written: ${data.path}`)
})

eventBus.on('policy:deny', (data) => {
  console.log(`Denied: ${data.reason}`)
})

eventBus.on('tool:call', (data) => {
  console.log(`Tool called: ${data.tool}`)
})
```

### Context Manager Direct Access

```typescript
import { ContextManager } from 'agent-foundry'

const manager = new ContextManager()
manager.register(myContextSource)

const result = await manager.get('my-source', { key: 'value' })
console.log(result.rendered)
```

### Tool Registry Direct Access

```typescript
import { ToolRegistry } from 'agent-foundry'

const registry = new ToolRegistry()
registry.register(myTool)

const result = await registry.call('my-tool', { input: 'value' }, context)
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run dev

# Lint
npm run lint
```

## Documentation

- [API Reference](docs/API.md) - Complete API documentation
- [CLI Reference](docs/CLI.md) - CLI commands and options
- [MCP Guide](docs/MCP-GUIDE.md) - MCP integration guide
- [Providers](docs/PROVIDERS.md) - Provider plugin system
- [Multi-Agent Teams](docs/TEAM.md) - Multi-agent collaboration system
- [Schema Coercion](docs/SCHEMA-COERCION.md) - OpenAI Responses API compatibility

## License

MIT
