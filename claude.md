always reply to me staring with "Hey, Captain!"

Design axiom: The system does not pursue complex architecture to guarantee quality. Instead, it pursues minimum discipline to guarantee survival + evidence-driven incremental improvement.

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
    ├── stores/            # Zustand stores (chat, entity, session, ui, activity, usage, progress, skill)
    └── components/        # React components (layout, left, center, right)

lib/                      # Research agent logic (framework-independent)
├── agents/
│   ├── coordinator.ts    # Main agent orchestrator
│   └── prompts/
│       └── index.ts      # Prompt registry (bundler-safe inline strings)
├── commands/             # Artifact CRUD, search, enrichment, session summaries
├── mentions/             # @-mention parsing, resolution, candidate generation
├── memory-v2/            # Artifact storage (JSONL), session summaries
├── skills/               # Skills system (SKILL.md format)
│   ├── builtin/          # 12 builtin skills (see below)
│   ├── data-analysis/    # Python analysis guidance
│   └── loader.ts         # Runtime skill discovery
├── tools/                # Research tools (pi-mono AgentTool format)
│   ├── index.ts          # createResearchTools() factory
│   ├── web-tools.ts      # web_search + web_fetch
│   ├── literature-search.ts  # Multi-source literature pipeline
│   ├── data-analyze.ts   # LLM-generated Python analysis
│   ├── convert-document.ts   # PDF/DOCX → Markdown
│   ├── entity-tools.ts   # artifact-create, artifact-update, artifact-search
│   ├── skill-tools.ts    # load_skill tool
│   ├── tool-utils.ts     # toAgentResult adapter
│   └── types.ts          # ResearchToolContext
└── types.ts              # Shared types (Artifact, ProjectConfig, etc.)

shared-electron/          # Reusable Electron IPC utilities
shared-ui/                # Shared React components and Zustand stores
```

### Builtin Skills (12)

| Category | Skills |
|----------|--------|
| Writing & Review | paper-writing, research-grants, rewrite-humanize, scholar-evaluation, scientific-writing |
| Visualization | matplotlib, seaborn, scientific-schematics, scientific-visualization |
| Research | brainstorming-research-ideas, creative-thinking-for-research |
| Development | coding |

## Key Patterns

### IPC Pattern
```
Renderer (React + Zustand) → IPC invoke → Preload bridge → Main process → Agent/Commands → IPC response → Zustand update → React re-render
```

### Agent Layer (pi-mono)
The coordinator in `lib/agents/coordinator.ts` creates a pi-mono Agent with:
- Built-in coding tools from `@mariozechner/pi-coding-agent` (read, write, edit, bash, grep, find)
- Custom research tools via `createResearchTools()` from `lib/tools/index.ts`
- Prompt registry in `lib/agents/prompts/index.ts` (10 prompts as key-value entries)
- Intent detection (rule-based + optional LLM) for dynamic skill loading
  - Intent labels: `literature`, `data`, `writing`, `critique`, `web`, `citation`, `grants`, `docx`, `general`
- beforeToolCall/afterToolCall hooks for activity tracking
- Skills discovered at runtime from builtin + user + workspace directories

### Artifact Storage
- Stored in `.research-pilot/artifacts/{notes,papers,data,web-content,tool-output}/`
- Session summaries in `.research-pilot/memory-v2/session-summaries/`
- Entity types: `'note' | 'paper' | 'data' | 'web-content' | 'tool-output'`

## Development Commands

```bash
# From root
npm install              # Install all workspace dependencies
npm run dev              # Dev mode with hot reload
npm run build            # Production build
npm run clean            # Remove build artifacts

# From app/
npm run pack             # Build + package macOS DMG
npm run icon:generate    # Regenerate app icon (Python)
```

## Adding New Research Tools

Define tools using pi-mono's AgentTool interface in `lib/tools/`, then register in `lib/tools/index.ts`:

```typescript
import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { toAgentResult } from './tool-utils.js'
import type { ResearchToolContext } from './types.js'

export function createMyTool(ctx: ResearchToolContext): AgentTool {
  return {
    name: 'my-tool',
    label: 'My Tool',
    description: 'What it does',
    parameters: Type.Object({
      input: Type.String({ description: 'Input parameter' })
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>
      // ... tool logic ...
      return toAgentResult('my-tool', { success: true, data: result })
    }
  }
}
```

Then add to `createResearchTools()` in `lib/tools/index.ts`.

## Adding New Skills

Create a markdown file in `lib/skills/builtin/<name>/SKILL.md` (or workspace `.research-pilot/skills/<name>/SKILL.md`):

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

Skills are auto-discovered from three locations (later overrides earlier):
1. `lib/skills/builtin/` — shipped with the app
2. `~/.research-pilot/skills/` — user-global
3. `<workspace>/.research-pilot/skills/` — project-specific

## Adding New Prompts

Add prompt strings to `lib/agents/prompts/index.ts` as key-value entries in the `prompts` record. Access via `loadPrompt('key-name')`.

Current prompts: `coordinator-system`, `data-analysis-system`, `data-analysis-tasks`, `data-code-template`, `literature-planner-system`, `literature-reviewer-system`, `literature-summarizer-system`, `data-analyzer-system`, `writing-outliner-system`, `writing-drafter-system`.
