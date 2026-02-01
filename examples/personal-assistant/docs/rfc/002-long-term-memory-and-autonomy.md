# RFC-002: Long-Term Memory & Autonomous Behavior

**Status**: Draft
**Author**: Captain
**Date**: 2026-02-01
**Depends on**: RFC-001 (Personal Assistant Desktop App)

## 1. Motivation

RFC-001 delivers a functional personal assistant with Notes, Docs, and conversational email access. But it operates session-by-session — each conversation starts nearly from scratch, with only pinned notes and kvMemory providing continuity.

A truly useful personal assistant must **remember you** over months and years. It should know your preferences, recall past conversations, learn your workflows, and act proactively — not just respond to prompts.

This RFC addresses three capabilities:

1. **Long-term Memory** — the assistant remembers and retrieves relevant context from its entire history with you
2. **User Profile** — an evolving, agent-maintained model of who you are
3. **Scheduled Actions** — the assistant can do things proactively without being prompted

---

## 2. Design Philosophy

### 2.1 Markdown is Canonical

> **The files are the source of truth.** No opaque database, no hidden state.

All memory is stored as plain Markdown files on disk. This means:

- **Human-readable**: open any memory file in a text editor and understand what the agent knows
- **Git-trackable**: version-control the assistant's knowledge, diff changes, roll back mistakes
- **User-controllable**: edit, delete, or reorganize memory files at any time
- **Tool-reusable**: the agent manages memory with the same `read`/`write`/`edit` tools from the `safe` pack — zero new memory-specific tools needed for basic operations
- **Rebuildable**: if the search index is lost, regenerate it from the Markdown source

SQLite is used **only** as a derived search index (FTS5 + optional vector embeddings). It is a cache, never the source of truth. If deleted, it is rebuilt from Markdown on next startup.

### 2.2 Three Concepts in the UI, One Invisible Layer

| Concept | Storage | Visible in UI? | Managed by |
|---------|---------|----------------|------------|
| Notes | JSON files in `notes/` | Yes — left sidebar | User + Agent |
| Docs | JSON files in `docs/` | Yes — left sidebar | User + Agent |
| Memory | Markdown files in `memory/` | No (but human-readable on disk) | Agent only |

### 2.3 Contrast with RFC-002 v1

The previous draft proposed SQLite tables (`episodes`, `facts`, `procedures`) as primary storage. This revision replaces that with Markdown files, informed by the Clawdbot reference architecture. Key differences:

| Aspect | v1 (SQLite) | v2 (Markdown) |
|--------|-------------|---------------|
| Primary storage | SQLite tables | `.md` files on disk |
| Human-readable | No | Yes |
| Git-trackable | No | Yes |
| User can edit | Needs SQL/UI | Open in any editor |
| Agent tools needed | 4 new memory tools | Existing `read`/`write`/`edit` |
| Search | SQL queries | Hybrid FTS5 + vector (derived index) |
| Rebuild from scratch | Not possible | Delete index → rebuild from `.md` |

---

## 3. Memory File Layout

```
.personal-assistant/
├── MEMORY.md                    # Curated long-term memory (agent-maintained)
├── USER.md                      # User profile (agent-maintained)
├── memory/
│   ├── 2026-02-01.md           # Daily log — append-only journal
│   ├── 2026-02-02.md
│   ├── ...
│   └── consolidation.log       # Plaintext log of consolidation runs
├── cache/
│   └── memory-index.sqlite     # Derived search index (FTS5 + vectors)
├── notes/                       # (from RFC-001)
├── docs/                        # (from RFC-001)
└── sessions/                    # (from RFC-001)
```

### 3.1 MEMORY.md — Long-term Curated Knowledge

The agent's distilled, durable knowledge. Periodically updated by reviewing daily logs and extracting what's worth keeping. Structure:

```markdown
# Memory

## Preferences
- Prefers concise answers with code examples over explanations
- Likes dark mode
- Communication: reply in the same language as the user's message

## Corrections
- Email DB: `internal_date` is in milliseconds since epoch, not seconds
- The project is called "AgentFoundry", not "Agent Foundry"

## Relationships
- John (john@company.com) — boss, reports to directly
- Alice — wife, birthday March 15

## Work
- Current project: AgentFoundry — AI agent framework
- Uses TypeScript, Electron, React
- Team: 3 engineers + 1 PM

## Workflows
- "Check email" → scan for urgent messages, summarize top 5 by sender
- "Morning briefing" → check email + review today's calendar + pending todos
```

**Rules:**
- Only loaded in the main session (security boundary — never injected into shared/exported contexts)
- Agent updates via `edit` tool — never full rewrites, always surgical edits
- Maximum recommended size: ~20,000 chars (truncated at bootstrap if larger)

### 3.2 USER.md — User Profile

A focused subset of MEMORY.md containing identity information. Injected into every session as bootstrap context.

