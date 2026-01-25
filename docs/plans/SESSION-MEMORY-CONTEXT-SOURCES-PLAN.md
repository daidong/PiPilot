# Session & Memory Context Sources Implementation Plan

## Overview

Implement a three-layer historical interaction management architecture that enables Agents to efficiently retrieve relevant conversation history and maintain long-term memory, rather than passively consuming entire chat logs.

## Core Problems to Solve

1. **Recent context recall**: "What did we just do?" - Model needs to know recent actions/decisions
2. **Historical search**: "Did you mention X before?" - Find specific past conversations
3. **Citable evidence**: Provide clear provenance for conclusions from conversation history
4. **Token efficiency**: Cannot fit entire history in prompt; need selective retrieval
5. **Long-term memory**: Persist facts, preferences, and decisions across sessions

## File Checklist

### New Files
| File | Description |
|------|-------------|
| `src/context-sources/session-recent.ts` | session.recent context source |
| `src/context-sources/session-search.ts` | session.search context source |
| `src/context-sources/session-thread.ts` | session.thread context source |
| `src/context-sources/memory-facts.ts` | memory.facts context source |
| `src/context-sources/memory-decisions.ts` | memory.decisions context source |
| `src/core/message-store.ts` | Persistent message storage |
| `src/core/session-index.ts` | Inverted index for session search |
| `src/core/memory-store.ts` | Facts & decisions storage |
| `src/packs/memory.ts` | memory Pack |

### Modified Files
| File | Description |
|------|-------------|
| `src/context-sources/index.ts` | Add session/memory exports |
| `src/packs/index.ts` | Add memory pack export |
| `src/types/context.ts` | Add session/memory types |
| `src/types/runtime.ts` | Add message store to runtime |

---

## 1. Storage Schema

### 1.1 Message Store (.agent-foundry/sessions/)

```
.agent-foundry/
├── sessions/
│   ├── index.json              # Session index
│   ├── {sessionId}/
│   │   ├── messages.jsonl      # Message log (append-only)
│   │   ├── index.json          # Inverted index for this session
│   │   └── meta.json           # Session metadata
│   └── current -> {sessionId}  # Symlink to active session
├── memory/
│   ├── facts.json              # Long-term facts
│   └── decisions.json          # Decisions & commitments
└── config.json                 # Storage configuration
```

### 1.2 Message Format (messages.jsonl)

```json
{
  "id": "msg_abc123",
  "sessionId": "sess_xyz789",
  "timestamp": "2024-01-15T10:30:00Z",
  "role": "user" | "assistant" | "tool",
  "content": "...",
  "toolCall": {
    "name": "read",
    "args": { "path": "..." },
    "result": { "success": true, "data": "..." }
  },
  "traceId": "trace_001",
  "step": 5,
  "tokens": 150,
  "keywords": ["file", "read", "config"]
}
```

### 1.3 Memory Fact Format (facts.json)

