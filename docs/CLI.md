# Agent Foundry CLI

Command-line interface for Agent Foundry.

## Installation

The CLI is included with the `agent-foundry` package:

```bash
npm install agent-foundry
```

Or use directly with npx:

```bash
npx agent-foundry <command>
```

## Commands

### init

Interactive wizard to create an `agent.yaml` configuration file.

```bash
npx agent-foundry init [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key for LLM-powered recommendations |

**API Key Resolution:**

The CLI looks for an API key in the following order:
1. `--api-key` command line option
2. `OPENAI_API_KEY` environment variable
3. `ANTHROPIC_API_KEY` environment variable

If an API key is found, the CLI uses LLM-powered semantic recommendations. Otherwise, it falls back to keyword-based matching.

**Process:**

1. **Describe your agent**: Enter a natural language description of what your agent should do
2. **Name your agent**: Provide a name (ID is auto-generated)
3. **Review recommendations**: The CLI recommends packs and MCP servers based on your description
4. **Refine**: Adjust recommendations through conversation (or press Enter to accept)
5. **Generate**: Creates configuration files

**Output:**

- `agent.yaml` - Agent configuration file
- `.env.example` - Environment variables template (if MCP servers need credentials)

**Example:**

```bash
$ npx agent-foundry init --api-key sk-xxx

╔═══════════════════════════════════════════════════════════╗
║          Agent Foundry - Configuration Wizard             ║
╚═══════════════════════════════════════════════════════════╝

Please describe your agent:
> I want to build an agent that can search GitHub repositories,
  analyze code, and create issues.

Agent Name: GitHub Assistant

Analyzing...

Understanding:
   - GitHub repository access
   - Code analysis capabilities
   - Issue management

Recommended Packs:
   ✅ safe (100%) - Basic file operations
   ⚡ compute (90%) - LLM sub-calls for analysis
   ⚡ network (85%) - HTTP requests

Recommended MCP Servers:
   ⚡ github (95%) - GitHub API integration
      Requires: GITHUB_TOKEN

Adjust? (Enter to confirm, 'q' to cancel)
>

Generating files...
   ✓ agent.yaml
   ✓ .env.example

Done! Next steps:
   1. Edit agent.yaml to adjust configuration
   2. Copy .env.example to .env and fill in values
   3. Use in your code:
      import { createAgent } from 'agent-foundry'
      const agent = await createAgent({ apiKey: '...' })
```

### validate

Validate an existing `agent.yaml` configuration file.

```bash
npx agent-foundry validate
```

**Checks:**

- Required fields (id)
- ID format (starts with letter, alphanumeric + hyphens/underscores)
- Valid pack names
- maxSteps range (1-100)

**Example:**

```bash
$ npx agent-foundry validate
Validating: ./agent.yaml
✅ Configuration valid

   Agent ID: github-assistant
   Name: GitHub Assistant
   Packs: 3
   MCP Servers: 1