```markdown
# User Profile

- Name: Captain
- Role: Software engineer
- Timezone: UTC+8
- Languages: Chinese (primary), English (fluent)
- Email: captain@example.com
```

**Why separate from MEMORY.md?** USER.md is always injected (small, stable). MEMORY.md is larger and may be truncated. Separating them ensures core identity is never lost to truncation.

### 3.3 Daily Logs — memory/YYYY-MM-DD.md

Append-only journal entries written throughout each day. Raw, unfiltered notes: decisions, events, context, things the agent learned.

```markdown
# 2026-02-01

## 14:23 — Email query about quarterly report
- User asked for emails from CFO about Q4 report
- Found 3 emails, user said the Dec 15 one was the important one
- Saved summary as Note: "Q4 Report Key Points"

## 15:10 — Document processing
- User dropped marketing-plan.pdf into Docs
- Extracted 47 pages, key sections: budget, timeline, KPIs
- User corrected: "The deadline is March 1, not March 15"

## 16:45 — Preference learned
- User explicitly said: "Always show me email subjects in a table format"
```

**Rules:**
- Agent appends via `write` (append mode) or `edit`
- Today's log + yesterday's log are read at every session start for recency
- Older logs are not loaded directly — accessed via search index
- No size limit per file, but typical day is 1-5 KB

---

## 4. Bootstrap Context (Injected Every Session)

On every new session or restart, the following files are read and injected into the agent's context:

| File | Purpose | Max chars | Always loaded? |
|------|---------|-----------|---------------|
| `USER.md` | Core identity | 5,000 | Yes |
| `MEMORY.md` | Curated knowledge | 20,000 | Yes (main session only) |
| `memory/{today}.md` | Today's log | 10,000 | Yes |
| `memory/{yesterday}.md` | Yesterday's log | 10,000 | Yes |

Total bootstrap budget: **~3,000 tokens** (assuming ~15 chars/token).

### 4.1 Implementation via Context Pipeline

Bootstrap files are injected as **pinned ContextSelections** in the existing context pipeline:

```typescript
function buildBootstrapSelections(projectPath: string): ContextSelection[] {
  const files = [
    { path: 'USER.md', maxChars: 5000 },
    { path: 'MEMORY.md', maxChars: 20000 },
    { path: `memory/${today()}.md`, maxChars: 10000 },
    { path: `memory/${yesterday()}.md`, maxChars: 10000 },
  ]

  return files
    .filter(f => existsSync(join(projectPath, PATHS.root, f.path)))
    .map(f => ({
      type: 'custom' as const,
      ref: `bootstrap:${f.path}`,
      resolve: async () => {
        let content = readFileSync(join(projectPath, PATHS.root, f.path), 'utf-8')
        if (content.length > f.maxChars) {
          content = content.slice(0, f.maxChars) + '\n\n... (truncated)'
        }
        return {
          source: `bootstrap:${f.path}`,
          content,
          tokens: countTokens(content)
        }
      }
    }))
}
```

This integrates cleanly with RFC-001's existing `buildEntitySelections()` — both return `ContextSelection[]` arrays that merge in the pinned phase.

---

## 5. Memory Search — `packs.memorySearch()`

### 5.1 Why a Framework-Level Pack

Any long-running AgentFoundry app will want to search over Markdown files. This isn't personal-assistant-specific — it's a general capability. Therefore it belongs in the framework as `packs.memorySearch()`.

### 5.2 What We Already Have

AgentFoundry already has significant infrastructure to build on:

| Existing component | Location | What it does | Reuse in memorySearch |
|---|---|---|---|
| `FileDocsIndexer` | `src/core/docs-indexer.ts` | Token-based chunking, keyword extraction, hash-based change detection, incremental updates | Reuse chunking logic and hash-based change detection directly |
| `DocsIndex` types | `src/types/docs.ts` | `DocChunk`, `DocumentEntry`, `DocsSearchResult`, `DocsSearchMode` (includes 'hybrid') | Extend types for embedding support |
| `docs-search` context source | `src/context-sources/docs-search.ts` | Keyword search with previews, score rendering | Reference for tool output format |
| `tokenizer` | `src/utils/tokenizer.ts` | Token counting with model calibration, CJK support | Use for chunk sizing |
| `index-docs` CLI | `src/cli/index-docs.ts` | Configurable chunk-size, overlap, incremental mode | Reference for CLI interface |

**What's missing:** SQLite storage (currently uses JSON), FTS5, vector embeddings, file watching, hybrid merge algorithm.

### 5.3 What It Provides

Two tools exposed to the agent:

```typescript
// Hybrid search over memory files (BM25 + optional vector)
'memory_search': {
  parameters: {
    query: string,           // natural language query
    limit?: number,          // max results (default 10)
    source?: string          // restrict by source: 'memory' | 'sessions' | 'all' (default 'all')
  }
  // Returns: ranked snippets with file path, line range, score, provider info
}

// Read specific lines from a memory file (for follow-up after search)
'memory_get': {
  parameters: {
    path: string,            // relative to project root
    from?: number,           // start line (default 1)
    lines?: number           // number of lines (default 50)
  }
}
```

