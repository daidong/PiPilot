<p align="center">
  <strong>Agent Foundry</strong>
</p>

<p align="center">
  A TypeScript framework for building AI agents that are powerful, controllable, and context-aware.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="docs/API.md">API Reference</a> &middot;
  <a href="docs/AGENT_DEV_GUIDE.md">App Dev Guide</a> &middot;
  <a href="#examples">Examples</a>
</p>

---

## Why Agent Foundry?

Most agent frameworks give you tools and a loop. Agent Foundry gives you **architecture**.

- **Three orthogonal axes** — Tools (what agents *do*), Policies (what agents *may* do), and Context Sources (what agents *know*) compose independently, so you never have to choose between power and safety.
- **Token-efficient by design** — Skills load lazily, context assembles in priority phases, and history compresses automatically. Your agents stay sharp in long sessions.
- **Multi-provider, zero lock-in** — OpenAI, Anthropic, Google, DeepSeek, Groq, Mistral, xAI, Cerebras, Together, Fireworks, OpenRouter — switch with one line. Bring your own provider via YAML config.
- **Teams built in** — Sequential pipelines, fan-out/fan-in, supervisor patterns, debate, voting — all as composable flow combinators, not custom glue code.
- **Skill marketplace** — Install, share, and auto-load portable Markdown skills from GitHub or URL. No code changes needed.
- **MCP native** — Connect external tool servers (GitHub, Postgres, Slack, browsers) via the Model Context Protocol.

## Quick Start

```bash
npm install agent-foundry
```

### Minimal Example

```typescript
import { createAgent, packs } from 'agent-foundry'

const agent = createAgent({
  apiKey: process.env.OPENAI_API_KEY,
  packs: [packs.standard()],
  onStream: (text) => process.stdout.write(text)
})

const result = await agent.run('What files are in this project?')
await agent.destroy()
```

### With YAML Configuration

Create `agent.yaml` in your project root:

```yaml
id: my-agent
name: My Coding Assistant
model:
  default: claude-sonnet-4-20250514
packs:
  - safe
  - exec
  - repo
  - git
constraints:
  - Always explain your reasoning
  - Ask before modifying files
```

```typescript
import { createAgent } from 'agent-foundry'

// Loads agent.yaml automatically
const agent = createAgent({ apiKey: process.env.ANTHROPIC_API_KEY })
```

## Core Concepts

### Architecture

```
                        ┌─────────────────────────┐
                        │       Agent Loop         │
                        └────┬────────┬────────┬───┘
                             │        │        │
                     ┌───────▼──┐ ┌───▼────┐ ┌─▼──────────────┐
                     │  Tools   │ │Policies│ │ Context Sources │
                     │ (actions)│ │(rules) │ │  (knowledge)    │
                     └──────────┘ └────────┘ └────────────────┘
```

| Axis | Purpose | Example |
|------|---------|---------|
| **Tools** | Operations agents execute | `read`, `write`, `bash`, `fetch`, `llm-call` |
| **Policies** | Guard / Mutate / Observe pipeline | Block `rm -rf`, auto-limit grep, audit logs |
| **Context Sources** | Read-only information providers | Repo index, session history, document search |

The three axes compose independently — add a tool without touching policies, tighten a policy without changing tools.

### Packs

Packs bundle Tools + Policies + Context Sources + Skills into reusable capability sets.

| Pack | Contents | Risk |
|------|----------|------|
| `safe()` | read, write, edit, glob, grep, ctx-get | Safe |
| `exec()` | bash | High |
| `network()` | fetch | Elevated |
| `compute()` | llm-call, llm-expand, llm-filter | Elevated |
| `repo()` | Repository context sources | Safe |
| `git()` | Git operations | Elevated |
| `standard()` | safe + exec + repo + git + exploration | Composite |
| `full()` | Everything | Composite |

```typescript
const agent = createAgent({
  apiKey: 'sk-xxx',
  packs: [
    packs.standard(),
    packs.kvMemory(),
    packs.docs(),
    packs.compute({ maxTokensPerCall: 4000 })
  ]
})
```

### Skills

Skills are **lazily-loaded procedural knowledge** in portable Markdown format. They optimize token usage by loading guidance only when relevant tools are invoked.

```
skills/my-skill/SKILL.md
```

