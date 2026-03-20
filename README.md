# Research Copilot

An AI-powered research assistant desktop application. Literature search, data analysis, academic writing — powered by [pi-mono](https://github.com/badlogic/pi-mono).

## Status

**Active development** on the `next-step` branch.

> **Looking for AgentFoundry?** The original agent framework has been archived to [`archive/agentfoundry/`](archive/agentfoundry/). It is no longer maintained. See the [migration rationale](#why-the-migration) below.

## Features

- Literature search across Semantic Scholar, arXiv, DBLP
- Python-based data analysis with visualization
- Academic writing assistance with citation management
- Artifact management (notes, papers, data, web content)
- @-mention system for inline entity references
- Session continuity with automatic compaction (via pi-mono)
- Electron desktop app with three-panel React UI

## Project Structure

```
app/                  # Electron desktop application
├── src/main/         # Main process (IPC, lifecycle)
├── src/preload/      # Context bridge (renderer <-> main)
└── src/renderer/     # React UI (Zustand stores, components)

lib/                  # Research agent logic
├── agents/           # Coordinator agent
├── commands/         # Artifact CRUD, search, enrichment
├── mentions/         # @-mention parsing and resolution
├── memory-v2/        # Artifact storage and session summaries
├── skills/           # Research skills (academic-writing, literature, data-analysis)
├── tools/            # Custom research tools
└── types.ts          # Shared type definitions

shared-electron/      # Shared Electron IPC utilities
shared-ui/            # Shared React components and stores
```

## Development

```bash
cd app
npm install
npx electron-vite dev    # Development mode
npx electron-vite build  # Production build
```

## Why the Migration

AgentFoundry was an elegant agent framework with strong architectural patterns (three-axis orthogonal design, policy pipelines, team flow combinators). However, building a production research assistant requires battle-tested runtime capabilities:

- **Automatic context compaction** — pi-mono handles context window overflow with split-turn-aware summarization
- **Session persistence** — append-only JSONL with tree-based branching
- **20+ LLM providers** — unified API with lazy loading and OAuth support
- **Fuzzy edit matching** — resilient to LLM formatting differences
- **File mutation queue** — prevents write conflicts during parallel tool execution
- **Extension system** — runtime-extensible via event hooks

The framework layer was rebuilt on pi-mono. The application layer (UI, artifacts, mentions, skills) carries forward.

## License

MIT