### 5.4 New Dependency: `better-sqlite3`

The MCP-based `packs.sqlite()` is too heavy for a search index (spawns a subprocess, stdio protocol, MCP overhead). The search index needs low-latency, in-process access.

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

`better-sqlite3` provides:
- FTS5 built-in (no extension needed)
- `sqlite-vec` extension loading for hardware-accelerated vector distance (optional)
- Synchronous API — fast for index reads
- WAL mode — safe for concurrent reads during writes

**This is the only new npm dependency RFC-002 introduces.**

### 5.5 SQLite Schema

Single database at `cache/memory-index.sqlite`:

```sql
-- Index metadata: detect when full reindex is needed
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'provider', 'model', 'chunk_size', 'chunk_overlap', 'dimensions', 'version'

-- Tracked files: hash-based change detection (same pattern as docs-indexer.ts)
CREATE TABLE files (
  path TEXT PRIMARY KEY,       -- relative to project root
  source TEXT NOT NULL,        -- 'memory' | 'sessions'
  hash TEXT NOT NULL,          -- SHA256 substring (same as computeHash in docs-indexer)
  mtime INTEGER NOT NULL,      -- file mtime in ms
  size INTEGER NOT NULL
);

-- Chunks: the main content table
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,          -- generated chunk ID (same pattern as generateChunkId)
  path TEXT NOT NULL,           -- source file path
  source TEXT NOT NULL,         -- 'memory' | 'sessions'
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,           -- content hash for embedding cache lookup
  text TEXT NOT NULL,           -- chunk text content
  updated_at TEXT NOT NULL
);

-- Embedding cache: avoids re-embedding unchanged text
CREATE TABLE embedding_cache (
  hash TEXT NOT NULL,           -- content hash
  provider TEXT NOT NULL,       -- 'openai' | 'local'
  model TEXT NOT NULL,          -- model identifier
  embedding TEXT NOT NULL,      -- JSON array of floats
  updated_at TEXT NOT NULL,
  PRIMARY KEY (hash, provider, model)
);

-- FTS5 virtual table for BM25 keyword search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,                         -- chunk text (searchable)
  id UNINDEXED,                 -- chunk ID (for joining)
  path UNINDEXED,               -- file path
  source UNINDEXED,             -- source type
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- Vector search virtual table (created lazily when first embeddings arrive)
-- Requires sqlite-vec extension; skipped if not available
-- CREATE VIRTUAL TABLE chunks_vec USING vec0(
--   id TEXT PRIMARY KEY,
--   embedding FLOAT[N]            -- N = dimension of embedding model
-- );

CREATE INDEX idx_chunks_path ON chunks(path);
CREATE INDEX idx_chunks_source ON chunks(source);
CREATE INDEX idx_embedding_cache_updated ON embedding_cache(updated_at);
```

### 5.6 Indexing Pipeline

```
Source files:  MEMORY.md + USER.md + memory/**/*.md (+ optionally sessions/*.jsonl)
                ↓
Change detect: Compare file hash against `files` table (reuse computeHash from docs-indexer)
                ↓
Chunking:      ~400 tokens, 80-token overlap (reuse chunkDocument from docs-indexer,
               adjusted for Markdown-aware splitting)
                ↓
FTS5:          INSERT INTO chunks_fts for each new/changed chunk
                ↓
Embeddings:    Check embedding_cache by content hash
               → Cache hit: reuse stored embedding
               → Cache miss: call embedding provider, store in cache
               → Insert into chunks_vec (if sqlite-vec available)
                ↓
Cleanup:       Delete chunks/FTS/vector entries for removed files
```

#### File Watching

New dependency: `chokidar` (or use Node.js `fs.watch` with debouncing).

```typescript
// Watch memory files for changes
const watcher = chokidar.watch([
  join(memoryDir, '**/*.md'),
  join(projectRoot, 'MEMORY.md'),
  join(projectRoot, 'USER.md')
], {
  ignoreInitial: true,
  awaitWriteStability: 1500  // debounce 1.5s
})

watcher.on('all', () => {
  markDirty()  // next search or interval will trigger reindex
})
```

#### Incremental Update Algorithm

