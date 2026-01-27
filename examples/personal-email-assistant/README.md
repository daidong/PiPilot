# Personal Email Assistant

A single-agent example that reads emails from a local SQLite database via MCP server.

## Features

- **Email Database Access**: Read-only access via `mcp-server-sqlite-npx` with `--readonly` flag
- **Attachment Analysis**: Process PDF, Word, Excel, images via `documents` pack (MarkItDown)
- **Schema Auto-Discovery**: Discovers database structure before querying
- **Persistent Memory**: Stores user preferences via `kv-memory` pack
- **Knowledge Base**: Searches local documents via `docs` pack
- **Interactive REPL**: Multi-turn conversation with streaming output

## Architecture

```
+----------------------------------------------------+
|              Personal Assistant Agent               |
+----------------------------------------------------+
|  SQLite MCP Server                                 |
|  - Package: mcp-server-sqlite-npx                  |
|  - Tools:                                          |
|    - sqlite_list_tables                            |
|    - sqlite_describe_table                         |
|    - sqlite_read_query                             |
|  - Read-only enforced via prompt constraints       |
+----------------------------------------------------+
|  MarkItDown MCP Server (documents pack)            |
|  - Package: markitdown-mcp-npx                     |
|  - Supports: PDF, Word, Excel, PPT, Images, Audio  |
+----------------------------------------------------+
|  Built-in Packs                                    |
|  - safe       (read, write, edit, glob, grep)      |
|  - kv-memory  (memory-put, memory-update, ...)     |
|  - docs       (docs.index, docs.search, ...)       |
+----------------------------------------------------+
```

## Quick Start

```bash
export OPENAI_API_KEY=sk-xxx
npx tsx examples/personal-assistant/index.ts
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key |
| `EMAIL_DB_PATH` | No | `~/Library/Application Support/ChatMail/local-email.db` | Path to SQLite database |
| `KNOWLEDGE_PATH` | No | - | Path to knowledge base directory |

## CLI Options

```bash
npx tsx examples/personal-assistant/index.ts --debug  # Enable debug logging
```

## SQLite MCP Integration

This example uses the SQLite MCP server which is now integrated into AgentFoundry's MCP catalog:

```yaml
# From src/recommendation/data/mcp-catalog.yaml
- name: sqlite
  package: "mcp-server-sqlite-npx"
  description: "SQLite database operations for local databases"
  category: database
  riskLevel: elevated
  configTemplate:
    type: simple
    transport:
      type: stdio
      command: npx
      args: ["-y", "mcp-server-sqlite-npx", "${SQLITE_DB_PATH}"]
```

### Programmatic Usage (this example)

```typescript
import { createStdioMCPProvider } from 'agent-foundry'

const sqliteProvider = createStdioMCPProvider({
  id: 'sqlite',
  name: 'SQLite Email Database',
  command: 'npx',
  args: ['-y', 'mcp-server-sqlite-npx', '/path/to/database.db'],
  toolPrefix: 'sqlite'
})

const packs = await sqliteProvider.createPacks()
```

### Alternative: agent.yaml Configuration

You can also configure SQLite MCP via `agent.yaml`:

```yaml
# agent.yaml
mcp:
  - id: sqlite
    name: SQLite Database
    transport:
      type: stdio
      command: npx
      args: ["-y", "mcp-server-sqlite-npx", "${SQLITE_DB_PATH}"]
```

Then set the environment variable:
```bash
export SQLITE_DB_PATH=/path/to/your/database.db
```

## Example Usage

```
You: What tables are in my email database?
Assistant: [Calls sqlite_list_tables, sqlite_describe_table]

You: Show me emails from this week
Assistant: [Executes SQL query with date filter]

You: Analyze the PDF attachment at ~/Downloads/report.pdf
Assistant: [Uses MarkItDown to extract and summarize content]

You: Remember that I prefer brief responses
Assistant: [Stores preference using memory-put]
```

## Comparison with Other Examples

| Example | Architecture | Use Case |
|---------|-------------|----------|
| `personal-assistant` | Single Agent + MCP | Interactive CLI assistant |
| `literature-agent` | Multi-Agent Team | Research workflow with multiple specialized agents |
| `dataanalysis-agent` | Multi-Agent Team | Data analysis pipeline |

## Key Components

- **createAgent()**: Single-agent factory from AgentFoundry
- **createStdioMCPProvider()**: Connects to local MCP server (matches catalog entry)
- **mergePacks()**: Combines multiple packs into one

## Security

- SQLite MCP server runs locally via `npx mcp-server-sqlite-npx`
- Read-only access is enforced via agent prompt constraints
- Agent is instructed to only execute SELECT queries (no INSERT/UPDATE/DELETE)
- Memory stored locally in `.agent-foundry/memory/`
- Database access is limited to the specified path
- Document processing (MarkItDown) is read-only for local files
