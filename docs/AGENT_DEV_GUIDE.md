# AgentFoundry App Development Guide

> **For Coding Agents**: Read this BEFORE planning any AgentFoundry application.
> This guide prevents over-engineering and maximizes framework reuse.

## Golden Rule

**Check if the framework already has it. If yes, use it. If no, implement minimally.**

---

## 1. Tools - Check Before Creating

### Framework Already Provides:

| Need | Tool | Pack | Location |
|------|------|------|----------|
| Read files | `read` | safe | `src/tools/read.ts` |
| Write files | `write` | safe | `src/tools/write.ts` |
| Edit files | `edit` | safe | `src/tools/edit.ts` |
| List files | `glob` | safe | `src/tools/glob.ts` |
| Search content | `grep` | safe | `src/tools/grep.ts` |
| Expand context | `ctx-expand` | context-pipeline | `src/tools/ctx-expand.ts` |
| HTTP requests | `fetch` | network | `src/tools/fetch.ts` |
| Shell commands | `bash` | exec | `src/tools/bash.ts` |
| LLM sub-calls | `llm-call` | compute | `src/tools/llm-call.ts` |

### Do NOT Create Custom Tools For:

- **CRUD operations on JSON/files** → Use `read`/`write`/`glob`/`grep`
- **Context retrieval** → Use `ctx-expand` (supports segment, message, memory, search)
- **API calls** → Use `fetch`
- **Data storage** → Use `write` with path conventions

### When TO Create Custom Tools:

- Domain-specific external API integrations (e.g., Semantic Scholar, Arxiv)
- Complex transformations that can't be done with existing tools
- Tools that need custom validation or provenance injection

---

## 2. Context Pipeline - Check Before Implementing

### Framework Already Provides:

| Component | Location | What It Does |
|-----------|----------|--------------|
| `createContextPipeline` | `src/context/pipeline.ts` | Pipeline executor with budget management |
| `createSystemPhase` | `src/context/phases/system-phase.ts` | System prompt assembly |
| `createPinnedPhase` | `src/context/phases/pinned-phase.ts` | Always-included context |
| `createSelectedPhase` | `src/context/phases/selected-phase.ts` | User-selected context |
| `createSessionPhase` | `src/context/phases/session-phase.ts` | Session history |
| `createIndexPhase` | `src/context/phases/index-phase.ts` | Compressed history index |
| `SimpleHistoryCompressor` | `src/context/compressors/simple-compressor.ts` | History compression |
| `contextPipeline` pack | `src/packs/context-pipeline.ts` | Ready-to-use bundle |

### Do NOT Implement:

- Custom context phases → Use existing phase creators
- Custom history compressor → Use `SimpleHistoryCompressor`
- Custom pipeline executor → Use `createContextPipeline`
- Custom ctx-expand tool → Already exists with 4 expansion types

### Default Phase Budgets:

| Phase | Priority | Budget | Content |
|-------|----------|--------|---------|
| `system` | 100 | reserved 2000 | System prompt + tool descriptions |
| `pinned` | 90 | reserved 2000 | Pinned entities, user corrections |
| `selected` | 80 | 30% | User-selected items for this request |
| `session` | 50 | remaining | Recent conversation history |
| `index` | 30 | fixed 500 | Compressed history + catalog |

### Usage:

```typescript
import { packs } from 'agent-foundry'

const agent = createAgent({
  packs: [
    packs.safe(),           // File tools
    packs.contextPipeline() // Context pipeline + ctx-expand
  ]
})
```

---

## 3. Storage - Do NOT Create Abstraction Layers

### Anti-Pattern (Over-Engineered):

```typescript
// ❌ DO NOT create storage abstraction
class Storage {
  async saveNote(note: Note): Promise<void>
  async getNote(id: string): Promise<Note | null>
  async listNotes(): Promise<Note[]>
}
```

### Correct Pattern (Minimal):

```typescript
// ✅ Just define path constants
export const PATHS = {
  notes: '.my-app/notes',
  data: '.my-app/data',
  config: '.my-app/config.json'
} as const

// ✅ CLI commands use fs directly
import { writeFileSync, readFileSync, mkdirSync } from 'fs'

mkdirSync(PATHS.notes, { recursive: true })
writeFileSync(`${PATHS.notes}/${id}.json`, JSON.stringify(entity, null, 2))
```

### Why:

- Agents use framework's `read`/`write`/`glob`/`grep` tools
- CLI commands handle user-facing operations directly
- No abstraction layer needed between them

---

## 4. Minimal App Structure

```
my-agent-app/
├── index.ts              # CLI entry point
├── types.ts              # Entity types + PATHS constants
├── agents/
│   └── coordinator.ts    # Main agent (routes to sub-agents if needed)
└── commands/             # CLI command handlers (user-initiated actions)
    └── *.ts
```

