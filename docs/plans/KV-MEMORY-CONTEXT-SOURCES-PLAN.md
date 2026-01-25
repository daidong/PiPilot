# KV Memory Storage Context Sources Implementation Plan

## Overview

Implement an explicit key-value memory storage system that enables Agents to store specific information and retrieve it later. Uses a **Tool for writing** and **Context Sources for reading**, with a file-based storage backend.

## Core Design Principle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Read/Write Separation                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Write Channel (Tool)              Read Channel (ctx.get)      │
│   ─────────────────────             ──────────────────────      │
│   • memory.put                      • memory.get                │
│   • memory.delete                   • memory.search             │
│   • memory.update                   • memory.list               │
│                                                                 │
│   Side effects → Policy guard       Token control → Rendering   │
│   User approval → Audit trail       Provenance → Coverage       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Why separate?**
- `ctx.get` = "Read context for model" - focus on token budget, rendering, provenance
- `Tool` = "Change state" - focus on approval, validation, audit

## File Checklist

### New Files
| File | Description |
|------|-------------|
| `src/core/memory-storage.ts` | Storage abstraction + file implementation |
| `src/tools/memory-put.ts` | memory.put tool |
| `src/tools/memory-delete.ts` | memory.delete tool |
| `src/tools/memory-update.ts` | memory.update tool |
| `src/context-sources/memory-get.ts` | memory.get context source |
| `src/context-sources/memory-search.ts` | memory.search context source |
| `src/context-sources/memory-list.ts` | memory.list context source |
| `src/policies/memory-write-guard.ts` | Policy for memory writes |
| `src/packs/kv-memory.ts` | kv-memory Pack |

### Modified Files
| File | Description |
|------|-------------|
| `src/tools/index.ts` | Add memory tool exports |
| `src/context-sources/index.ts` | Add memory context source exports |
| `src/packs/index.ts` | Add kv-memory pack export |
| `src/types/memory.ts` | New file for memory types |

---

## 1. Storage Layer Design

### 1.1 File Structure

```
.agent-foundry/
├── memory/
│   ├── items.json          # All memory items
│   ├── index.json          # Inverted index for search
│   └── history.jsonl       # Append-only change log (audit)
└── config.json
```

### 1.2 Storage Format: `items.json`

```json
{
  "version": "1.0.0",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "stats": {
    "totalItems": 42,
    "byNamespace": { "user": 15, "project": 20, "session": 7 },
    "bySensitivity": { "public": 35, "internal": 5, "sensitive": 2 }
  },
  "items": {
    "user:writing.no_em_dash": {
      "id": "mem_abc123",
      "namespace": "user",
      "key": "writing.no_em_dash",
      "value": { "enabled": true, "reason": "User preference" },
      "valueText": "Do not use em dashes in output",
      "tags": ["style", "writing"],
      "sensitivity": "public",
      "status": "active",
      "ttlExpiresAt": null,
      "provenance": {
        "messageId": "msg_xyz789",
        "sessionId": "sess_456",
        "traceId": "trace_001",
        "createdBy": "user",
        "confirmedAt": "2024-01-15T10:30:00Z"
      },
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  }
}
```

### 1.3 Index Format: `index.json`

```json
{
  "version": "1.0.0",
  "updatedAt": "2024-01-15T10:30:00Z",
  "keywords": {
    "writing": ["user:writing.no_em_dash", "user:writing.tone"],
    "style": ["user:writing.no_em_dash", "project:code.style"],
    "typescript": ["project:language", "project:code.style"]
  },
  "tags": {
    "style": ["user:writing.no_em_dash", "project:code.style"],
    "preference": ["user:writing.no_em_dash", "user:theme"]
  },
  "namespaces": {
    "user": ["user:writing.no_em_dash", "user:writing.tone", "user:theme"],
    "project": ["project:language", "project:code.style"],
    "session": ["session:current_task"]
  }
}
```

### 1.4 History Format: `history.jsonl` (Audit Trail)

