# Personal Assistant

An Electron desktop app built on AgentFoundry. It now uses Memory V2 (RFC-013): `Artifact / Fact / Focus / Task Anchor` as the single memory model.

## Project Structure

```
src/
├── agent/                  # Agent layer (coordinator, tools, types)
│   ├── agents/             # Coordinator agent + system prompt
│   ├── commands/           # Canonical memory commands (artifact/focus/task-anchor/explain)
│   ├── mentions/           # @-mention parser and resolver
│   ├── memory-v2/          # App-local Memory V2 store helpers
│   ├── scheduler/          # Cron scheduler + notification store
│   ├── tools/              # Canonical tool surface
│   └── types.ts            # Shared types (artifacts, focus, task anchor, paths)
├── main/                   # Electron main process (IPC, lifecycle)
├── preload/                # Context bridge (renderer ↔ main)
└── renderer/               # React UI (three-panel layout)
    ├── components/
    │   ├── center/         # Chat, input, commands, mentions
    │   ├── layout/         # Sidebar shells, panels
    │   ├── left/           # Entity tabs, model selector
    │   └── right/          # Activity log, notifications, context
    └── stores/             # Zustand stores
docs/rfc/                   # Design documents
```

## Features

### Agent Capabilities
- **Coordinator Agent**: Single LLM agent with tools for file ops, web search, email DB, document conversion, and canonical memory tools.
- **Memory V2 Runtime**: `artifact.create/update/search`, `focus.add/remove`, `task.anchor.get/update`, `memory.explain`.
- **Kernel V2 Context Flow**: Focus digest + protected recent turns + tail task anchor.
- **Scheduled Tasks**: Cron scheduler with scheduler-run artifact persistence and notification integration.
- **Email/Calendar Integration**: Optional SQLite + Gmail tool + calendar tool with policy guardrails. (UI tabs currently hidden; backend still functional.)
- **Document Conversion**: PDF/Word/Excel/PPT via MarkItDown MCP, with drag-drop auto-conversion.

### Desktop UI
- **Three-Panel Layout**: Left (memory/artifacts + workspace tree), Center (chat), Right (context/notifications/activity).
- **Left Panel V2**: Tabs for Todos/Notes/Focus/Alerts and a virtualized workspace tree. (Docs, Mail, and Calendar tabs are hidden — backend support remains but the UI tabs are commented out to reduce clutter.)
- **Context Visibility**: Focus chips + Task Anchor + Explain snapshot in normal UI.
- **@-Mentions**: Entity mentions auto-promote focus; file/URL mentions are injected directly.
- **Slash Commands**: `/todo`, `/focus`, `/anchor`, `/explain`, `/search`, `/clear`, `/delete`, `/help`.
- **Notifications**: Bell icon with unread badge, notification panel from scheduled task results.
- **Session Persistence**: Chat history saved to disk, restorable across restarts.

### Framework Packs Used
| Pack | Tools |
|------|-------|
| `safe` | read, write, edit, glob, grep |
| `kvMemory` | memory-put, memory-update, memory-delete |
| `todo` | todo-add, todo-update, todo-complete, todo-remove |
| `sessionHistory` | Cross-turn history persistence |
| `contextPipeline` | ctx-get, ctx-expand |
| `documents` | convert_to_markdown (MarkItDown MCP) |
| `web` | brave_web_search, fetch |
| `sqlite` (optional) | sqlite_read_query, sqlite_list_tables, sqlite_describe_table |

Canonical memory tools: `artifact-*`, `focus-*`, `task-anchor-*`, `memory-explain`, `fact-*`.

## Quick Start

```bash
# From the repository root
cd examples/personal-assistant
npm install
npm run dev        # Start in dev mode (hot reload)
npm run build      # Production build
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI models | OpenAI API key |
| `ANTHROPIC_API_KEY` | Required for Anthropic models | Anthropic API key |
| `EMAIL_DB_PATH` | No | Path to SQLite email database |

## Recommended `kernelV2` Config

Use this as the baseline in `createAgent(...)` for production stability:

```ts
kernelV2: {
  enabled: true,
  storage: {
    integrity: {
      verifyOnStartup: true
    },
    recovery: {
      autoTruncateToLastValidRecord: true,
      createRecoverySnapshot: true
    }
  },
  lifecycle: {
    autoWeekly: true
  },
  telemetry: {
    baselineAlwaysOn: true,
    mode: 'stderr+file',
    filePath: '.agentfoundry/logs/kernel-v2.log'
  }
}
```

These values map to the five agreed defaults:
- default enable V2
- auto-migrate V1 to V2 at first startup
- auto-recover corrupted storage by truncating to last valid record
- run weekly memory lifecycle maintenance
- emit telemetry to both stderr and file

## Data Storage

All app data lives in `.personal-assistant-v2/` within the opened project folder, except shared Anthropic credentials (stored under `~/.agentfoundry/credentials/`):

```
.personal-assistant-v2/
├── artifacts/
│   ├── notes/
│   ├── todos/
│   ├── docs/
│   ├── email-messages/
│   ├── email-threads/
│   ├── calendar-events/
│   ├── scheduler-runs/
│   └── tool-outputs/
├── memory-v2/
│   ├── focus/
│   ├── tasks/
│   ├── explain/
│   └── index/
├── sessions/
├── cache/
├── scheduled-tasks.json
├── notifications.json
└── project.json
```

## Design Documents

- [RFC-001: Personal Assistant Desktop App](docs/rfc/001-personal-assistant-desktop.md)
- [RFC-002: Long-Term Memory & Autonomy](docs/rfc/002-long-term-memory-and-autonomy.md)