```typescript
async function sync(db: Database): Promise<void> {
  const currentFiles = scanMemoryFiles()      // glob memory/**/*.md + MEMORY.md + USER.md
  const indexedFiles = db.prepare('SELECT path, hash FROM files').all()
  const indexedMap = new Map(indexedFiles.map(f => [f.path, f.hash]))

  // Find changed/new files
  for (const file of currentFiles) {
    const hash = computeHash(readFileSync(file.path, 'utf-8'))
    if (indexedMap.get(file.relativePath) === hash) continue  // unchanged

    // Re-chunk and re-index this file
    const content = readFileSync(file.path, 'utf-8')
    const chunks = chunkMarkdown(content, 400, 80)

    // Delete old chunks for this file
    db.prepare('DELETE FROM chunks WHERE path = ?').run(file.relativePath)
    db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(file.relativePath)
    // if vector table exists: delete from chunks_vec too

    // Insert new chunks
    for (const chunk of chunks) {
      db.prepare('INSERT INTO chunks ...').run(chunk)
      db.prepare('INSERT INTO chunks_fts ...').run(chunk)
      // Embed + insert into chunks_vec (batch, async)
    }

    // Update files table
    db.prepare('INSERT OR REPLACE INTO files ...').run(file)
  }

  // Clean up deleted files
  for (const [path] of indexedMap) {
    if (!currentFiles.find(f => f.relativePath === path)) {
      db.prepare('DELETE FROM files WHERE path = ?').run(path)
      db.prepare('DELETE FROM chunks WHERE path = ?').run(path)
      db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(path)
    }
  }
}
```

#### Safe Reindex on Config Change

When embedding model or chunking params change (detected via `meta` table), do a full reindex:

1. Create temp database `memory-index.sqlite.tmp`
2. Index all files into temp DB
3. Atomically rename: backup old → rename tmp → done
4. If reindex fails, restore from backup

Same pattern as Clawdbot. Prevents corrupted indexes.

### 5.7 Hybrid Search Algorithm

```typescript
function search(db: Database, query: string, options: SearchOptions): SearchResult[] {
  const { limit = 10, candidateMultiplier = 4, source } = options
  const pool = limit * candidateMultiplier

  // Step 1: BM25 keyword search via FTS5
  const ftsQuery = tokenizeForFTS(query)  // quote each token, join with AND
  let ftsResults = db.prepare(`
    SELECT id, path, source, start_line, end_line, text,
           bm25(chunks_fts) as bm25_rank
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ${source ? 'AND source = ?' : ''}
    ORDER BY bm25_rank
    LIMIT ?
  `).all(ftsQuery, ...(source ? [source] : []), pool)

  // Convert BM25 rank to 0-1 score: textScore = 1 / (1 + max(0, bm25_rank))
  const textScores = new Map<string, number>()
  for (const r of ftsResults) {
    textScores.set(r.id, 1 / (1 + Math.max(0, r.bm25_rank)))
  }

  // Step 2: Vector search (if embeddings available)
  const vectorScores = new Map<string, number>()
  if (hasVectorTable(db)) {
    const queryVec = await embedQuery(query)

    // Try sqlite-vec first (hardware-accelerated)
    if (hasSqliteVec(db)) {
      const vecResults = db.prepare(`
        SELECT v.id, vec_distance_cosine(v.embedding, ?) as distance
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.id
        ${source ? 'WHERE c.source = ?' : ''}
        ORDER BY distance
        LIMIT ?
      `).all(JSON.stringify(queryVec), ...(source ? [source] : []), pool)

      for (const r of vecResults) {
        vectorScores.set(r.id, 1 - r.distance)  // cosine distance → similarity
      }
    } else {
      // JS fallback: load all embeddings, compute cosine similarity
      const allChunks = db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL').all()
      const scored = allChunks
        .map(c => ({ id: c.id, score: cosineSimilarity(queryVec, JSON.parse(c.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, pool)
      for (const s of scored) {
        vectorScores.set(s.id, s.score)
      }
    }
  }

  // Step 3: Hybrid merge
  const allIds = new Set([...textScores.keys(), ...vectorScores.keys()])
  const merged: { id: string; score: number }[] = []

  const vWeight = vectorScores.size > 0 ? options.vectorWeight ?? 0.7 : 0
  const tWeight = vectorScores.size > 0 ? options.textWeight ?? 0.3 : 1.0

  for (const id of allIds) {
    const vs = vectorScores.get(id) ?? 0
    const ts = textScores.get(id) ?? 0
    merged.push({ id, score: vWeight * vs + tWeight * ts })
  }

  merged.sort((a, b) => b.score - a.score)
  const topIds = merged.slice(0, limit).map(m => m.id)

  // Step 4: Fetch full chunk data for top results
  const results = topIds.map(id => {
    const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(id)
    const score = merged.find(m => m.id === id)!.score
    return {
      file: chunk.path,
      lines: `${chunk.start_line}-${chunk.end_line}`,
      score: Math.round(score * 100) / 100,
      snippet: chunk.text.slice(0, 300),
      source: chunk.source
    }
  })

  return results
}
```

### 5.8 Embedding Providers