```jsonl
{"op":"put","key":"user:writing.no_em_dash","timestamp":"2024-01-15T10:30:00Z","traceId":"trace_001","actor":"user"}
{"op":"update","key":"user:writing.no_em_dash","timestamp":"2024-01-15T11:00:00Z","traceId":"trace_002","actor":"model","changes":{"valueText":"Updated preference"}}
{"op":"delete","key":"session:temp_data","timestamp":"2024-01-15T12:00:00Z","traceId":"trace_003","actor":"system","reason":"TTL expired"}
```

---

## 2. Storage Abstraction

### 2.1 Interface Definition

```typescript
interface MemoryItem {
  id: string
  namespace: string
  key: string
  value: unknown
  valueText?: string
  tags: string[]
  sensitivity: 'public' | 'internal' | 'sensitive'
  status: 'active' | 'deprecated'
  ttlExpiresAt?: string
  provenance: {
    messageId?: string
    sessionId?: string
    traceId: string
    createdBy: 'user' | 'model' | 'system'
    confirmedAt?: string
  }
  createdAt: string
  updatedAt: string
}

interface MemoryStorage {
  // CRUD
  get(namespace: string, key: string): Promise<MemoryItem | null>
  put(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem>
  update(namespace: string, key: string, updates: Partial<MemoryItem>): Promise<MemoryItem>
  delete(namespace: string, key: string, reason?: string): Promise<void>

  // Query
  list(namespace?: string, status?: 'active' | 'all'): Promise<MemoryItem[]>
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>

  // Maintenance
  cleanExpired(): Promise<number>
  rebuildIndex(): Promise<void>

  // Lifecycle
  init(): Promise<void>
  close(): Promise<void>
}

interface SearchOptions {
  namespace?: string
  tags?: string[]
  sensitivity?: 'public' | 'internal' | 'sensitive' | 'all'
  limit?: number
  includeDeprecated?: boolean
}

interface SearchResult {
  item: MemoryItem
  score: number
  matchedKeywords: string[]
}
```

### 2.2 File-based Implementation

```typescript
class FileMemoryStorage implements MemoryStorage {
  private itemsPath: string
  private indexPath: string
  private historyPath: string
  private data: MemoryData | null = null
  private index: MemoryIndex | null = null
  private dirty: boolean = false

  constructor(basePath: string) {
    this.itemsPath = path.join(basePath, 'memory', 'items.json')
    this.indexPath = path.join(basePath, 'memory', 'index.json')
    this.historyPath = path.join(basePath, 'memory', 'history.jsonl')
  }

  async init(): Promise<void> {
    await this.ensureDir()
    await this.load()
  }

  async get(namespace: string, key: string): Promise<MemoryItem | null> {
    const fullKey = `${namespace}:${key}`
    return this.data?.items[fullKey] ?? null
  }

  async put(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryItem> {
    const fullKey = `${item.namespace}:${item.key}`
    const now = new Date().toISOString()

    const newItem: MemoryItem = {
      ...item,
      id: `mem_${randomId()}`,
      createdAt: now,
      updatedAt: now
    }

    this.data!.items[fullKey] = newItem
    this.updateIndex(newItem)
    await this.appendHistory({ op: 'put', key: fullKey, ... })
    await this.save()

    return newItem
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const keywords = this.tokenize(query)
    const candidates = new Map<string, number>()

    // Score by keyword matches
    for (const keyword of keywords) {
      const matches = this.index?.keywords[keyword] ?? []
      for (const key of matches) {
        candidates.set(key, (candidates.get(key) ?? 0) + 1)
      }
    }

    // Filter and sort
    const results: SearchResult[] = []
    for (const [key, score] of candidates) {
      const item = this.data?.items[key]
      if (!item) continue
      if (options?.namespace && item.namespace !== options.namespace) continue
      if (!options?.includeDeprecated && item.status === 'deprecated') continue

      results.push({
        item,
        score: score / keywords.length,
        matchedKeywords: keywords.filter(k => this.index?.keywords[k]?.includes(key))
      })
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.limit ?? 20)
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\-_.,;:!?]+/)
      .filter(w => w.length > 2)
  }
}
```

