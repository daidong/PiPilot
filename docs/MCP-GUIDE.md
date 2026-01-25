# MCP vs Local Tools: When to Use What

This guide helps you decide when to use MCP (Model Context Protocol) servers versus local tools in AgentFoundry.

## TL;DR

| Scenario | Solution |
|----------|----------|
| Your own business logic | **Local Tool** (`defineTool`) |
| Common capabilities (file system, database, GitHub, etc.) | **MCP Server** (use existing) |
| Quick prototyping | **Local Tool** |
| Cross-project/cross-language reuse | **MCP Server** (use existing) |

**Key principle: You should never need to implement an MCP server yourself.** Either use existing MCP servers for common capabilities, or write local tools for your custom logic.

---

## Understanding the Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Agent                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Local Tools                      MCP Servers              │
│   (you write these)                (you connect to these)   │
│   ─────────────────                ───────────────────────  │
│                                                             │
│   • Business logic                 • File system access     │
│   • Internal API calls             • Database connections   │
│   • Domain-specific tasks          • GitHub/Slack/etc.      │
│   • Custom processing              • Browser automation     │
│   • Rapid prototyping              • Search engines         │
│                                                             │
│   defineTool({...})                createMCPProvider({...}) │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## When to Use Local Tools

Use `defineTool()` when:

1. **It's your business logic** - Custom algorithms, domain rules, internal workflows
2. **It calls your internal APIs** - Services specific to your organization
3. **You need fast iteration** - Prototyping, experimentation
4. **Performance matters** - No IPC/network overhead
5. **Debugging needs to be easy** - Direct breakpoints, stack traces

### Example: Local Tool

```typescript
import { defineTool } from 'agent-foundry'

// Your custom business logic - perfect for a local tool
const calculatePricing = defineTool({
  name: 'calculate_pricing',
  description: 'Calculate product pricing based on business rules',
  parameters: {
    productId: { type: 'string', required: true },
    quantity: { type: 'number', required: true },
    customerTier: { type: 'string', enum: ['standard', 'premium', 'enterprise'] }
  },
  execute: async (input, { runtime }) => {
    // Your business logic here - direct, simple, debuggable
    const basePrice = await getProductPrice(input.productId)
    const discount = getDiscount(input.customerTier, input.quantity)
    const finalPrice = basePrice * input.quantity * (1 - discount)

    return {
      success: true,
      data: { finalPrice, discount, breakdown: {...} }
    }
  }
})
```

---

## When to Use MCP

Use MCP when you need **common capabilities** that others have already implemented:

1. **File system operations** - Reading/writing files with proper permissions
2. **Database access** - PostgreSQL, MongoDB, SQLite, etc.
3. **Third-party services** - GitHub, Slack, Notion, Linear, etc.
4. **Browser automation** - Web scraping, testing
5. **Search** - Web search, vector databases

### Example: Using an MCP Server

```typescript
import { createAgent, createStdioMCPProvider } from 'agent-foundry'

// Connect to an existing MCP server - don't implement one yourself!
const githubMCP = createStdioMCPProvider({
  id: 'github',
  name: 'GitHub MCP',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN
  }
})

const agent = createAgent({
  providers: [githubMCP],
  // ... other config
})
```

---

## Why You Should NOT Implement MCP Servers

| Writing a Local Tool | Implementing an MCP Server |
|---------------------|---------------------------|
| ~20 lines of code | ~200+ lines of code |
| `defineTool({...})` | JSON-RPC, transport layer, protocol handling |
| Direct debugging | Cross-process debugging |
| Zero overhead | IPC/network overhead |
| Immediate | Needs separate process management |

MCP is a **protocol for sharing capabilities across different projects and languages**. If you're building something just for your agent:

- **Don't** create an MCP server
- **Do** write a local tool

The only reasons to create an MCP server:
- You're a **service provider** wanting to expose capabilities to many users
- You're building a **reusable library** for the community
- You need **language isolation** (e.g., Python tool in a Node.js agent)

---

## Comparison Table

| Aspect | Local Tool | MCP Server |
|--------|-----------|------------|
| **Code complexity** | Low (~20 lines) | High (~200+ lines) |
| **Debugging** | Easy (direct) | Hard (cross-process) |
| **Performance** | Fastest | Has overhead |
| **Reusability** | Code-level | Protocol-level |
| **Language** | Same as agent | Any language |
| **When to use** | Your logic | Existing capabilities |
| **Who implements** | You | Community/vendors |

---

## Finding MCP Servers

Before writing any tool, check if an MCP server already exists:

1. **Official MCP servers**: https://github.com/modelcontextprotocol/servers
2. **Community servers**: Search GitHub for `mcp-server-*`
3. **Vendor-provided**: Many services now offer official MCP servers