```markdown
---
id: my-skill
name: My Skill
shortDescription: What this skill provides
tools: [tool-a, tool-b]
loadingStrategy: lazy
tags: [category]
---

Concise summary loaded at startup (~100 tokens).

## Procedures
Detailed step-by-step guide (loaded on first tool use).

## Examples
Code examples and patterns.

## Troubleshooting
Common issues and fixes.
```

| Strategy | When Loaded | Use Case |
|----------|-------------|----------|
| `eager` | At registration | Critical, always-needed |
| `lazy` | On first tool use | Most skills (default) |
| `on-demand` | Explicit call | Specialized, rare |

#### Install Skills from GitHub or URL

```bash
# Install from GitHub
npx agent-foundry skill install user/repo/skills/my-skill

# Install from URL
npx agent-foundry skill install https://example.com/SKILL.md

# List installed skills
npx agent-foundry skill list

# Declare in agent.yaml (auto-installed on first run)
```

```yaml
skills:
  - github: user/repo/skills/my-skill
  - url: https://example.com/skills/SKILL.md
```

### Policies

Three-phase pipeline controlling every tool call:

```
Guard → Mutate → Execute → Observe
```

```typescript
import { defineGuardPolicy } from 'agent-foundry'

const noDestructive = defineGuardPolicy({
  id: 'no-destructive',
  match: (ctx) => ctx.tool === 'bash',
  decide: (ctx) => {
    if (ctx.input.command.includes('rm -rf'))
      return { action: 'deny', reason: 'Destructive command blocked' }
    return { action: 'allow' }
  }
})
```

### Context Sources

Read-only information providers accessible via `ctx.get()`:

| Namespace | Purpose |
|-----------|---------|
| `repo.*` | Repository structure, code search, git info |
| `session.*` | Conversation history and search |
| `memory.*` | Key-value persistent storage |
| `docs.*` | Indexed document library |
| `ctx.*` | Discovery and routing |

```typescript
ctx.get("repo.search", { query: "handleLogin", fileTypes: ["ts"] })
ctx.get("docs.search", { query: "authentication" })
ctx.get("memory.get", { namespace: "user", key: "preferences" })
```

## Multi-Provider Support

Agent Foundry supports 11+ LLM providers out of the box:

| Provider | Models | API Key Env |
|----------|--------|-------------|
| **OpenAI** | GPT-4o, GPT-5.4, o3-mini | `OPENAI_API_KEY` |
| **Anthropic** | Claude Sonnet 4, Haiku 4.5 | `ANTHROPIC_API_KEY` |
| **Google** | Gemini 2.0 Flash, Pro | `GOOGLE_API_KEY` |
| **DeepSeek** | DeepSeek Chat, R1 | `DEEPSEEK_API_KEY` |
| **Groq** | Llama 3.3 70B, 8B (ultra-fast) | `GROQ_API_KEY` |
| **Mistral** | Large, Small, Codestral | `MISTRAL_API_KEY` |
| **xAI** | Grok 3, Grok 3 Mini | `XAI_API_KEY` |
| **Cerebras** | Llama 3.3 70B | `CEREBRAS_API_KEY` |
| **Together** | Llama, Qwen, DeepSeek R1 | `TOGETHER_API_KEY` |
| **Fireworks** | Llama, Qwen | `FIREWORKS_API_KEY` |
| **OpenRouter** | Any model via gateway | `OPENROUTER_API_KEY` |

Switch providers with one line:

```typescript
createAgent({ apiKey: process.env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' })
```

Or bring your own OpenAI-compatible provider in `agent.yaml`:

```yaml
model:
  default: my-model
  provider:
    id: my-provider
    baseUrl: https://my-llm.internal/v1
    apiKeyEnv: MY_LLM_KEY
    models:
      - id: my-model
        maxContext: 128000
```

## Multi-Agent Teams

Define teams of agents that collaborate through composable flow patterns:

```typescript
import { defineTeam, agentHandle, seq, step, state, createTeamRuntime } from 'agent-foundry/team'

const team = defineTeam({
  id: 'research-team',
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

const runtime = createTeamRuntime({ team, agentInvoker })
const result = await runtime.run({ topic: 'AI Safety' })
```

### Flow Combinators

| Combinator | Description |
|------------|-------------|
| `seq(...)` | Sequential execution |
| `par(...)` | Parallel branches |
| `loop(body, until)` | Iterate until condition |
| `race(...)` | First result wins |
| `supervise(supervisor, workers)` | Coordinated delegation |
| `gate(validator, flow)` | Conditional execution |