```typescript
interface EmbeddingProvider {
  /** Embed a single query (for search) */
  embedQuery(text: string): Promise<number[]>
  /** Embed a batch of texts (for indexing) */
  embedBatch(texts: string[]): Promise<number[][]>
  /** Embedding dimension */
  dimensions: number
  /** Provider identifier (for cache keying) */
  providerId: string
  /** Model identifier (for cache keying) */
  modelId: string
}

interface EmbeddingConfig {
  provider: 'openai' | 'local'
  model?: string
  apiKey?: string
  /** Max tokens per batch request (default 8000) */
  batchTokenLimit?: number
}
```

**Provider implementations:**

| Provider | Model | Dimensions | Latency | Cost |
|----------|-------|-----------|---------|------|
| `openai` | `text-embedding-3-small` | 1536 | ~100ms/batch | ~$0.02/1M tokens |
| `local` | GGUF via `node-llama-cpp` | varies | ~500ms/batch | Free |

**Embedding cache** prevents re-embedding:
- Keyed by `(content_hash, provider, model)`
- On re-chunk: check cache before calling provider
- LRU eviction when cache exceeds 50,000 entries (pruned by `updated_at`)

**Batch embedding** for efficiency:
- Group chunks into batches of max `batchTokenLimit` tokens
- Single API call per batch
- Retry with exponential backoff (base 500ms, max 8s, 3 attempts, 20% jitter)
- Timeouts: remote query 60s, remote batch 2min; local query 5min, local batch 10min

### 5.9 Pack Options

```typescript
export interface MemorySearchPackOptions {
  /** Directories containing files to index (e.g. ['.personal-assistant/memory', '.personal-assistant']) */
  paths: string[]
  /** File patterns to include (default: ['**/*.md']) */
  include?: string[]
  /** Path for the SQLite index file (default: '<first-path>/../cache/memory-index.sqlite') */
  indexPath?: string

  /** Embedding config. If omitted, BM25-only mode (still very useful). */
  embeddings?: EmbeddingConfig

  /** Chunking config */
  chunkSize?: number           // default: 400 tokens
  chunkOverlap?: number        // default: 80 tokens

  /** Search tuning */
  vectorWeight?: number        // default: 0.7
  textWeight?: number          // default: 0.3
  candidateMultiplier?: number // default: 4

  /** File watching (default: true) */
  watch?: boolean
  /** Debounce interval for file watcher in ms (default: 1500) */
  watchDebounce?: number

  /** Tool name prefix (default: 'memory') → tools: memory_search, memory_get */
  toolPrefix?: string
}
```

### 5.10 Graceful Degradation Chain

```
Level 1: Full hybrid (vector + BM25)
  ↓ embeddings not configured or provider fails
Level 2: BM25-only (FTS5 keyword search)
  ↓ better-sqlite3 not installed or index DB corrupted
Level 3: Fallback to existing FileDocsIndexer (JSON keyword index)
  ↓ no index at all
Level 4: Bootstrap files only (MEMORY.md + daily logs injected at session start)
```

The assistant always has some memory — the question is how precise the retrieval is.

### 5.11 Framework Changes Required

**New files:**

| File | Purpose |
|------|---------|
| `src/core/memory-index.ts` | SQLite-backed FTS5+vector index engine (the core) |
| `src/core/embedding-provider.ts` | Pluggable embedding provider interface + implementations |
| `src/packs/memory-search.ts` | Pack wrapper: creates `memory_search` + `memory_get` tools, manages lifecycle |

**Modified files:**

| File | Change |
|------|--------|
| `src/packs/index.ts` | Add `memorySearch` export |
| `package.json` | Add `better-sqlite3` dependency, optional `chokidar` peer dependency |
| `src/types/docs.ts` | Add `DocsSearchMode = 'hybrid'` support (already typed but not implemented) |

**Reused from existing code:**

| Source | What we reuse |
|--------|--------------|
| `docs-indexer.ts` → `chunkDocument()` | Chunking logic (token-based, with overlap) — adapt for memory context |
| `docs-indexer.ts` → `computeHash()` | SHA256 hash for change detection |
| `docs-indexer.ts` → `tokenize()` | Keyword extraction + stop word filtering (basis for FTS query building) |
| `docs-indexer.ts` → `parseMarkdown()` | Title/outline extraction for structured chunks |
| `utils/tokenizer.ts` → `countTokens()` | Accurate token estimation for chunk sizing |

---

## 6. Memory Lifecycle

```
  Write                     Index                     Search
  ─────                     ─────                     ──────
  Agent appends to     →    File watcher triggers  →  Agent calls
  daily log via             async reindex of           memory_search
  write/edit tools          changed files              for retrieval
       │                                                    │
       │              Reflect (Heartbeat)                    │
       │              ───────────────────                    │
       └──────────→   Scheduled task reviews  ←─────────────┘
                      daily logs, curates
                      MEMORY.md + USER.md
                           │
                      Inject (Bootstrap)
                      ──────────────────
                      Next session loads
                      MEMORY.md + USER.md
                      + today/yesterday logs
```

### 6.1 Write Phase

The agent writes to daily logs during normal conversation using existing tools:

```
Agent: I learned that the user prefers table format for email summaries.
       Let me record this.

→ edit({ path: ".personal-assistant/memory/2026-02-01.md",
         append: "\n## 16:45 — Preference learned\n- User prefers email subjects in table format\n" })
```

No new tools needed. The system prompt instructs the agent when and how to write memory entries.

### 6.2 Index Phase

The `memorySearch` pack watches for file changes:

1. File system watcher detects change to any `.md` file in `memory/`, `MEMORY.md`, or `USER.md`
2. After 1.5s debounce, re-chunk the changed file
3. Update FTS5 index + re-embed changed chunks
4. Embedding cache avoids re-embedding unchanged chunks

### 6.3 Search Phase

Before or during a conversation, the agent can search its own memory:

```
User: "What did we discuss about the Q4 report?"

Agent thinks: Let me search my memory.
→ memory_search({ query: "Q4 report quarterly" })

Result: [
  { file: "memory/2026-02-01.md", lines: "5-9", score: 0.87,
    snippet: "User asked for emails from CFO about Q4 report..." },
  { file: "MEMORY.md", lines: "23-25", score: 0.72,
    snippet: "## Work\n- Q4 report deadline: March 1..." }
]
```

### 6.4 Reflect Phase (Heartbeat)

A scheduled task (see section 8) periodically reviews recent daily logs and curates MEMORY.md:

```
Heartbeat instruction:
  1. Read daily logs from the past 7 days
  2. Extract durable facts, preferences, corrections, and relationships
  3. Update MEMORY.md — add new entries, update changed ones, remove outdated ones
  4. Update USER.md if identity information changed
  5. Do NOT duplicate what's already in MEMORY.md
```

This is an agent task using existing tools (read, edit). No special consolidation pipeline needed — the LLM does the curation.

### 6.5 Inject Phase (Bootstrap)

On session start, the context pipeline loads bootstrap files (section 4). This ensures the agent always has recent context without needing to search.

---

## 7. Pre-Compaction Memory Flush

### 7.1 The Problem

Long conversations approach the context window limit. When compaction occurs, older messages are summarized and the originals discarded. Any context the agent hasn't written to disk is lost.

### 7.2 Solution

Before compaction, the agent gets one silent turn to save important context:

```typescript
// In the agent loop, when context approaches limit:
onPreCompaction: async (agent) => {
  await agent.run(
    '[SYSTEM] Context approaching limit. Review the conversation and write any ' +
    'important context, decisions, facts, or preferences to today\'s daily log ' +
    'before compaction occurs. Use edit() to append to the daily log file.',
    { silent: true }  // invisible to the user
  )
}
```

### 7.3 Framework Change Required

Add an `onPreCompaction` callback to the agent configuration:

```typescript
createAgent({
  // ...existing config...
  onPreCompaction?: (agent: Agent) => Promise<void>
})
```

Triggered when token estimate crosses `contextWindow - reserveTokensFloor - softThresholdTokens`. One flush per compaction cycle. This is a **small framework change** — adding a hook point in the agent loop.

---

## 8. Scheduled Actions & Proactive Behavior

### 8.1 Scheduler Design

A 24/7 assistant should execute scheduled tasks without user prompting. The scheduler lives in the Electron main process.

```typescript
interface ScheduledTask {
  id: string
  /** Cron expression */
  schedule: string              // "0 8 * * *" (daily at 8am)
  /** What the agent should do */
  instruction: string           // "Check email for urgent messages and notify me"
  enabled: boolean
  lastRunAt?: string
  createdBy: 'user' | 'agent'
  createdAt: string
}
```

**Storage:** `scheduled-tasks.json` in `.personal-assistant/` (Markdown not needed here — this is structured config, not knowledge).

### 8.2 Scheduler Tools

```typescript
'schedule-add': {
  parameters: {
    schedule: string,       // cron expression
    instruction: string,    // what to do
  }
}

'schedule-list': {}         // returns all active schedules

'schedule-remove': {
  parameters: { id: string }
}
```

### 8.3 Execution Model

1. Timer fires based on cron expression
2. Main process sends the task instruction to the agent as a system-initiated message
3. Agent executes normally (can use all tools including memory search, email queries, etc.)
4. Result is either:
   - Silent (agent ran, nothing to report)
   - Notification (agent found something worth telling the user)

### 8.4 Notification System

```typescript
interface AgentNotification {
  id: string
  type: 'info' | 'alert' | 'reminder'
  title: string
  body: string
  scheduledTaskId?: string
  createdAt: string
  readAt?: string
}
```

Notifications appear as a badge on the app icon and a notification panel in the UI.

### 8.5 Built-in Scheduled Tasks

These are created automatically on first launch. The user can disable or modify them.