---

## 3. Tools Design

### 3.1 memory.put - Write Memory

**Purpose**: Store a key-value pair in memory

**Parameters**:
```typescript
interface MemoryPutParams {
  namespace: string         // required: 'user' | 'project' | 'session'
  key: string               // required: dot-separated path
  value: unknown            // required: any JSON-serializable value
  valueText?: string        // human-readable description
  tags?: string[]           // categorization tags
  sensitivity?: 'public' | 'internal' | 'sensitive'  // default: 'public'
  ttlDays?: number          // auto-expire after N days
  overwrite?: boolean       // default: false
  requireConfirmation?: boolean  // default: true for user namespace
}
```

**Policy Guards**:
1. `namespace === 'user'` → require user confirmation by default
2. `sensitivity === 'sensitive'` → always require confirmation
3. Key format validation: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`
4. Value size limit: 10KB

**Output**:
```typescript
interface MemoryPutResult {
  success: boolean
  id: string
  key: string
  overwritten: boolean
  expiresAt?: string
}
```

### 3.2 memory.delete - Delete Memory

**Parameters**:
```typescript
interface MemoryDeleteParams {
  namespace: string
  key: string
  reason?: string
  soft?: boolean  // default: true (mark deprecated, not delete)
}
```

### 3.3 memory.update - Update Memory

**Parameters**:
```typescript
interface MemoryUpdateParams {
  namespace: string
  key: string
  value?: unknown
  valueText?: string
  tags?: string[]
  status?: 'active' | 'deprecated'
}
```

---

## 4. Context Sources Design

### 4.1 memory.get - Exact Key Lookup

**Purpose**: Retrieve a specific memory item by namespace and key

**Parameters**:
```typescript
interface MemoryGetParams {
  namespace: string   // required
  key: string         // required
  includeHistory?: boolean  // show previous values
}
```

**Output**:
```typescript
interface MemoryGetData {
  found: boolean
  item?: {
    namespace: string
    key: string
    value: unknown
    valueText?: string
    tags: string[]
    status: 'active' | 'deprecated'
    updatedAt: string
  }
  provenance?: {
    createdBy: string
    confirmedAt?: string
    traceId: string
  }
}
```

**Rendered Output**:
```
# Memory: user:writing.no_em_dash

Value: { "enabled": true }
Description: Do not use em dashes in output
Tags: style, writing
Status: active
Updated: 2024-01-15T10:30:00Z
Source: User confirmed (msg_xyz789)
```

**Config**: costTier=cheap, maxTokens=500, ttl=5min, invalidateOn=['memory:update']

### 4.2 memory.search - Query-based Search

**Purpose**: Find memory items matching a query

**Parameters**:
```typescript
interface MemorySearchParams {
  query: string               // required
  namespace?: string          // filter by namespace
  tags?: string[]             // filter by tags
  sensitivity?: 'public' | 'internal' | 'all'  // default: 'all'
  limit?: number              // default: 10
  includeDeprecated?: boolean // default: false
}
```

**Output**:
```typescript
interface MemorySearchData {
  results: {
    namespace: string
    key: string
    valueText?: string
    tags: string[]
    score: number
    matchedKeywords: string[]
  }[]
  totalMatches: number
}
```

**Rendered Output**:
```
# Memory Search: "writing style"

Found 3 matches:

1. [user:writing.no_em_dash] (score: 0.92)
   Do not use em dashes in output
   Tags: style, writing

2. [user:writing.tone] (score: 0.75)
   Use professional but friendly tone
   Tags: style, tone

3. [project:code.style] (score: 0.45)
   Follow ESLint standard config
   Tags: style, code