```json
{
  "facts": [
    {
      "id": "fact_001",
      "content": "User prefers TypeScript over JavaScript",
      "topics": ["preference", "language"],
      "confidence": "confirmed" | "inferred",
      "provenance": {
        "messageId": "msg_abc123",
        "sessionId": "sess_xyz789",
        "timestamp": "2024-01-15T10:30:00Z",
        "extractedBy": "user" | "system"
      },
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### 1.4 Memory Decision Format (decisions.json)

```json
{
  "decisions": [
    {
      "id": "dec_001",
      "content": "Use TypeScript for this project",
      "status": "active" | "deprecated" | "superseded",
      "supersededBy": null,
      "provenance": {
        "messageId": "msg_abc123",
        "sessionId": "sess_xyz789",
        "timestamp": "2024-01-15T10:30:00Z"
      },
      "createdAt": "2024-01-15T10:30:00Z",
      "deprecatedAt": null,
      "reason": null
    }
  ]
}
```

---

## 2. Context Sources Design

### 2.1 session.recent - Recent Context

**Purpose**: Provide a short view of "what happened recently" for continuation tasks

**Parameters**:
```typescript
interface SessionRecentParams {
  turns?: number          // default 10
  includeTools?: boolean  // default true
  includeResults?: boolean // include tool results, default false
  format?: 'summary' | 'full'  // default 'summary'
}
```

**Output**:
```typescript
interface SessionRecentData {
  messages: {
    id: string
    role: 'user' | 'assistant' | 'tool'
    summary: string
    timestamp: string
    toolName?: string
  }[]
  sessionId: string
  totalMessages: number
}
```

**Config**: costTier=cheap, maxTokens=800, ttl=30s

### 2.2 session.search - History Search

**Purpose**: Find relevant snippets in history by keyword or semantic query

**Parameters**:
```typescript
interface SessionSearchParams {
  query: string                              // required
  k?: number                                 // default 10
  recencyBias?: 'high' | 'medium' | 'low'   // default 'medium'
  includeTools?: boolean                     // default true
  sessionScope?: 'current' | 'all'          // default 'current'
  timeRange?: {
    from?: string  // ISO date
    to?: string
  }
}
```

**Output**:
```typescript
interface SessionSearchData {
  results: {
    messageId: string
    sessionId: string
    role: string
    snippet: string
    score: number
    timestamp: string
    keywords: string[]
  }[]
  totalMatches: number
}
```

**Implementation**:
1. Tokenize query into keywords
2. Search inverted index for matching messages
3. Apply recency bias to scores
4. Return top-k results with snippets

**Config**: costTier=medium, maxTokens=1500, ttl=1min

### 2.3 session.thread - Context Expansion

**Purpose**: Expand context around a specific message to avoid out-of-context interpretation

**Parameters**:
```typescript
interface SessionThreadParams {
  anchorMessageId: string   // required
  windowTurns?: number      // default 5 (before and after)
  includeTools?: boolean    // default true
}
```

**Output**:
```typescript
interface SessionThreadData {
  anchor: {
    id: string
    index: number
  }
  messages: {
    id: string
    role: string
    content: string
    timestamp: string
    isAnchor: boolean
  }[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}
```

**Config**: costTier=cheap, maxTokens=2000, ttl=1min

### 2.4 memory.facts - Long-term Facts

**Purpose**: Retrieve stable facts like preferences, constraints, and confirmed settings

**Parameters**:
```typescript
interface MemoryFactsParams {
  topics?: string[]    // filter by topics
  query?: string       // keyword search in content
  confidence?: 'confirmed' | 'inferred' | 'all'  // default 'all'
  limit?: number       // default 20
}
```

**Output**:
```typescript
interface MemoryFactsData {
  facts: {
    id: string
    content: string
    topics: string[]
    confidence: 'confirmed' | 'inferred'
    provenance: {
      messageId: string
      sessionId: string
      timestamp: string
    }
  }[]
  totalFacts: number
}
```

**Config**: costTier=cheap, maxTokens=1000, ttl=5min, invalidateOn=['memory:update']

### 2.5 memory.decisions - Decisions & Commitments

**Purpose**: Retrieve decisions, commitments, and constraints with status tracking

**Parameters**:
```typescript
interface MemoryDecisionsParams {
  query?: string
  status?: 'active' | 'deprecated' | 'all'  // default 'active'
  limit?: number  // default 20
}
```

**Output**:
```typescript
interface MemoryDecisionsData {
  decisions: {
    id: string
    content: string
    status: 'active' | 'deprecated' | 'superseded'
    supersededBy?: string
    provenance: {
      messageId: string
      sessionId: string
      timestamp: string
    }
    createdAt: string
    deprecatedAt?: string
  }[]
  totalDecisions: number
}
```

**Config**: costTier=cheap, maxTokens=1000, ttl=5min, invalidateOn=['memory:update']

---

## 3. Core Components

### 3.1 MessageStore

```typescript
interface MessageStore {
  // Write operations
  appendMessage(message: Message): Promise<void>

