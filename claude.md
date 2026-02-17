always reply to me staring with "Hey, Captain!"

设计公理： 系统不追求复杂架构保证质量，而追求最小纪律保证不死 + 证据驱动逐步变强

# AgentFoundry Development Guide

> **Building an app on AgentFoundry?** Read `docs/AGENT_DEV_GUIDE.md` FIRST.
> It prevents over-engineering by showing what the framework already provides.

## Project Overview

AgentFoundry is an AI agent framework implementing a **three-axis orthogonal architecture**:

- **Tools**: Operations agents can execute
- **Policies**: Rules determining if operations are allowed (Guard → Mutate → Observe pipeline)
- **Context Sources**: Information providers for agents

## Project Structure

```
src/
├── agent/           # Agent creation (createAgent, defineAgent, AgentLoop)
├── core/            # Runtime components (ToolRegistry, PolicyEngine, ContextManager, EventBus, etc.)
├── factories/       # Definition factories (defineTool, definePolicy, definePack, etc.)
├── types/           # TypeScript type definitions
├── packs/           # Pre-built capability packs (safe, exec, network, compute, repo, git, etc.)
├── tools/           # Built-in tools (read, write, edit, bash, glob, grep, fetch, etc.)
├── policies/        # Built-in policies (no-secret-files, normalize-paths, auto-limit, audit)
├── context-sources/ # Built-in context sources (repo-index, repo-search, session-history)
├── skills/          # Skills system (lazy-loaded procedural knowledge)
│   ├── define-skill.ts   # Skill factory functions
│   ├── skill-manager.ts  # Lifecycle and loading management
│   ├── skill-registry.ts # Discovery and querying
│   └── builtin/          # Built-in skills (llm-compute, git-workflow, context-retrieval)
├── llm/             # LLM integration (Vercel AI SDK)
├── mcp/             # Model Context Protocol support
├── cli/             # CLI commands (validate, index-docs)
├── config/          # agent.yaml loading and validation
├── team/            # Multi-agent team system
│   ├── flow/        # Flow combinators, executor, AST, reducers, handoff
│   ├── state/       # Blackboard shared state
│   ├── channels/    # Pub/sub and request/response channels
│   ├── protocols/   # Built-in protocol templates
│   ├── define-team.ts    # Team definition
│   ├── team-runtime.ts   # Team execution runtime
│   ├── agent-bridge.ts   # Connect with Agent framework
│   └── index.ts     # Team module exports
└── index.ts         # Main exports
tests/
├── core/            # Core component tests
├── team/            # Team module tests
docs/
├── API.md           # API documentation
├── CLI.md           # CLI documentation
├── PROVIDERS.md     # Provider plugin system
├── MCP-GUIDE.md     # MCP integration guide
├── TEAM.md          # Multi-agent team documentation
├── SKILLS.md        # Skills system documentation
└── AGENT_DEV_GUIDE.md  # **READ THIS when building apps on AgentFoundry**
examples/
├── literature-agent/      # Multi-agent literature search
├── personal-assistant/    # Electron desktop assistant (memory, scheduler, notifications)
│   ├── src/agent/         # Agent layer (coordinator, tools, commands, mentions, scheduler, types)
│   ├── src/skills/        # App-specific skills (gmail-skill, calendar-skill)
│   ├── src/main/          # Electron main process (IPC, lifecycle)
│   ├── src/preload/       # Context bridge (renderer ↔ main)
│   ├── src/renderer/      # React UI (three-panel layout, Zustand stores)
│   └── docs/rfc/          # RFC-001 (desktop app), RFC-002 (memory & autonomy)
└── research-pilot/        # Research assistant (context pipeline demo)
    └── skills/            # App-specific skills (academic-writing, literature, data-analysis)
```

## Key Concepts

### Agent Creation

```typescript
// Simple creation (loads agent.yaml automatically)
const agent = createAgent({ apiKey: 'sk-xxx', projectPath: '/path' })

// Factory pattern
const myAgent = defineAgent({
  id: 'my-agent',
  packs: [packs.standard()],
  model: { default: 'gpt-4o' }
})
```

### Packs

Packs bundle Tools + Policies + Context Sources + Prompt Fragments:

| Pack | Risk | Contents |
|------|------|----------|
| `safe` | Safe | read, write, edit, glob, grep, ctx-get |
| `exec` | High | bash |
| `network` | Elevated | fetch |
| `compute` | Elevated | llm-call, llm-expand, llm-filter |
| `repo` | Safe | Repository context |
| `git` | Elevated | Git operations |