| Schedule | Instruction | Purpose |
|----------|------------|---------|
| `0 2 * * *` | Review daily logs from past 7 days. Curate MEMORY.md and USER.md. | Heartbeat / memory consolidation |
| `0 8 * * 1-5` | Check email for urgent messages, summarize top 5. | Morning briefing |
| `0 9 * * 1` | Review todo list and pending items. Summarize for the week. | Monday review |

---

## 9. System Prompt Additions

RFC-002 adds these sections to the coordinator's system prompt (extending RFC-001's prompt):

```markdown
## Memory Management

You maintain your own memory as Markdown files:
- **Daily log**: Append notes to `memory/YYYY-MM-DD.md` throughout the conversation
- **MEMORY.md**: Curated long-term knowledge (updated during heartbeat, not during chat)
- **USER.md**: User profile (updated only when identity info changes)

### When to write to the daily log
- User states a preference or corrects you
- An important decision or outcome occurs
- You discover a fact about the user, their work, or their relationships
- The conversation covers a significant topic worth remembering

### Format for daily log entries
```
## HH:MM — Brief topic title
- Key point 1
- Key point 2
```

### When to search memory
- User references something from a past conversation
- You need context about a person, project, or preference
- Before making assumptions — check if you already know the answer

### Memory search
Use memory_search({ query }) to find relevant past context.
Use memory_get({ path, from, lines }) to read specific sections of memory files.

## Scheduled Tasks
You can create scheduled tasks that run automatically:
- schedule-add({ schedule: "cron expr", instruction: "what to do" })
- schedule-list() to see active schedules
- schedule-remove({ id }) to cancel a schedule
```

---

## 10. Context Pipeline Integration

### 10.1 Updated Phase Order

```
Phase 1: pinned       — pinned Notes + Docs (RFC-001)
Phase 2: bootstrap    — USER.md + MEMORY.md + today/yesterday logs  [NEW]
Phase 3: selected     — user-selected entities (RFC-001)
Phase 4: session      — session memory / kvMemory (RFC-001)
Phase 5: mentions     — @-mention resolved content (RFC-001)
```

### 10.2 Token Budget

| Phase | Budget | Contents |
|-------|--------|----------|
| pinned | ~2,000 tokens | Pinned Notes + Docs |
| bootstrap | ~3,000 tokens | USER.md + MEMORY.md + daily logs |
| selected | ~2,000 tokens | User-selected entities |
| session | ~1,000 tokens | kvMemory items |
| mentions | ~2,000 tokens | @-mention content |
| **Total context overhead** | **~10,000 tokens** | |

This leaves the vast majority of the context window for conversation history and tool results.

---

## 11. Crash Resilience

### 11.1 Principles

- **Markdown files are crash-safe** — worst case, a partial append to the daily log (easily recoverable)
- **Search index is rebuildable** — delete `memory-index.sqlite`, it regenerates from `.md` files
- **Episode save is incremental** — daily log is appended to throughout the conversation, not just at the end
- **No in-memory-only state** — everything important is on disk as files the user can inspect

### 11.2 Recovery from Mid-Conversation Crash