  // Read operations
  getRecentMessages(sessionId: string, limit: number): Promise<Message[]>
  getMessage(messageId: string): Promise<Message | null>
  getMessageRange(sessionId: string, startIdx: number, endIdx: number): Promise<Message[]>

  // Session management
  createSession(): Promise<string>
  getCurrentSession(): Promise<string>
  listSessions(): Promise<SessionMeta[]>
}
```

### 3.2 SessionIndex

```typescript
interface SessionIndex {
  // Index operations
  indexMessage(message: Message): Promise<void>
  rebuildIndex(sessionId: string): Promise<void>

  // Search operations
  search(query: string, options: SearchOptions): Promise<SearchResult[]>

  // Keyword extraction
  extractKeywords(content: string): string[]
}
```

### 3.3 MemoryStore

```typescript
interface MemoryStore {
  // Facts
  addFact(fact: Omit<Fact, 'id' | 'createdAt'>): Promise<string>
  updateFact(id: string, updates: Partial<Fact>): Promise<void>
  getFacts(filter: FactFilter): Promise<Fact[]>
  deleteFact(id: string): Promise<void>

  // Decisions
  addDecision(decision: Omit<Decision, 'id' | 'createdAt'>): Promise<string>
  updateDecision(id: string, updates: Partial<Decision>): Promise<void>
  deprecateDecision(id: string, reason: string, supersededBy?: string): Promise<void>
  getDecisions(filter: DecisionFilter): Promise<Decision[]>
}
```

---

## 4. Tools for Memory Management

In addition to context sources, we need tools for writing to memory:

### 4.1 memory-remember Tool

```typescript
interface MemoryRememberParams {
  type: 'fact' | 'decision'
  content: string
  topics?: string[]        // for facts
  confidence?: 'confirmed' | 'inferred'  // for facts
}
```

### 4.2 memory-forget Tool

```typescript
interface MemoryForgetParams {
  type: 'fact' | 'decision'
  id: string
  reason?: string
}
```

### 4.3 memory-update Tool

```typescript
interface MemoryUpdateParams {
  type: 'fact' | 'decision'
  id: string
  content?: string
  status?: 'active' | 'deprecated'  // for decisions
  supersededBy?: string              // for decisions
}
```

---

## 5. memory Pack

**Components**:
- Context Sources: sessionRecent, sessionSearch, sessionThread, memoryFacts, memoryDecisions
- Tools: memoryRemember, memoryForget, memoryUpdate
- Policies: memory-write-audit (log all memory writes)
- promptFragment: Usage guide

**promptFragment**:
```
## Session & Memory Context Sources

### Recommended Workflow

1. **Get recent context first**:
   ctx.get("session.recent", { turns: 12 })

2. **Search for specific topics**:
   ctx.get("session.search", { query: "...", k: 8 })

3. **Expand context around a match**:
   ctx.get("session.thread", { anchorMessageId: "msg_xxx" })

4. **Check long-term memory**:
   ctx.get("memory.facts", { topics: ["preference"] })
   ctx.get("memory.decisions", { status: "active" })

### Memory Management

- Use `memory-remember` to save important facts or decisions
- Facts with confidence="inferred" may need user confirmation
- Decisions can be deprecated but are never deleted (audit trail)
- Always include provenance when citing from memory

### Coverage Interpretation

- Check `coverage.complete` to know if results are exhaustive
- Follow `coverage.suggestions` for next steps (e.g., "increase k")
- Use `provenance.messageId` for citations
```

---

## 6. Implementation Order

### Phase 1: Storage Layer
1. Create `src/core/message-store.ts` - Message persistence
2. Create `src/core/session-index.ts` - Inverted index for search
3. Create `src/core/memory-store.ts` - Facts & decisions storage
4. Update `src/types/runtime.ts` - Add stores to runtime

### Phase 2: Session Context Sources
1. Create `src/context-sources/session-recent.ts`
2. Create `src/context-sources/session-search.ts`
3. Create `src/context-sources/session-thread.ts`
4. Update `src/context-sources/index.ts`

### Phase 3: Memory Context Sources
1. Create `src/context-sources/memory-facts.ts`
2. Create `src/context-sources/memory-decisions.ts`
3. Update `src/context-sources/index.ts`

### Phase 4: Memory Tools
1. Create `src/tools/memory-remember.ts`
2. Create `src/tools/memory-forget.ts`
3. Create `src/tools/memory-update.ts`
4. Update `src/tools/index.ts`

### Phase 5: Pack Integration
1. Create `src/packs/memory.ts`
2. Update `src/packs/index.ts`
3. Update `src/types/context.ts` - Add type definitions

### Phase 6: Testing
1. Create test fixtures with sample conversations
2. Test message store and indexing
3. Test each context source
4. Test memory tools
5. Integration tests with agent loop

---

## 7. Usage Example

**User**: "Continue our discussion about the Agent Framework v2, focusing on ctx.get for history management."

**Model Actions**:

```
Step A: Get recent context
─────────────────────────
ctx.get("session.recent", { turns: 12, includeTools: true })

Result:
- [msg_101] user: "Let's discuss Agent Framework v2..."
- [msg_102] assistant: "I'll explain the three-axis architecture..."
- [msg_103] tool: read src/core/context-manager.ts
- ...

Step B: Search for specific topic
─────────────────────────────────
ctx.get("session.search", {
  query: "Agent Framework v2 ctx.get history",
  k: 8,
  recencyBias: "high"
})

Result:
- [msg_087] score=0.92 "...ctx.get for historical interactions..."
- [msg_045] score=0.85 "...Agent Framework v2 design..."

Step C: Expand context around best match
────────────────────────────────────────
ctx.get("session.thread", {
  anchorMessageId: "msg_087",
  windowTurns: 6
})

Result:
- [msg_084] user: "How should we handle history?"
- [msg_085] assistant: "There are three approaches..."
- [msg_086] user: "I like the ctx.get approach"
- [msg_087] assistant: "ctx.get for historical interactions..." ← anchor
- [msg_088] user: "What about long-term memory?"
- ...

Step D: Check for relevant preferences
──────────────────────────────────────
ctx.get("memory.facts", { query: "writing style preference" })

Result:
- [fact_012] "Avoid em dashes in technical writing" (confirmed)
- [fact_015] "Prefer concise explanations" (inferred)
```

**Model Response**: "Based on our previous discussion (session.thread msg_087), you were interested in..."

---

## 8. Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Storage format | JSONL + JSON | Append-only for messages, full read for index |
| Index type | Inverted index (MVP) | Simple, no external deps, fast keyword search |
| Semantic search | Reserved interface | Can add embeddings later without API change |
| Memory writes | Explicit tools only | Avoid hallucinated memories, user control |
| Decision lifecycle | State machine | Never delete, only deprecate (audit trail) |
| Session scope | Current by default | Prevent accidental cross-session leakage |
| Provenance | Required on all outputs | Enable citations and debugging |

---

## 9. Cost & Trade-offs

| Cost Type | Description | Mitigation |
|-----------|-------------|------------|
| Storage | Messages + indexes grow over time | Compression, cold storage rotation |
| Compute | Search requires index lookups | Caching, limit scopes |
| Privacy | History contains sensitive data | Scope controls, retention policies |
| Quality | Old decisions may be outdated | Status tracking, superseded links |

---

## 10. Future Enhancements

1. **Semantic search**: Add embedding-based retrieval alongside keywords
2. **Auto-extraction**: Periodic extraction of candidate facts (with user confirmation)
3. **Cross-project memory**: Share facts across different agent projects
4. **Memory decay**: Reduce confidence of old, unconfirmed facts
5. **Conflict resolution**: Handle contradictory facts/decisions

---

## 11. Validation Steps

1. Build project: `npm run build`
2. Create test session with sample messages
3. Test `session.recent` with various turn limits
4. Test `session.search` with keyword queries
5. Test `session.thread` expansion
6. Test `memory.facts` and `memory.decisions` CRUD
7. Test memory tools (remember, forget, update)
8. Run full integration test with agent loop
9. Verify provenance and coverage in all outputs