```

### index-docs

Build document index for the `docs.*` context sources. Scans specified directories for documents, extracts metadata, chunks content by token count, and builds an inverted keyword index.

```bash
npx agent-foundry index-docs [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--paths, -p <dirs>` | Document directories, comma-separated | `./docs` |
| `--ext, -e <exts>` | File extensions, comma-separated | `.md,.txt` |
| `--exclude, -x <globs>` | Exclude patterns, comma-separated | - |
| `--chunk-size <n>` | Chunk size in tokens | `500` |
| `--overlap <n>` | Chunk overlap in tokens | `50` |
| `--output, -o <dir>` | Output directory | `.agent-foundry` |
| `--incremental, -i` | Incremental update mode | - |
| `--verbose, -v` | Verbose output | - |

**Output:**

Creates `.agent-foundry/docs_index.json` containing:
- Document metadata (title, type, size, modified date)
- Chunked content with line ranges
- Inverted keyword index for fast searching

**Examples:**

```bash
# Index the default docs directory
$ npx agent-foundry index-docs

# Index multiple directories
$ npx agent-foundry index-docs --paths docs,wiki,notes

# Index only markdown files
$ npx agent-foundry index-docs --ext .md

# Incremental update with verbose output
$ npx agent-foundry index-docs --incremental --verbose

# Custom chunk size
$ npx agent-foundry index-docs --chunk-size 300 --overlap 30

# Exclude certain patterns
$ npx agent-foundry index-docs --exclude "drafts/*,*.bak"
```

**Example Output:**

```bash
$ npx agent-foundry index-docs --paths docs -v

📚 Building document index...

Configuration:
  Project path: /Users/me/project
  Document paths: docs
  Extensions: .md, .txt
  Chunk size: 500 tokens
  Chunk overlap: 50 tokens
  Output directory: .agent-foundry

Scanning: /Users/me/project/docs
  Processing: docs/guide.md
  Processing: docs/api.md
  Processing: docs/changelog.md

✅ Index built successfully!

Summary:
  Documents: 3
  Chunks: 12
  Tokens: 4500
  By type: markdown(3)

Index saved to: /Users/me/project/.agent-foundry/docs_index.json

Usage:
  ctx.get("docs.index")              - List all documents
  ctx.get("docs.search", { query })  - Search documents
  ctx.get("docs.open", { path })     - Read document content
```

**Using with Agents:**

After building the index, use the `docs` pack to give your agent document access:

```typescript
import { createAgent, packs } from 'agent-foundry'

const agent = createAgent({
  packs: [packs.standard(), packs.docs()]
})

// Agent can now use docs.index, docs.search, docs.open
```

### help

Show help information.

```bash
npx agent-foundry help
npx agent-foundry --help
npx agent-foundry -h
```

### version

Show version.

```bash
npx agent-foundry --version
npx agent-foundry -v
```

## Configuration File Format

### agent.yaml

```yaml
# Required: Unique identifier
id: my-agent

# Optional: Display name
name: My Agent

# Optional: Agent identity/persona
identity: |
  You are a helpful assistant specializing in code review.
  You provide constructive feedback and suggest improvements.

# Optional: Behavioral constraints
constraints:
  - Always explain your reasoning
  - Ask for clarification when uncertain
  - Never modify files without explicit permission

# Optional: Packs to load
# Can be string or object with options
packs:
  - safe                    # String format
  - compute
  - name: network           # Object format with options
    options:
      allowHttp: true

# Optional: MCP server configurations
mcp:
  - name: github
    package: "@modelcontextprotocol/server-github"
    transport:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      - GITHUB_TOKEN

# Optional: Model configuration
model:
  default: gpt-4o
  maxTokens: 16384
  temperature: 0.7

# Optional: Maximum execution steps
maxSteps: 25

# Optional: Custom configuration
custom:
  myOption: value
```

### Available Packs

#### Core Packs

| Pack | Risk | Description |
|------|------|-------------|
| `safe` | Safe | read, write, edit, glob, grep, ctx-get |
| `compute` | Elevated | llm-call, llm-expand, llm-filter |
| `network` | Elevated | fetch (HTTP requests) |
| `exec` | High | bash (shell execution) |

#### Domain Packs

| Pack | Risk | Description |
|------|------|-------------|
| `repo` | Safe | Repository context sources |
| `git` | Elevated | Git operations |
| `exploration` | Safe | Code exploration guidelines |
| `browser` | Elevated | Browser automation |
| `python` | Elevated | Python execution |

#### Memory & Context Packs

| Pack | Risk | Description |
|------|------|-------------|
| `kv-memory` | Safe | Key-value memory storage |
| `session-memory` | Safe | Session history + facts/decisions |
| `docs` | Safe | Document library (requires index-docs) |
| `discovery` | Safe | Context source discovery (ctx.catalog, ctx.describe, ctx.route) |

### Pack Options

**network:**
```yaml
packs:
  - name: network
    options:
      allowHttp: true       # Allow HTTP (not just HTTPS)
      allowedDomains:       # Domain whitelist
        - api.github.com
        - api.openai.com
```

**exec:**
```yaml
packs:
  - name: exec
    options:
      allowedCommands:      # Command whitelist
        - npm
        - git
        - ls
```

**compute:**
```yaml
packs:
  - name: compute
    options:
      maxTokensPerCall: 4000
      requireApproval: false
```

## Supported MCP Servers

The CLI recommends from a curated catalog of MCP servers:

### Filesystem
- `filesystem` - Advanced file operations

### Database
- `postgres` - PostgreSQL (requires POSTGRES_CONNECTION_STRING)
- `sqlite` - SQLite local database

### Search
- `brave-search` - Web search (requires BRAVE_API_KEY)
- `google-maps` - Maps API (requires GOOGLE_MAPS_API_KEY)

### Developer Tools
- `github` - GitHub API (requires GITHUB_TOKEN)
- `git` - Local Git operations

### Browser
- `puppeteer` - Browser automation

### Communication
- `slack` - Slack integration (requires SLACK_BOT_TOKEN)

### Memory
- `memory` - Persistent knowledge storage

### Documents
- `google-drive` - Google Drive (requires GOOGLE_APPLICATION_CREDENTIALS)

### Other
- `fetch` - HTTP requests
- `sequential-thinking` - Step-by-step reasoning

## Environment Variables

After running `init`, copy `.env.example` to `.env` and fill in required values:

```bash
cp .env.example .env
```

Example `.env.example`:
```
# Environment variables for Agent Foundry
# Copy this file to .env and fill in the values

# OpenAI API Key (required)
OPENAI_API_KEY=sk-...

# GitHub Personal Access Token
GITHUB_TOKEN=

# Brave Search API Key
BRAVE_API_KEY=
```

## Programmatic Usage

The CLI wizard can also be used programmatically:

```typescript
import { runInitWizard, ToolRecommender, createRecommender } from 'agent-foundry'

// Run interactive wizard
await runInitWizard(apiKey)

// Or use the recommender directly
const recommender = createRecommender(llmClient)
const recommendations = await recommender.recommend(
  'An agent that searches GitHub and analyzes code'
)

console.log(recommendations.packs)      // Recommended packs
console.log(recommendations.mcpServers) // Recommended MCP servers
console.log(recommendations.warnings)   // Security warnings
```