[3 of 3 matches shown]
```

**Config**: costTier=medium, maxTokens=1000, ttl=2min

### 4.3 memory.list - List by Namespace

**Purpose**: List all items in a namespace

**Parameters**:
```typescript
interface MemoryListParams {
  namespace?: string          // filter by namespace (all if omitted)
  tags?: string[]             // filter by tags
  status?: 'active' | 'deprecated' | 'all'  // default: 'active'
  limit?: number              // default: 50
  offset?: number             // default: 0
}
```

**Output**:
```typescript
interface MemoryListData {
  items: {
    namespace: string
    key: string
    valueText?: string
    tags: string[]
    status: string
    updatedAt: string
  }[]
  total: number
  hasMore: boolean
}
```

**Config**: costTier=cheap, maxTokens=800, ttl=5min

---

## 5. Policies

### 5.1 memory-write-guard

```typescript
const memoryWriteGuard = defineGuardPolicy({
  id: 'memory-write-guard',
  match: (ctx) => ctx.tool === 'memory.put' || ctx.tool === 'memory.update',
  decide: async (ctx, runtime) => {
    const { namespace, sensitivity, requireConfirmation } = ctx.args

    // Validate key format
    if (!isValidKey(ctx.args.key)) {
      return { action: 'deny', reason: 'Invalid key format' }
    }

    // Check value size
    if (JSON.stringify(ctx.args.value).length > 10240) {
      return { action: 'deny', reason: 'Value exceeds 10KB limit' }
    }

    // Require confirmation for sensitive writes
    const needsConfirmation =
      requireConfirmation ??
      namespace === 'user' ||
      sensitivity === 'sensitive'

    if (needsConfirmation) {
      return { action: 'ask', message: `Store "${ctx.args.key}" in ${namespace}?` }
    }

    return { action: 'allow' }
  }
})
```

### 5.2 memory-read-audit

```typescript
const memoryReadAudit = defineObservePolicy({
  id: 'memory-read-audit',
  match: (ctx) => ctx.source?.startsWith('memory.'),
  observe: (ctx, runtime) => {
    runtime.trace.addEvent({
      type: 'memory.read',
      data: {
        source: ctx.source,
        params: ctx.params,
        resultCount: ctx.result?.data?.results?.length ?? (ctx.result?.data?.found ? 1 : 0)
      }
    })
  }
})
```

---

## 6. kv-memory Pack

**Components**:
- Tools: memoryPut, memoryDelete, memoryUpdate
- Context Sources: memoryGet, memorySearch, memoryList
- Policies: memoryWriteGuard, memoryReadAudit

**promptFragment**:
```
## Memory Storage (Key-Value)

### Writing to Memory
Use `memory.put` tool to store information:
```json
{
  "tool": "memory.put",
  "args": {
    "namespace": "user",
    "key": "preference.code_style",
    "value": { "indent": 2, "quotes": "single" },
    "valueText": "Use 2-space indent and single quotes",
    "tags": ["code", "style"]
  }
}
```

### Reading from Memory
Use ctx.get to retrieve:
- `ctx.get("memory.get", { namespace: "user", key: "preference.code_style" })`
- `ctx.get("memory.search", { query: "code style indent" })`
- `ctx.get("memory.list", { namespace: "user" })`

### Namespaces
- `user`: User preferences and settings (requires confirmation)
- `project`: Project-specific configuration
- `session`: Temporary session data (auto-expires)