1. On restart, check for unsaved chat messages in the session store
2. Load bootstrap files (USER.md, MEMORY.md, today's log) — they reflect the most recent state
3. Agent resumes naturally — the daily log contains everything written before the crash
4. If the pre-compaction flush didn't complete, the only loss is un-flushed working memory from the current conversation

---

## 12. Model Agnosticism

### 12.1 Rules

- **Store plain text Markdown**, never model-specific tokens or formats
- **Search index embeddings are a cache** — rebuildable with any embedding model
- **Consolidation/heartbeat prompts are natural language** — work with any LLM
- **No dependency on specific model capabilities** — the system works with basic read/write/edit tools

When the underlying LLM changes (which it will over years), memory files require zero migration. Only the embedding cache needs regeneration (automatic on startup if model changes).

---

## 13. Storage Budget

Target: **< 50 MB per year** (Markdown is more compact than SQLite for text data).

| Component | Growth rate | 1 year estimate |
|-----------|------------|-----------------|
| Daily logs | ~2-5 KB/day | ~1-2 MB |
| MEMORY.md | Slow growth, pruned by heartbeat | < 100 KB |
| USER.md | Nearly static | < 5 KB |
| Search index (FTS5) | Proportional to text | ~5 MB |
| Embedding vectors (optional) | ~1 KB per chunk | ~10 MB |
| **Total** | | **~15-20 MB/year** |

---

## 14. Framework Changes Summary

| Change | Scope | Files |
|--------|-------|-------|
| **`packs.memorySearch()`** | New pack — hybrid FTS5+vector search over Markdown files | `src/packs/memory-search.ts` |
| **`MemoryIndex` engine** | Core indexing engine: SQLite FTS5, embedding cache, file watcher, incremental sync | `src/core/memory-index.ts` |
| **`EmbeddingProvider`** | Pluggable embedding interface + OpenAI/local implementations | `src/core/embedding-provider.ts` |
| **`onPreCompaction` hook** | New callback in agent config — silent turn before compaction | `src/agent/agent-loop.ts` |
| **Pack export** | Add `memorySearch` to pack namespace | `src/packs/index.ts` |
| **Dependency** | `better-sqlite3` for in-process SQLite with FTS5 | `package.json` |
| **Optional dependency** | `chokidar` for file watching (can fall back to `fs.watch`) | `package.json` (peer dep) |

**3 new files, 2 modified files, 1-2 new dependencies.** Everything else — daily logs, MEMORY.md, USER.md, bootstrap injection, heartbeat consolidation, scheduler — is application-layer code using existing AgentFoundry primitives (primarily the `safe` pack's read/write/edit tools).

---

## 15. Implementation Phases

### Phase A: Memory Files + Bootstrap Injection

- Create `MEMORY.md`, `USER.md`, `memory/` directory structure on first launch
- Add `buildBootstrapSelections()` to coordinator's context assembly
- Update system prompt with memory management instructions
- Agent writes daily logs via existing `write`/`edit` tools
- Agent updates MEMORY.md/USER.md via existing `edit` tool
- **No framework changes. No new tools. Just files + prompt engineering.**

### Phase B: Memory Search Pack — BM25 Only (Framework)

- Add `better-sqlite3` dependency to framework
- Create `src/core/memory-index.ts`:
  - SQLite schema (meta, files, chunks, chunks_fts)
  - `sync()` — incremental file scanning, hash comparison, chunking, FTS5 indexing
  - `search()` — BM25-only search via FTS5 MATCH + bm25() ranking
  - `get()` — read specific lines from a file
  - Reuse `chunkDocument()`, `computeHash()`, `tokenize()` from `docs-indexer.ts`
- Create `src/packs/memory-search.ts`:
  - Wraps MemoryIndex as a pack with `memory_search` + `memory_get` tools
  - File watcher (chokidar or fs.watch with debounce) for auto-reindex
  - Pack lifecycle: init → sync → watch; destroy → close watcher + DB
- Export from `src/packs/index.ts`
- Wire into personal-assistant coordinator
- **BM25-only is already very useful** — handles exact names, dates, code, keywords

### Phase C: Pre-Compaction Flush (Framework)

- Add `onPreCompaction` hook to agent loop in `src/agent/agent-loop.ts`
- Trigger: when token estimate crosses `contextWindow - reserveTokensFloor - softThresholdTokens`
- One flush per compaction cycle
- Wire coordinator to use it: silent turn saves context to daily log before compaction

### Phase D: Heartbeat + Scheduler (Application)

- Implement scheduler in Electron main process (cron-based, persisted to `scheduled-tasks.json`)
- `schedule-add`, `schedule-list`, `schedule-remove` tools (application-layer, defined via `defineTool`)
- Built-in heartbeat task: nightly review of daily logs → curate MEMORY.md
- Notification system (badge + panel)

### Phase E: Embedding Search — Hybrid Mode (Framework)

- Create `src/core/embedding-provider.ts`:
  - `EmbeddingProvider` interface with `embedQuery()` and `embedBatch()`
  - OpenAI provider (`text-embedding-3-small`)
  - Local provider (GGUF via `node-llama-cpp`, optional peer dependency)
  - Embedding cache (keyed by content hash + provider + model)
  - Batch embedding with retry + exponential backoff
- Extend `MemoryIndex`:
  - `embedding_cache` table + `chunks_vec` virtual table (sqlite-vec, lazy creation)
  - Hybrid merge: `score = 0.7 * vectorScore + 0.3 * textScore`
  - JS cosine similarity fallback if sqlite-vec not available
- Safe reindex on config change (model/provider change → temp DB → atomic swap)
- **This phase is optional** — defer until BM25-only proves insufficient

---

## 16. Open Questions

1. **MEMORY.md visibility in UI**: Should we add a read-only "Memory" panel in the UI that renders MEMORY.md? (Nice for trust, but not essential — user can open the file directly)
2. **Memory search in context pipeline**: Should `memory_search` be called automatically before each turn (like Clawdbot's implicit retrieval), or only when the agent decides to? (Recommend: agent decides — saves tokens and latency on simple queries)
3. **Daily log granularity**: One file per day, or one file per conversation session? (Recommend: per day — simpler, matches calendar, and multiple conversations in a day get grouped naturally)
4. **Heartbeat cost**: Nightly heartbeat requires an LLM call. Use the main model or a cheaper one? (Recommend: cheap model — haiku/gpt-4o-mini — for consolidation tasks)
5. **Privacy boundary**: Should MEMORY.md be excluded from certain contexts (e.g., if the app is ever used in shared mode)? (Yes — follow Clawdbot's pattern: MEMORY.md only in private sessions)
6. **Memory file conflict**: If the user manually edits MEMORY.md while the agent is running, how do we handle it? (File watcher detects change → reindex. Agent reads latest on next access. No locking needed for Markdown files.)
