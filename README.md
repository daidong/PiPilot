# Research Copilot

An AI-powered research assistant desktop application. Literature search, data analysis, academic writing — powered by [pi-mono](https://github.com/badlogic/pi-mono).

## Status

**Active development.**

> **Looking for AgentFoundry?** The original agent framework has been archived to [`archive/agentfoundry/`](archive/agentfoundry/). It is no longer maintained. See the [migration rationale](#why-the-migration) below.

## Features

- **Literature search** — multi-source pipeline (Semantic Scholar, arXiv, OpenAlex, DBLP) with LLM-driven planning, review, and synthesis
- **Web search & fetch** — Brave Search API + arXiv, with rate limiting and caching
- **Document conversion** — PDF/DOCX/PPTX/XLSX → Markdown via markitdown, with PDF page-range extraction
- **Python data analysis** — LLM-generated analysis scripts with matplotlib/seaborn visualization
- **Academic writing** — drafting, rewriting, citation management
- **Artifact management** — notes, papers, data, web content with CRUD tools
- **@-mention system** — inline entity references with resolution
- **Skills system** — lazy-loaded procedural knowledge (7 builtin + workspace-discoverable)
- **Session continuity** — automatic compaction and session summaries
- **Electron desktop app** — three-panel React UI with Zustand stores

## Project Structure

```
app/                  # Electron desktop application
├── src/main/         # Main process (IPC, lifecycle)
├── src/preload/      # Context bridge (renderer <-> main)
└── src/renderer/     # React UI (Zustand stores, components)

lib/                  # Research agent logic
├── agents/           # Coordinator agent + prompt registry
├── commands/         # Artifact CRUD, search, enrichment
├── mentions/         # @-mention parsing and resolution
├── memory-v2/        # Artifact storage and session summaries
├── skills/           # Skills system (loader + 7 builtin skills)
├── tools/            # Research tools (web, literature, data, convert, artifacts)
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