### What You DON'T Need:

| ~~Over-Engineered~~ | Why Not Needed |
|---------------------|----------------|
| ~~`storage.ts`~~ | Use fs + PATHS constants |
| ~~`context/`~~ | Framework has full pipeline |
| ~~`tools/crud-*.ts`~~ | Use framework's read/write/glob/grep |
| ~~`tools/ctx-expand.ts`~~ | Already exists in framework |
| ~~`compressor.ts`~~ | Use SimpleHistoryCompressor |

---

## 5. Decision Checklist

Before implementing ANY component, ask:

```
┌─────────────────────────────────────────────────────────┐
│ 1. Does the framework already have this?                │
│    → Check src/tools/, src/packs/, src/context/         │
│    → If YES: Use it. STOP here.                         │
│                                                         │
│ 2. Can I achieve this with existing tools + conventions?│
│    → File storage: read/write + PATHS constants         │
│    → Context: contextPipeline pack                      │
│    → If YES: Use conventions. STOP here.                │
│                                                         │
│ 3. Is this truly domain-specific?                       │
│    → External API integration                           │
│    → Complex business logic                             │
│    → If YES: Implement minimally.                       │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Common Mistakes to Avoid

### Mistake 1: Creating CRUD Tools

```typescript
// ❌ WRONG
const noteCreateTool = defineTool({
  name: 'note-create',
  execute: async (input) => { /* write to file */ }
})

// ✅ RIGHT: Agent uses framework's write tool
// System prompt tells agent: "Save notes to .app/notes/{id}.json"
```

### Mistake 2: Reimplementing Context Pipeline

```typescript
// ❌ WRONG
class MyContextPipeline {
  phases: Phase[]
  assemble(): string { /* custom logic */ }
}

// ✅ RIGHT: Use framework
import { createContextPipeline, createPinnedPhase } from 'agent-foundry'
const pipeline = createContextPipeline({
  phases: [createPinnedPhase({ /* config */ })]
})
```

### Mistake 3: Creating Storage Abstraction

```typescript
// ❌ WRONG
class EntityStorage {
  constructor(private basePath: string) {}
  async save(entity: Entity) { /* ... */ }
  async load(id: string) { /* ... */ }
}

// ✅ RIGHT: Direct fs in CLI commands, path constants for agents
export const PATHS = { entities: '.app/entities' } as const
```

### Mistake 4: Custom History Compression

```typescript
// ❌ WRONG
class MyCompressor implements HistoryCompressor {
  compress(messages: Message[]) { /* custom logic */ }
}

// ✅ RIGHT: Use existing
import { SimpleHistoryCompressor } from 'agent-foundry'
const compressor = new SimpleHistoryCompressor({ segmentSize: 20 })
```

---

## 7. Recommended Packs by App Type

| App Type | Recommended Packs |
|----------|-------------------|
| File-based assistant | `safe()`, `contextPipeline()` |
| Research assistant | `safe()`, `contextPipeline()`, `network()` |
| Code assistant | `safe()`, `exec()`, `contextPipeline()` |
| Full-featured | `standard()` or `full()` |

---

## 8. Example: Research App (Minimal Design)

### Requirements:
- Notes, literature, data entities
- User can save notes from agent responses
- Context pipeline with pinned/selected items

### Implementation:

```
research-pilot/
├── index.ts          # CLI with commands
├── types.ts          # Types + PATHS
├── agents/
│   └── coordinator.ts
└── commands/
    ├── save-note.ts  # /save-note --from-last
    ├── select.ts     # /select <id>
    └── pin.ts        # /pin <id>
```

### What We Reuse (Zero Implementation):
- Context pipeline → `packs.contextPipeline()`
- File operations → `packs.safe()` (read, write, glob, grep)
- Context expansion → `ctx-expand` tool
- History compression → `SimpleHistoryCompressor`

### What We Implement (Minimal):
- `types.ts` - Entity types + PATHS constants
- `commands/*.ts` - CLI command handlers (direct fs operations)
- `agents/coordinator.ts` - Main agent logic

---

## Summary

| Layer | Framework Provides | You Implement |
|-------|-------------------|---------------|
| Tools | read, write, edit, glob, grep, ctx-expand, fetch, bash | Domain-specific APIs only |
| Context | Full 5-phase pipeline + compressor | Nothing (just configure) |
| Storage | File tools | PATHS constants + direct fs in commands |
| Agents | defineLLMAgent, defineTeam, agent-bridge | Your agent logic |

**Remember**: The best code is the code you don't write. Use the framework.