### Built-in Protocol Templates

| Protocol | Pattern |
|----------|---------|
| `pipeline` | A &rarr; B &rarr; C |
| `fanOutFanIn` | Parallel workers, merged result |
| `criticRefineLoop` | Draft &rarr; critique &rarr; refine &rarr; repeat |
| `debate` | Debaters + judge |
| `voting` | Parallel voters + aggregation |
| `supervisorProtocol` | Manager delegates to specialists |

## MCP Integration

Connect external tool servers via the Model Context Protocol:

```yaml
# agent.yaml
mcp:
  - name: github
    package: "@modelcontextprotocol/server-github"
    transport:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      - GITHUB_TOKEN
```

```typescript
import { createStdioMCPProvider, createAgent } from 'agent-foundry'

const githubMCP = createStdioMCPProvider({
  id: 'github',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
})

const agent = createAgent({ apiKey: 'sk-xxx', providers: [githubMCP] })
```

## CLI

```bash
npx agent-foundry validate              # Validate agent.yaml
npx agent-foundry index-docs --paths docs  # Build document search index
npx agent-foundry skill list             # List installed skills
npx agent-foundry skill install <source> # Install skill from GitHub/URL
npx agent-foundry skill remove <id>      # Remove installed skill
npx agent-foundry skill info <id>        # Show skill details
```

## Examples

| Example | Description |
|---------|-------------|
| [`hello-world`](examples/hello-world) | Minimal agent setup |
| [`coding-agent`](examples/coding-agent) | Code generation and editing |
| [`research-pilot`](examples/research-pilot) | Full research assistant — literature search, data analysis, academic writing, @-mentions, context pipeline |
| [`research-pilot-desktop`](examples/research-pilot-desktop) | Electron desktop app with React UI for Research Pilot |
| [`personal-assistant`](examples/personal-assistant) | Desktop assistant with memory, scheduler, and notifications |
| [`api-server`](examples/api-server) | REST API wrapping an agent |
| [`team-demo`](examples/team-demo) | Multi-agent team orchestration |

### Research Pilot

The flagship example — a multi-agent research assistant demonstrating context pipelines, lazy skills, intent routing, and structured output:

- **Coordinator** orchestrates intent detection, skill preloading, and context assembly
- **Literature team** searches Semantic Scholar, arXiv, DBLP with relevance scoring
- **Data team** runs Python analysis with sandboxed execution
- **3 portable SKILL.md files** (academic-writing, literature, data-analysis) with 96% token savings via lazy loading
- **agent.yaml** for declarative model/skill configuration
- **@-mention system** for inline entity references
- **Session summaries** via `generateStructured` with Zod validation

## Project Structure

```
src/
├── agent/           # createAgent, defineAgent, AgentLoop
├── core/            # ToolRegistry, PolicyEngine, ContextManager, EventBus
├── factories/       # defineTool, definePolicy, definePack
├── types/           # TypeScript type definitions
├── packs/           # Pre-built capability packs
├── tools/           # Built-in tools
├── policies/        # Built-in policies
├── context-sources/ # Built-in context sources
├── skills/          # Skills system (define, manage, load, install)
├── llm/             # LLM integration (Vercel AI SDK, 11+ providers)
├── mcp/             # Model Context Protocol support
├── team/            # Multi-agent teams (flows, state, channels, protocols)
├── cli/             # CLI commands
└── config/          # YAML configuration
```

## Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm test           # Run tests (watch)
npm run test:run   # Run tests once (1616 tests)
npm run lint       # Lint code
```

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/API.md) | Complete API documentation |
| [App Dev Guide](docs/AGENT_DEV_GUIDE.md) | Guide for building apps on Agent Foundry |
| [Skills Guide](docs/SKILLS.md) | Lazy-loaded procedural knowledge system |
| [Multi-Agent Teams](docs/TEAM.md) | Team flows, protocols, and channels |
| [Providers](docs/PROVIDERS.md) | Provider plugin system and custom providers |
| [MCP Guide](docs/MCP-GUIDE.md) | MCP integration guide |
| [CLI Reference](docs/CLI.md) | CLI commands and options |
| [Schema Coercion](docs/SCHEMA-COERCION.md) | OpenAI Responses API compatibility |

## License

MIT
