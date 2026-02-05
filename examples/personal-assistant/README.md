# Personal Assistant

An Electron desktop app built on AgentFoundry. Features a persistent AI assistant with long-term memory, scheduled tasks, document management, and a three-panel UI.

## Project Structure

```
src/
├── agent/                  # Agent layer (coordinator, tools, types)
│   ├── agents/             # Coordinator agent + system prompt
│   ├── commands/           # Entity CRUD commands (notes, docs, search)
│   ├── mentions/           # @-mention parser and resolver
│   ├── scheduler/          # Cron scheduler + notification store
│   ├── tools/              # Custom agent tools (entity-tools)
│   └── types.ts            # Shared types (entities, scheduler, paths)
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
- **Coordinator Agent**: Single LLM agent with tools for file ops, web search, email DB, document conversion, entity management
- **Long-Term Memory** (RFC-002): Daily logs, USER.md, MEMORY.md — auto-injected every turn as bootstrap context
- **Scheduled Tasks** (RFC-002): Cron-based scheduler with heartbeat (2 AM), morning briefing (8 AM weekdays), Monday review (9 AM)
- **Pre-Compaction Flush**: Saves conversation context to daily log before context window compaction
- **Email Database**: Optional SQLite read access for email/calendar queries
- **Document Conversion**: PDF/Word/Excel/PPT via MarkItDown MCP, with drag-drop auto-conversion

### Desktop UI
- **Three-Panel Layout**: Left (entities + model selector), Center (chat), Right (activity + notifications + context)
- **Entity Management**: Notes and Docs with Project Cards / WorkingSet selection, hover preview, provenance tracking
- **@-Mentions**: Entity mentions go to WorkingSet; file/URL mentions are injected directly
- **Slash Commands**: `/save-note`, `/save-doc`, `/search`, `/select`, `/project` (alias: `/pin`), `/clear`, `/delete`, `/help`
- **Notifications**: Bell icon with unread badge, notification panel from scheduled task results
- **Drag & Drop**: Drop files into Notes (text) or Docs (binary + auto-convert)
- **Model Selector**: Switch between OpenAI models at runtime
- **Session Persistence**: Chat history saved to disk, restorable across restarts

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

Custom tools: `save-note`, `save-doc`, `update-note` (trigger IPC entity refresh).

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
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `EMAIL_DB_PATH` | No | Path to SQLite email database |

## Data Storage

All data lives in `.personal-assistant/` within the opened project folder:

```
.personal-assistant/
├── USER.md                    # User profile (identity, preferences)
├── MEMORY.md                  # Consolidated long-term memory (heartbeat-maintained)
├── memory/                    # Daily logs (YYYY-MM-DD.md)
├── notes/                     # Note entities (JSON)
├── docs/                      # Document entities (JSON + original files)
├── sessions/                  # Chat history (JSONL per session)
├── scheduled-tasks.json       # Cron schedule config
├── notifications.json         # Notification history
├── cache/                     # Document conversion cache
└── project.json               # Project config
```

## Design Documents

- [RFC-001: Personal Assistant Desktop App](docs/rfc/001-personal-assistant-desktop.md)
- [RFC-002: Long-Term Memory & Autonomy](docs/rfc/002-long-term-memory-and-autonomy.md)