Common MCP servers:
- `@modelcontextprotocol/server-filesystem` - File operations
- `@modelcontextprotocol/server-github` - GitHub API
- `@modelcontextprotocol/server-postgres` - PostgreSQL
- `@modelcontextprotocol/server-sqlite` - SQLite
- `@modelcontextprotocol/server-slack` - Slack
- `@modelcontextprotocol/server-puppeteer` - Browser automation

---

## Document Processing

AgentFoundry provides built-in document processing via MarkItDown MCP server.

### Quick Start

```typescript
import { createAgent, packs } from 'agent-foundry'

const agent = createAgent({
  packs: [
    packs.safe(),
    await packs.documents()
  ]
})
```

### Supported Formats

| Category | Formats |
|----------|---------|
| Documents | PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) |
| Images | PNG, JPG, GIF, BMP, TIFF, WEBP (with OCR) |
| Audio | MP3, WAV (requires FFmpeg for transcription) |
| Web | HTML, YouTube URLs |
| Other | ZIP (processes contents), EPUB, CSV, JSON, XML |

### Available Tool

The pack provides a single tool:

- **`convert_to_markdown`**: Convert any supported file to markdown
  ```typescript
  // Local file
  { uri: "file:///path/to/document.pdf" }

  // URL
  { uri: "https://example.com/page.html" }

  // YouTube
  { uri: "https://youtube.com/watch?v=..." }
  ```

### Requirements

- Node.js 16+
- Python 3.10+
- FFmpeg (optional, for audio transcription)

### Manual Configuration

If you prefer manual MCP configuration:

```typescript
import { createStdioMCPProvider } from 'agent-foundry'

const markitdown = createStdioMCPProvider({
  id: 'markitdown',
  name: 'MarkItDown',
  command: 'npx',
  args: ['-y', 'markitdown-mcp-npx']
})

const packs = await markitdown.createPacks()
```

---

## Configuring MCP: Local vs Remote

MCP servers can run locally (STDIO) or remotely (HTTP). Here's how to decide:

### Use STDIO (Local) When:
- MCP server needs local file system access
- You want data to stay on your machine
- Network is restricted or unreliable
- You need lowest latency

```typescript
const localMCP = createStdioMCPProvider({
  id: 'filesystem',
  name: 'File System',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allow']
})
```

### Use HTTP (Remote) When:
- MCP server is a hosted service
- You need horizontal scaling
- Multiple agents share the same server
- The service requires specific infrastructure

```typescript
const remoteMCP = createHttpMCPProvider({
  id: 'my-service',
  name: 'My Service MCP',
  url: 'https://mcp.myservice.com',
  headers: {
    'Authorization': `Bearer ${process.env.SERVICE_TOKEN}`
  }
})
```

### Decision Matrix

| Requirement | Recommended |
|------------|-------------|
| Access local files | STDIO |
| Data privacy critical | STDIO |
| Hosted/managed service | HTTP |
| Shared across team | HTTP |
| No network dependency | STDIO |
| Need load balancing | HTTP |

---

## Security Considerations

### Local Tools
- Run in your process with full access
- You control the code completely
- Trust level: **High** (you wrote it)

### MCP Servers (STDIO/Local)
- Run as subprocess on your machine
- Have access to local resources
- Trust level: **Medium** (audit the code)

### MCP Servers (HTTP/Remote)
- Run on external infrastructure
- Data leaves your machine
- Trust level: **Verify** (check provider reputation)

### Best Practices

1. **Audit MCP servers** before using them
2. **Use environment variables** for secrets, never hardcode
3. **Limit permissions** - only grant what's needed
4. **Prefer official/verified** MCP servers
5. **Monitor MCP calls** using policies

```typescript
import { defineObservePolicy } from 'agent-foundry'

// Log all MCP tool calls for auditing
const mcpAuditPolicy = defineObservePolicy({
  id: 'mcp-audit',
  description: 'Audit MCP tool calls',
  match: (ctx) => ctx.tool.startsWith('mcp.'),
  observe: (ctx) => ({
    record: {
      tool: ctx.tool,
      input: ctx.input,
      timestamp: Date.now()
    },
    alert: ctx.tool.includes('write') ? 'MCP write operation' : undefined
  })
})
```

---

## Summary

```
Need to do something?
        │
        ▼
Is there an existing MCP server for it?
        │
    ┌───┴───┐
    │       │
   Yes      No
    │       │
    ▼       ▼
Use MCP   Is it generic/reusable?
Server          │
            ┌───┴───┐
            │       │
           Yes      No
            │       │
            ▼       ▼
      Consider    Write a
      contributing Local Tool
      to MCP      (defineTool)
      ecosystem
```

**Remember**: MCP is for **consuming** shared capabilities, not for building your business logic. Keep it simple - use `defineTool()` for your custom needs.