Composite packs: `minimal()`, `standard()`, `full()`, `strict()`

### Skills

Skills are **lazily-loaded procedural knowledge** that optimize token usage through progressive disclosure:

| Concept | Purpose | Loading | Example |
|---------|---------|---------|---------|
| **Tool** | Execute operations | Always loaded (schema) | `read`, `write`, `bash` |
| **Skill** | Provide guidance | Lazy/on-demand | `llm-compute-skill`, `git-workflow-skill` |
| **Pack** | Bundle capabilities | At initialization | `safe()`, `compute()`, `exec()` |

```typescript
import { defineSkill, SkillManager } from 'agent-foundry'

const mySkill = defineSkill({
  id: 'my-skill',
  name: 'My Skill',
  shortDescription: 'Brief description (<100 chars)',
  instructions: {
    summary: 'Concise overview (~100 tokens)',      // Always loaded
    procedures: 'Detailed step-by-step guide',      // Loaded on use
    examples: 'Usage examples with code',           // Loaded on use
    troubleshooting: 'Common issues and solutions'  // Loaded on use
  },
  tools: ['tool-a', 'tool-b'],  // Triggers loading when these tools are used
  loadingStrategy: 'lazy',       // 'eager' | 'lazy' | 'on-demand'
  tags: ['category1', 'category2']
})

// Skills auto-load when associated tools are used
const manager = new SkillManager()
manager.register(mySkill)
manager.onToolUsed('tool-a')  // Triggers full loading
```

Built-in skills: `llm-compute-skill`, `git-workflow-skill`, `context-retrieval-skill`

See `docs/SKILLS.md` for full documentation.

### Three-Phase Policy Pipeline

```
Guard Phase → Mutate Phase → Execute Tool → Observe Phase
```

### Multi-Agent Teams

The Team module enables multi-agent collaboration with a contract-first API:

```typescript
import { z } from 'zod'
import {
  defineTeam, agentHandle,
  seq, loop, step, state, mapInput, branch, noop,
  createTeamRuntime
} from 'agent-foundry/team'
import { defineLLMAgent } from 'agent-foundry'

// Define agents with Zod schemas
const researcher = defineLLMAgent({
  id: 'researcher',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ findings: z.string() }),
  system: 'You are a researcher.',
  buildPrompt: ({ topic }) => `Research: ${topic}`
})

// Define team with typed flow
const team = defineTeam({
  id: 'my-team',
  agents: {
    researcher: agentHandle('researcher', researcher),
    writer: agentHandle('writer', writerAgent)
  },
  flow: seq(
    step(researcher)
      .in(state.initial<{ topic: string }>())
      .out(state.path('research')),
    step(writerAgent)
      .in(state.path('research'))
      .out(state.path('article'))
  )
})
```

Key components:
- **Contract-First API**: `step()`, `state`, `mapInput()`, `branch()`, `noop`
- **Flow Combinators**: `seq`, `par`, `loop`, `map`, `choose`, `race`, `supervise`, `gate`
- **Typed State**: `state.initial<T>()`, `state.path<T>()`, `state.prev<T>()`
- **Reducers**: `merge`, `collect`, `first`, `vote`
- **Protocols**: `pipeline`, `fanOutFanIn`, `supervisorProtocol`, `criticRefineLoop`, `debate`, `voting`
- **Channels**: Pub/sub and request/response messaging
- **Handoff**: Dynamic control transfer between agents

## Development Guidelines

### After Major Feature Changes

1. **Update relevant documentation**:
   - `docs/API.md` - For API changes
   - `docs/CLI.md` - For CLI changes
   - `README.md` - For user-facing changes
   - `docs/PROVIDERS.md` - For provider changes
   - `docs/MCP-GUIDE.md` - For MCP changes
   - `docs/TEAM.md` - For multi-agent team changes
   - `docs/SKILLS.md` - For skills system changes

2. **Update type definitions** in `src/types/` if interfaces changed

3. **Update exports** in `src/index.ts` if new public APIs added

### After Major Updates

1. **Write tests** in `tests/` directory:
   ```typescript
   // tests/core/your-feature.test.ts
   import { describe, it, expect, beforeEach } from 'vitest'

   describe('YourFeature', () => {
     it('should do something', () => {
       expect(result).toBe(expected)
     })
   })
   ```