### Guidelines
- Only use `memory.put` when user explicitly asks to remember something
- Check existing memory with `memory.search` before creating duplicates
- Use descriptive `valueText` for searchability
- Add relevant `tags` for categorization
```

---

## 7. Implementation Order

### Phase 1: Storage Layer
1. Create `src/types/memory.ts` - Type definitions
2. Create `src/core/memory-storage.ts` - FileMemoryStorage implementation
3. Add memory storage initialization to runtime

### Phase 2: Tools
1. Create `src/tools/memory-put.ts`
2. Create `src/tools/memory-delete.ts`
3. Create `src/tools/memory-update.ts`
4. Update `src/tools/index.ts`

### Phase 3: Context Sources
1. Create `src/context-sources/memory-get.ts`
2. Create `src/context-sources/memory-search.ts`
3. Create `src/context-sources/memory-list.ts`
4. Update `src/context-sources/index.ts`

### Phase 4: Policies
1. Create `src/policies/memory-write-guard.ts`
2. Create `src/policies/memory-read-audit.ts`
3. Update `src/policies/index.ts`

### Phase 5: Pack Integration
1. Create `src/packs/kv-memory.ts`
2. Update `src/packs/index.ts`

### Phase 6: Testing
1. Unit tests for FileMemoryStorage
2. Unit tests for each tool
3. Unit tests for each context source
4. Integration tests with agent loop
5. Policy enforcement tests

---

## 8. Usage Example

**User**: "Remember this: always use 2-space indentation in this project."

**Model Actions**:

```
Step 1: Store the preference
──────────────────────────────
{
  "tool": "memory.put",
  "args": {
    "namespace": "project",
    "key": "code.indentation",
    "value": { "spaces": 2 },
    "valueText": "Always use 2-space indentation",
    "tags": ["code", "style", "formatting"]
  }
}

Result: { "success": true, "id": "mem_abc123", "key": "project:code.indentation" }

Step 2: Confirm to user
──────────────────────────────
"I've saved this preference. I'll use 2-space indentation for all code in this project."
```

**Later in the session**:

```
Step 1: Check formatting preferences
──────────────────────────────────────
ctx.get("memory.search", { query: "indentation formatting", namespace: "project" })

Result:
- [project:code.indentation] score=0.95
  "Always use 2-space indentation"
  Tags: code, style, formatting

Step 2: Apply preference when writing code
──────────────────────────────────────────
(Model uses 2-space indentation based on retrieved memory)
```

---

## 9. Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Storage backend | File-based JSON | Zero deps, debuggable, sufficient for <1K items |
| Read/Write separation | Tool + ContextSource | Clean semantics, proper side-effect handling |
| Namespace requirement | Required field | Clear ownership, easy policy rules |
| Default confirmation | true for user namespace | Prevent model from auto-writing user prefs |
| Soft delete | Default behavior | Audit trail, recoverable |
| Index strategy | In-memory inverted index | Simple, fast for keyword search |

---

## 10. Performance Characteristics

| Operation | Complexity | Expected Time (1K items) |
|-----------|------------|--------------------------|
| `get` | O(1) | <1ms |
| `put` | O(n) write | <10ms |
| `search` | O(k) index lookup | <5ms |
| `list` | O(m) filter | <5ms |
| `init` (load) | O(n) | <50ms |

---

## 11. Future Enhancements

1. **SQLite backend**: For >5K items or concurrent access
2. **Semantic search**: Add embedding vectors for similarity search
3. **Cross-project memory**: Share user preferences across projects
4. **Memory sync**: Cloud backup and sync
5. **Encryption**: Encrypt sensitive items at rest
6. **Compression**: Compress history.jsonl over time

---

## 12. Comparison with Other Plans

| Aspect | KV-MEMORY (this) | SESSION-MEMORY | DOCS |
|--------|------------------|----------------|------|
| **Purpose** | Explicit storage | Conversation history | Document retrieval |
| **Write source** | Model via tool | Auto-captured | CLI indexer |
| **Data structure** | Key-value pairs | Messages + facts | Documents + chunks |
| **Persistence** | Cross-session | Cross-session | Project lifetime |
| **Primary use** | "Remember X" | "What did we discuss?" | "Find relevant docs" |

All three are **complementary** and can be used together in the same agent.

---

## 13. Validation Steps

1. Build project: `npm run build`
2. Initialize storage: Verify `.agent-foundry/memory/` created
3. Test `memory.put`: Store a test item
4. Verify file: `cat .agent-foundry/memory/items.json`
5. Test `memory.get`: Retrieve the item
6. Test `memory.search`: Search by keyword
7. Test `memory.list`: List all items
8. Test policy: Verify confirmation required for user namespace
9. Test TTL: Create item with ttlDays, verify expiration
10. Integration test: Full agent loop with memory operations
