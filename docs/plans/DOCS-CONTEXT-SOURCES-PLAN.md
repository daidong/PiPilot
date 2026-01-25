# Large-Scale Document Library Management Context Sources Implementation Plan

## Overview

Implement a three-layer document management architecture that enables Agents to efficiently retrieve and read relevant content from large document collections.

## File Checklist

### New Files
| File | Description |
|------|-------------|
| `src/context-sources/docs-index.ts` | docs.index context source |
| `src/context-sources/docs-search.ts` | docs.search context source |
| `src/context-sources/docs-open.ts` | docs.open context source |
| `src/cli/index-docs.ts` | Index building CLI command |
| `src/packs/docs.ts` | docs Pack |

### Modified Files
| File | Description |
|------|-------------|
| `src/context-sources/index.ts` | Add docs-related exports |
| `src/packs/index.ts` | Add docs pack export |
| `src/cli/bin.ts` | Add index-docs command |
| `src/types/context.ts` | Add docs-related types |

---

## 1. Index File Format (.agent-foundry/docs_index.json)

```json
{
  "version": "1.0.0",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "config": {
    "rootPaths": ["./docs"],
    "extensions": [".md", ".txt"],
    "chunkSize": 500,
    "chunkOverlap": 50
  },
  "stats": {
    "totalDocuments": 100,
    "totalChunks": 800,
    "totalTokens": 45000,
    "byType": { "markdown": 80, "txt": 20 }
  },
  "documents": [
    {
      "id": "doc_abc123",
      "path": "docs/guide.md",
      "title": "User Guide",
      "type": "markdown",
      "size": 15420,
      "hash": "sha256:abc...",
      "modifiedAt": "2024-01-10T08:00:00Z",
      "metadata": { "tags": ["guide"], "category": "docs" },
      "chunks": [
        { "id": "chunk_001", "startLine": 1, "endLine": 45, "tokens": 520, "keywords": ["guide", "setup"] }
      ],
      "outline": [{ "level": 1, "title": "User Guide", "line": 1 }],
      "keywords": ["guide", "setup", "configuration"]
    }
  ],
  "keywords": { "guide": ["doc_abc123"], "setup": ["doc_abc123", "doc_def456"] }
}
```

---

## 2. Context Sources Design

### 2.1 docs.index - Index Layer

**Purpose**: Return document library overview without reading content

**Parameters**:
```typescript
interface DocsIndexParams {
  type?: 'markdown' | 'pdf' | 'txt' | 'all'
  category?: string
  tags?: string[]
  sortBy?: 'modified' | 'title' | 'size'
  offset?: number
  limit?: number  // default 50
}
```

**Config**: costTier=cheap, maxTokens=800, ttl=10min, invalidateOn=['docs:reindex']

### 2.2 docs.search - Search Layer

**Purpose**: Retrieve candidate documents based on query

**Parameters**:
```typescript
interface DocsSearchParams {
  query: string  // required
  mode?: 'keyword' | 'semantic' | 'hybrid'
  type?: 'markdown' | 'pdf' | 'txt' | 'all'
  limit?: number  // default 20
  includePreview?: boolean
}
```

**Implementation**:
1. Use inverted index for fast candidate location
2. Fall back to grep search if results insufficient
3. Sort by relevance score

**Config**: costTier=medium, maxTokens=1500, ttl=2min

### 2.3 docs.open - Read Layer

**Purpose**: Read document content fragments

**Parameters**:
```typescript
interface DocsOpenParams {
  path: string  // required
  chunkId?: string
  startLine?: number
  lineLimit?: number  // default 150
  includeOutline?: boolean
  includeMeta?: boolean
}
```

**Config**: costTier=cheap, maxTokens=3000, ttl=1min, invalidateOn=['file:write']

---

## 3. CLI Command: index-docs

**Usage**:
```bash
agent-foundry index-docs [options]

Options:
  --paths <dirs>      Document directories, comma-separated (default: ./docs)
  --ext <exts>        File extensions, comma-separated (default: .md,.txt)
  --exclude <globs>   Exclude patterns
  --chunk-size <n>    Chunk size (default: 500 tokens)
  --overlap <n>       Chunk overlap (default: 50 tokens)
  --output <dir>      Output directory (default: .agent-foundry)
  --incremental       Incremental update mode
  -v, --verbose       Verbose output
```

**Functionality**:
1. Scan document files in specified directories
2. Extract titles, outlines, keywords
3. Chunk by token count
4. Build inverted index
5. Output docs_index.json

---

## 4. docs Pack

**Components**:
- Context Sources: docsIndex, docsSearch, docsOpen
- promptFragment: Usage guide and parameter descriptions
- onInit: Check if index exists

**promptFragment Key Points**:
```
Recommended workflow:
1. ctx.get("docs.index") - Understand the document library
2. ctx.get("docs.search", { query: "..." }) - Search for relevant documents
3. ctx.get("docs.open", { path: "..." }) - Read specific content

Notes:
- Pay attention to coverage info to determine if more reading is needed
- Use chunkId for reading large documents in chunks
```

---

## 5. Implementation Order

### Phase 1: Context Sources (Core)
1. Create `src/context-sources/docs-index.ts`
2. Create `src/context-sources/docs-search.ts`
3. Create `src/context-sources/docs-open.ts`
4. Update `src/context-sources/index.ts` to add exports
5. Update `src/types/context.ts` to add types

### Phase 2: CLI Command
1. Create `src/cli/index-docs.ts`
2. Modify `src/cli/bin.ts` to add command entry

### Phase 3: Pack Integration
1. Create `src/packs/docs.ts`
2. Update `src/packs/index.ts` to add export

### Phase 4: Testing
1. Create test document directory
2. Run `agent-foundry index-docs`
3. Test three context sources

---

## 6. Key Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Index location | .agent-foundry/ | Isolated from project, easy to gitignore |
| Keyword retrieval | Inverted index + grep fallback | Balance speed and coverage |
| Chunking strategy | By token count with overlap | Preserve semantic integrity |
| Cache invalidation | Event-driven | Avoid stale data |
| Semantic search | Reserved interface | Extensible for future |

---

## 7. Validation Steps

1. Build project: `npm run build`
2. Create test documents: `mkdir -p test-docs && echo "# Test" > test-docs/test.md`
3. Build index: `npx agent-foundry index-docs --paths test-docs -v`
4. Verify index file: `cat .agent-foundry/docs_index.json`
5. Run tests: `npm test`
