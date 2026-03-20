always reply to me staring with "Hey, Captain!"

设计公理： 系统不追求复杂架构保证质量，而追求最小纪律保证不死 + 证据驱动逐步变强

# Research Copilot Development Guide

## Project Overview

Research Copilot is an AI-powered research assistant desktop application built on:
- **pi-mono** (`@mariozechner/pi-coding-agent`) — agent runtime, LLM integration, session management
- **Electron + React + Zustand + TailwindCSS** — desktop UI
- **Custom research tools** — artifact management, literature search, data analysis

## Project Structure

```
app/                      # Electron desktop application
├── src/main/
│   ├── index.ts          # Electron app lifecycle
│   └── ipc.ts            # IPC handlers, agent setup
├── src/preload/
│   └── index.ts          # Context bridge (ElectronAPI)
└── src/renderer/
    ├── App.tsx            # Root component
    ├── stores/            # Zustand stores (chat, entity, session, ui, activity, usage)
    └── components/        # React components (layout, left, center, right)

lib/                      # Research agent logic (framework-independent)
├── agents/
│   └── coordinator.ts    # Main agent orchestrator
├── commands/             # Artifact CRUD, search, enrichment, session summaries
├── mentions/             # @-mention parsing, resolution, candidate generation
├── memory-v2/            # Artifact storage (JSONL), session summaries
├── skills/               # Research skills (SKILL.md format)
│   ├── academic-writing/ # Writing assistance
│   ├── literature/       # Literature search guidance
│   └── data-analysis/    # Python analysis guidance
├── tools/                # Custom AgentTool definitions
└── types.ts              # Shared types (Artifact, ProjectConfig, etc.)

shared-electron/          # Reusable Electron IPC utilities
shared-ui/                # Shared React components and Zustand stores

archive/                  # Archived code (read-only reference)
├── agentfoundry/         # Original AgentFoundry framework
└── examples/             # Old examples (personal-assistant, etc.)
```

## Key Patterns

### IPC Pattern
```
Renderer (React + Zustand) → IPC invoke → Preload bridge → Main process → Agent/Commands → IPC response → Zustand update → React re-render
```

### Agent Layer (pi-mono)
The coordinator in `lib/agents/coordinator.ts` creates a pi-mono Agent with:
- Built-in tools from pi-mono (read, write, edit, bash, grep, find)
- Custom research tools (artifact CRUD, literature search, data analysis)
- Skills loaded from `.pi/skills/` directory
- beforeToolCall/afterToolCall hooks for policy enforcement

### Artifact Storage
- Stored in `.research-pilot/artifacts/{notes,papers,data,web-content,tool-output}/`
- Session summaries in `.research-pilot/memory-v2/session-summaries/`
- Entity types: `'note' | 'paper' | 'data' | 'web-content' | 'tool-output'`

## Development Commands

```bash
cd app
npm install              # Install dependencies
npx electron-vite dev    # Dev mode with hot reload
npx electron-vite build  # Production build
```

## Adding New Research Tools

Define tools using pi-mono's AgentTool interface in `lib/tools/`:

```typescript
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'

export const myTool: AgentTool = {
  name: 'my-tool',
  label: 'My Tool',
  description: 'What it does',
  parameters: Type.Object({
    input: Type.String({ description: 'Input parameter' })
  }),
  execute: async (toolCallId, params, signal) => {
    return { content: 'result' }
  }
}
```

## Adding New Skills

Create a markdown file in `lib/skills/<name>/SKILL.md`:

```markdown
---
id: my-skill
name: My Skill
shortDescription: Brief description
---

Summary loaded at startup.

## Procedures
Detailed guidance loaded on demand.
```

Skills are auto-discovered by pi-mono from the `.pi/skills/` directory at runtime.