2. **Run tests**:
   ```bash
   npm test           # Watch mode
   npm run test:run   # Single run
   npm run test:coverage  # With coverage
   ```

3. **Build and verify**:
   ```bash
   npm run build
   ```

## Commands

```bash
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm test           # Run tests (watch)
npm run test:run   # Run tests once
npm run lint       # Lint code
npm run clean      # Remove dist/
```

## CLI Usage

```bash
npx agent-foundry validate              # Validate agent.yaml
npx agent-foundry index-docs --paths docs -v  # Build document index
```

## Key Files

| File | Purpose |
|------|---------|
| `src/agent/create-agent.ts` | Main agent factory |
| `src/agent/agent-loop.ts` | LLM interaction loop |
| `src/core/tool-registry.ts` | Tool registration and execution |
| `src/core/policy-engine.ts` | Three-phase policy pipeline |
| `src/core/context-manager.ts` | Context source management |
| `src/skills/define-skill.ts` | Skill factory functions (defineSkill, extendSkill, mergeSkills) |
| `src/skills/skill-manager.ts` | Skill lifecycle and lazy loading |
| `src/skills/skill-registry.ts` | Skill discovery and querying |
| `src/team/define-team.ts` | Team definition (defineTeam, agentHandle) |
| `src/team/team-runtime.ts` | Team execution runtime |
| `src/team/flow/combinators.ts` | Flow combinators (seq, par, loop, etc.) |
| `src/team/flow/executor.ts` | Flow execution engine |
| `src/team/state/blackboard.ts` | Shared state management |
| `src/team/channels/channel.ts` | Pub/sub and request/response channels |
| `src/team/protocols/templates.ts` | Built-in protocol templates |
| `src/team/agent-bridge.ts` | Connect team runtime with Agent framework |

## Adding New Components

### New Tool

```typescript
// src/tools/my-tool.ts
import { defineTool } from '../factories/define-tool.js'

export const myTool = defineTool({
  name: 'my-tool',
  description: 'What it does',
  parameters: {
    input: { type: 'string', description: 'Input param', required: true }
  },
  execute: async (input, context) => {
    return { success: true, data: result }
  }
})
```

### New Policy

```typescript
// src/policies/my-policy.ts
import { defineGuardPolicy } from '../factories/define-policy.js'

export const myPolicy = defineGuardPolicy({
  id: 'my-policy',
  match: (ctx) => ctx.tool === 'target-tool',
  decide: (ctx) => {
    if (condition) return { action: 'deny', reason: 'Not allowed' }
    return { action: 'allow' }
  }
})
```

### New Pack

```typescript
// src/packs/my-pack.ts
import { definePack } from '../factories/define-pack.js'
import { mySkill } from '../skills/my-skill.js'

export const myPack = definePack({
  id: 'my-pack',
  name: 'My Pack',
  tools: [myTool],
  policies: [myPolicy],
  skills: [mySkill],  // Skills replace promptFragment
  skillLoadingConfig: {
    lazy: ['my-skill']  // Load on first tool use
  }
})
```

### New Skill

```typescript
// src/skills/my-skill.ts (or examples/my-app/src/skills/my-skill.ts for app-specific)
import { defineSkill } from '../skills/define-skill.js'
import type { Skill } from '../types/skill.js'

export const mySkill: Skill = defineSkill({
  id: 'my-skill',
  name: 'My Skill',
  shortDescription: 'Brief description for matching (<100 chars)',

  instructions: {
    summary: `Concise overview (~100 tokens)`,
    procedures: `
## Section 1
Step-by-step instructions...

## Section 2
More detailed procedures...
    `,
    examples: `
## Example 1: Basic Usage
\`\`\`json
{ "tool": "...", "input": {...} }
\`\`\`
    `,
    troubleshooting: `
## Common Issues
### "Error message X"
- Cause: ...
- Fix: ...
    `
  },

  tools: ['associated-tool'],  // Triggers loading when this tool is used
  loadingStrategy: 'lazy',
  estimatedTokens: { summary: 80, full: 600 },
  tags: ['category1', 'category2']
})
```

## Testing Patterns

Follow existing test patterns in `tests/core/`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Component', () => {
  let instance: Component

  beforeEach(() => {
    instance = new Component()
  })

  describe('method', () => {
    it('should handle normal case', () => { })
    it('should handle edge case', () => { })
    it('should handle error case', () => { })
  })
})
```
