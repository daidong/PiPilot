# Context Source Discovery & Routing Specification

## Overview

This specification defines how LLM agents discover, route, and correctly invoke context sources when multiple sources (repo.*, docs.*, session.*, memory.*, images.*, etc.) are available simultaneously.

**Core Principle**: Don't expect the model to memorize N sources. Let it use ctx.get like an API platform: **Discover → Route → Call → Repair**.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context Source API Platform                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐        │
│  │ Discover│ → │  Route  │ → │  Call   │ → │ Repair  │        │
│  └─────────┘   └─────────┘   └─────────┘   └─────────┘        │
│       │             │             │             │              │
│       ▼             ▼             ▼             ▼              │
│  ctx.catalog   ctx.route    ctx.get(*)   Error + next         │
│  ctx.describe                                                  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Packs: Capability pruning per agent role               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Policies: Routing guards, cost limits, boundary checks │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Interface Standards (Invariants)

### 1.1 Namespace Convention

All sourceId MUST have clear namespace prefix. No mixed naming.

| Namespace | Domain | Examples |
|-----------|--------|----------|
| `repo.*` | Codebase | repo.index, repo.search, repo.file |
| `docs.*` | Document corpus | docs.index, docs.search, docs.open |
| `session.*` | Conversation history | session.recent, session.search, session.thread |
| `memory.*` | Explicit long-term storage | memory.get, memory.search, memory.list |
| `images.*` | Image library | images.index, images.search, images.open |
| `ctx.*` | Meta-capabilities | ctx.catalog, ctx.describe, ctx.route |

**Invariant**: `sourceId.match(/^[a-z]+\.[a-z][a-z0-9-]*$/)` MUST be true.

### 1.2 Kind Declaration (Required)

Every ContextSource MUST declare `kind ∈ { index, search, open, get }`.

Kind is the primary axis for model capability selection, more important than category.

```typescript
interface ContextSource {
  id: string              // 'docs.search'
  namespace: string       // 'docs'
  kind: ContextKind       // 'search'
  // ...
}

type ContextKind = 'index' | 'search' | 'open' | 'get'
```

### 1.3 Parameter Shape Convergence (Param Shapes)

All parameters MUST converge to these 4 standard shapes. Extensions go into `filters` or `options`, not top-level fields.

#### A) `index` Shape - Browse Structure

```typescript
interface IndexParams {
  scope?: string          // Subtree to browse
  prefix?: string         // Filter by prefix
  depth?: number          // Max depth (default: 1)
  limit?: number          // Max items (default: 50)
  sort?: 'name' | 'modified' | 'size'
  filters?: Record<string, unknown>  // Domain-specific filters
}
```

**Applies to**: repo.index, docs.index, images.index, memory.list

#### B) `search` Shape - Retrieve Candidates

```typescript
interface SearchParams {
  query: string           // Required: search query
  k?: number              // Max results (default: 10)
  mode?: 'keyword' | 'semantic' | 'hybrid'
  recencyBias?: 'high' | 'medium' | 'low'
  scope?: string          // Limit search scope
  filters?: {
    type?: string | string[]
    tags?: string[]
    dateRange?: { from?: string; to?: string }
    [key: string]: unknown
  }
}
```

**Applies to**: repo.search, docs.search, session.search, memory.search, images.search

#### C) `open` Shape - Read Single Object

```typescript
interface OpenParams {
  id?: string             // Object ID (mutually exclusive with path)
  path?: string           // File path (mutually exclusive with id)
  mode?: 'full' | 'snippets' | 'outline'
  range?: {
    start?: number        // Line or chunk start
    end?: number          // Line or chunk end
  }
  chunkId?: string        // Specific chunk
  focusQuery?: string     // Highlight relevant sections
  filters?: Record<string, unknown>
}
```

**Applies to**: repo.file, docs.open, session.thread, images.open

#### D) `get` Shape - Exact Key Lookup

```typescript
interface GetParams {
  namespace: string       // Required
  key: string             // Required
  version?: string        // Optional: specific version
}
```

**Applies to**: memory.get, config.get

**Invariant**: Parameters outside these shapes MUST be nested in `filters` or `options`.

### 1.4 Result Contract (ContextResult)

Standard result structure with two new fields: `kindEcho` and `next`.

```typescript
interface ContextResult<T = unknown> {
  success: boolean
  error?: string

  // Existing fields
  data?: T
  rendered: string
  provenance: Provenance
  coverage: Coverage

  // New fields for discoverability
  kindEcho: {
    source: string        // Echo back sourceId
    kind: ContextKind     // Echo back kind
    paramsUsed: object    // Echo back actual params used
  }

  next?: NextStep[]       // Machine-readable hints for next action
}

interface NextStep {
  source: string          // Recommended next source
  params: object          // Suggested params (can be partial template)
  why: string             // One-line explanation
  confidence?: number     // 0-1
}
```

**Example**: `docs.search` returns:
```json
{
  "success": true,
  "rendered": "Found 3 documents...",
  "kindEcho": {
    "source": "docs.search",
    "kind": "search",
    "paramsUsed": { "query": "authentication", "k": 10 }
  },
  "next": [
    {
      "source": "docs.open",
      "params": { "id": "doc_abc123" },
      "why": "Top hit: Authentication Guide",
      "confidence": 0.92
    }
  ],
  "coverage": {
    "complete": false,
    "suggestions": ["Increase k for more results", "Add filters.type to narrow"]
  }
}
```

---

## 2. Three-Layer Discovery Protocol

### 2.1 Layer 1: Pack promptFragment (Static, Short)

Each pack injects a minimal routing table + workflow. NOT full parameter docs.

**Template** (keep under 20 lines per pack):

```markdown
## {Namespace} Context Sources

| Source | Kind | Purpose |
|--------|------|---------|
| {ns}.index | index | {one-liner} |
| {ns}.search | search | {one-liner} |
| {ns}.open | open | {one-liner} |

### Workflow
1. {ns}.index → Overview
2. {ns}.search → Find candidates
3. {ns}.open → Read details

### Rule
Unsure? Use `ctx.route` or `ctx.describe`.
```

**Example** (docs pack):

```markdown
## docs.* Context Sources

| Source | Kind | Purpose |
|--------|------|---------|
| docs.index | index | List indexed documents |
| docs.search | search | Find documents by query |
| docs.open | open | Read document content |

### Workflow
1. docs.index → See what's available
2. docs.search → Find by topic/keyword
3. docs.open → Read the content

### Rule
Unsure about params? Use `ctx.get("ctx.describe", { id: "docs.search" })`.
```

### 2.2 Layer 2: ctx.catalog (List Directory)

**Purpose**: List available sources, short format. NOT full schemas.

**Interface**:
```typescript
interface CtxCatalogParams {
  namespace?: string      // Filter by namespace
  kind?: ContextKind      // Filter by kind
}

interface CtxCatalogData {
  sources: {
    id: string
    namespace: string
    kind: ContextKind
    oneLiner: string      // One sentence purpose
    minParams: string[]   // Required params only
    example: string       // Single minimal example
    costTier: CostTier
  }[]
  namespaces: string[]    // Available namespaces
}
```

**Example Call**:
```json
{ "source": "ctx.catalog", "params": { "namespace": "docs" } }
```

**Example Output** (rendered):
```
# Available Sources: docs.*

| Source | Kind | Purpose | Cost |
|--------|------|---------|------|
| docs.index | index | List indexed documents | cheap |
| docs.search | search | Find documents by query | medium |
| docs.open | open | Read document content | cheap |

## Quick Examples
- docs.index: ctx.get("docs.index", { limit: 20 })
- docs.search: ctx.get("docs.search", { query: "authentication" })
- docs.open: ctx.get("docs.open", { path: "docs/auth.md" })

Use ctx.describe for full parameter details.
```

**Config**: costTier=cheap, maxTokens=500, ttl=10min

### 2.3 Layer 3: ctx.describe (View Documentation)

**Purpose**: Full schema, examples, common errors, recommended workflow.

**Interface**:
```typescript
interface CtxDescribeParams {
  id: string              // Required: sourceId
}

interface CtxDescribeData {
  id: string
  namespace: string
  kind: ContextKind
  description: string     // Full description
  params: {
    name: string
    type: string
    required: boolean
    description: string
    default?: unknown
    enum?: unknown[]
  }[]
  examples: {
    description: string
    call: object
    resultSummary: string
  }[]
  commonErrors: {
    error: string
    fix: string
  }[]
  workflow: string        // Recommended usage pattern
  relatedSources: string[]
}
```

**Example Call**:
```json
{ "source": "ctx.describe", "params": { "id": "docs.search" } }
```

**Example Output** (rendered):
```
# docs.search

Search indexed documents by query.

## Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| query | string | ✓ | - | Search query (keywords or natural language) |
| k | number | - | 10 | Max results to return |
| mode | enum | - | "keyword" | "keyword" | "semantic" | "hybrid" |
| filters.type | string[] | - | - | Filter by doc type: ["md", "pdf"] |
| filters.tags | string[] | - | - | Filter by tags |

## Examples

1. Basic search:
   ctx.get("docs.search", { "query": "authentication flow" })

2. With filters:
   ctx.get("docs.search", {
     "query": "API reference",
     "k": 5,
     "filters": { "type": ["md"], "tags": ["api"] }
   })

## Common Errors

| Error | Fix |
|-------|-----|
| Missing required field "query" | Add query parameter |
| Unknown filter "fileType" | Use filters.type instead |

## Workflow

1. Start with docs.search to find candidates
2. Use docs.open on top results
3. If coverage incomplete, increase k or refine query

## Related
docs.index, docs.open
```

**Config**: costTier=cheap, maxTokens=1500, ttl=10min

---

## 3. ctx.route - The Stable Router

**Purpose**: Answer "Which source should I use?" directly. More useful than catalog for uncertain situations.

### 3.1 Interface

```typescript
interface CtxRouteParams {
  intent: ContextKind               // Required: what kind of operation
  query?: string                    // Natural language description of need
  namespaceHint?: string            // Hint: "repo" | "docs" | "session" | ...
  constraints?: {
    costMax?: CostTier              // Max acceptable cost tier
    requireFresh?: boolean          // Need real-time data
  }
}

interface CtxRouteData {
  recommended: {
    source: string
    paramsTemplate: object          // Pre-filled params based on query
    confidence: number              // 0-1
  }
  alternatives: {
    source: string
    why: string                     // Why this is an alternative
    confidence: number
  }[]
  rationale: string                 // One sentence explanation
  next: NextStep[]                  // After this, do what?
}
```

### 3.2 Example Calls

**Example 1**: User wants to find something in history
```json
{
  "source": "ctx.route",
  "params": {
    "intent": "search",
    "query": "what did we discuss about authentication yesterday"
  }
}
```

**Response**:
```json
{
  "recommended": {
    "source": "session.search",
    "paramsTemplate": {
      "query": "authentication",
      "recencyBias": "high",
      "k": 10
    },
    "confidence": 0.92
  },
  "alternatives": [
    { "source": "memory.search", "why": "If looking for saved decisions", "confidence": 0.45 }
  ],
  "rationale": "Query mentions 'yesterday' and 'discuss' → session history",
  "next": [
    { "source": "session.thread", "params": { "anchorMessageId": "..." }, "why": "Expand context around match" }
  ]
}
```

**Example 2**: User wants to read a specific file
```json
{
  "source": "ctx.route",
  "params": {
    "intent": "open",
    "query": "src/core/context-manager.ts"
  }
}
```

**Response**:
```json
{
  "recommended": {
    "source": "repo.file",
    "paramsTemplate": { "path": "src/core/context-manager.ts" },
    "confidence": 0.98
  },
  "alternatives": [],
  "rationale": "Query is a file path → repo.file",
  "next": []
}
```

### 3.3 Routing Rules (Initial Implementation)

Start with rule-based routing. Can add ML later.

```typescript
function routeByRules(params: CtxRouteParams): CtxRouteData {
  const { intent, query, namespaceHint } = params

  // Pattern matching on query
  const patterns = {
    // Session indicators
    session: /\b(之前|上次|昨天|刚才|我们讨论|说过|提到|历史|对话|聊|earlier|yesterday|discussed|mentioned|history|conversation)\b/i,

    // Memory indicators
    memory: /\b(记住|保存|设置|偏好|配置|remember|saved|setting|preference|config)\b/i,

    // File path indicators
    filePath: /^[./]|\.([tj]sx?|md|json|ya?ml|py|go|rs)$|\//,

    // Image indicators
    images: /\b(图片|图像|照片|截图|image|photo|screenshot|picture)\b/i,

    // Document indicators (default for natural language)
    docs: /\b(文档|文章|指南|教程|手册|document|guide|tutorial|manual|reference)\b/i
  }

  // Determine namespace
  let namespace = namespaceHint
  if (!namespace && query) {
    if (patterns.session.test(query)) namespace = 'session'
    else if (patterns.memory.test(query)) namespace = 'memory'
    else if (patterns.filePath.test(query)) namespace = 'repo'
    else if (patterns.images.test(query)) namespace = 'images'
    else if (patterns.docs.test(query)) namespace = 'docs'
    else namespace = 'repo'  // Default to repo for code tasks
  }

  // Build source from namespace + intent
  const source = `${namespace}.${kindToSource(intent, namespace)}`

  return {
    recommended: { source, paramsTemplate: buildTemplate(query, intent), confidence: 0.8 },
    alternatives: [],
    rationale: `Query pattern → ${namespace}`,
    next: []
  }
}

function kindToSource(kind: ContextKind, namespace: string): string {
  const mapping: Record<string, Record<ContextKind, string>> = {
    repo: { index: 'index', search: 'search', open: 'file', get: 'file' },
    docs: { index: 'index', search: 'search', open: 'open', get: 'open' },
    session: { index: 'recent', search: 'search', open: 'thread', get: 'thread' },
    memory: { index: 'list', search: 'search', open: 'get', get: 'get' },
    images: { index: 'index', search: 'search', open: 'open', get: 'open' }
  }
  return mapping[namespace]?.[kind] ?? kind
}
```

### 3.4 Policy Integration

Add policy to enforce routing before cross-namespace access:

```typescript
const routingGuard = defineGuardPolicy({
  id: 'require-route-for-unfamiliar',
  match: (ctx) => ctx.tool === 'ctx-get' && !ctx.session.routedNamespaces?.includes(getNamespace(ctx.args.source)),
  decide: (ctx) => ({
    action: 'ask',
    message: `First time accessing ${getNamespace(ctx.args.source)}.*. Consider ctx.route first?`
  })
})
```

---

## 4. Controlled ctx-get Tool

### 4.1 Dynamic Description

Don't enumerate all sources. Generate short overview.

```typescript
export const ctxGet = defineTool({
  name: 'ctx-get',

  getDescription: (runtime) => {
    const namespaces = runtime.contextManager.getNamespaces()

    return `Get context information from registered sources.

## Available Namespaces
${namespaces.map(ns => `- ${ns}.*`).join('\n')}

## Meta Sources
- ctx.catalog: List available sources
- ctx.describe: Get source documentation
- ctx.route: Get recommended source for your intent

## Rules
1. Unsure which source? Use ctx.route first
2. Need params? Use ctx.describe
3. Errors include fix suggestions

## Quick Pattern
route → search → open (works across all namespaces)`
  },

  parameters: {
    source: {
      type: 'string',
      description: 'Source ID (e.g., repo.search, docs.open)',
      required: true
    },
    params: {
      type: 'object',
      description: 'Parameters (shape depends on source kind)',
      required: false
    }
  },
  // ...
})
```

### 4.2 Strong Parameter Validation

ContextManager MUST validate params against source schema.

```typescript
class ContextManager {
  async get(sourceId: string, params: unknown): Promise<ContextResult> {
    // 1. Check source exists
    const source = this.sources.get(sourceId)
    if (!source) {
      return this.unknownSourceError(sourceId)
    }

    // 2. Validate params against schema
    const validation = this.validateParams(source, params)
    if (!validation.valid) {
      return this.validationError(source, validation.errors)
    }

    // 3. Execute
    return source.fetch(params, this.runtime)
  }

  private unknownSourceError(sourceId: string): ContextResult {
    const similar = this.findSimilar(sourceId, 3)

    return {
      success: false,
      error: `Unknown source "${sourceId}"`,
      rendered: `
# Error: Unknown Source

Source "${sourceId}" not found.

${similar.length > 0 ? `## Did you mean?\n${similar.map(s => `- ${s}`).join('\n')}` : ''}

## Available Sources
Use ctx.get("ctx.catalog") to list all sources.
`,
      kindEcho: { source: sourceId, kind: 'unknown', paramsUsed: {} },
      provenance: { operations: [], durationMs: 0, cached: false },
      coverage: { complete: true }
    }
  }

  private validationError(source: ContextSource, errors: ValidationError[]): ContextResult {
    const example = source.examples?.[0]

    return {
      success: false,
      error: errors.map(e => e.message).join('; '),
      rendered: `
# Error: Invalid Parameters for ${source.id}

## Problems
${errors.map(e => `- ${e.field}: ${e.message}`).join('\n')}

## Allowed Fields
${source.params.map(p => `- ${p.name}${p.required ? ' (required)' : ''}: ${p.type}`).join('\n')}

## Example
\`\`\`json
ctx.get("${source.id}", ${JSON.stringify(example?.call?.params ?? {}, null, 2)})
\`\`\`

## Need Help?
Use ctx.get("ctx.describe", { id: "${source.id}" }) for full documentation.
`,
      kindEcho: { source: source.id, kind: source.kind, paramsUsed: {} },
      provenance: { operations: [], durationMs: 0, cached: false },
      coverage: { complete: true }
    }
  }

  private findSimilar(sourceId: string, limit: number): string[] {
    // Levenshtein distance or simple prefix matching
    return Array.from(this.sources.keys())
      .filter(id => this.similarity(id, sourceId) > 0.5)
      .slice(0, limit)
  }
}
```

### 4.3 Actionable Suggestions

coverage.suggestions + next provide dual-channel guidance:
- `suggestions`: Human-readable for model
- `next`: Machine-readable for automation/UI

```typescript
// Example: search returns too many results
{
  coverage: {
    complete: false,
    limitations: ["Showing 10 of 156 matches"],
    suggestions: [
      "Refine query with more specific keywords",
      "Add filters.type to narrow by file type",
      "Increase k to see more results"
    ]
  },
  next: [
    { source: "docs.open", params: { id: "doc_001" }, why: "Top match" },
    { source: "docs.search", params: { query: "...", k: 20 }, why: "See more results" }
  ]
}
```

---

## 5. Routing Policies

### 5.1 Routing Guard (Prevent Wrong Namespace)

```typescript
const routingGuard = defineGuardPolicy({
  id: 'routing-guard',
  match: (ctx) => ctx.tool === 'ctx-get',

  decide: async (ctx, runtime) => {
    const source = ctx.args.source
    const namespace = source.split('.')[0]
    const userIntent = runtime.sessionState.currentIntent

    // Rule: "history/conversation" intent should use session.*, not repo.*
    if (userIntent?.includes('history') && namespace === 'repo') {
      return {
        action: 'deny',
        reason: `For conversation history, use session.search instead of ${source}`,
        suggestion: { source: 'session.search', params: { query: ctx.args.params?.query } }
      }
    }

    // Rule: "document" intent should use docs.*, not repo.grep
    if (userIntent?.includes('document') && source === 'repo.grep') {
      return {
        action: 'deny',
        reason: `For document search, use docs.search instead of repo.grep`,
        suggestion: { source: 'docs.search', params: { query: ctx.args.params?.pattern } }
      }
    }

    return { action: 'allow' }
  }
})
```

### 5.2 Cost Guard (Limit Expensive Operations)

```typescript
const costGuard = defineGuardPolicy({
  id: 'context-cost-guard',
  match: (ctx) => ctx.tool === 'ctx-get',

  decide: async (ctx, runtime) => {
    const source = runtime.contextManager.getSource(ctx.args.source)
    if (!source) return { action: 'allow' }

    // Expensive sources require approval
    if (source.costTier === 'expensive') {
      return {
        action: 'ask',
        message: `${ctx.args.source} is expensive. Proceed?`
      }
    }

    // Large k or depth requires approval
    const k = ctx.args.params?.k
    const depth = ctx.args.params?.depth
    if ((k && k > 50) || (depth && depth > 3)) {
      return {
        action: 'ask',
        message: `Large result set (k=${k}, depth=${depth}). Consider smaller first?`
      }
    }

    return { action: 'allow' }
  }
})

const costMutator = defineMutatePolicy({
  id: 'context-cost-mutator',
  match: (ctx) => ctx.tool === 'ctx-get',

  transform: (ctx) => {
    const params = { ...ctx.args.params }

    // Auto-limit k if not specified
    if (params.k === undefined && ctx.args.source.includes('.search')) {
      params.k = 10
    }

    // Auto-limit depth for index
    if (params.depth === undefined && ctx.args.source.includes('.index')) {
      params.depth = 2
    }

    return { ...ctx.args, params }
  }
})
```

### 5.3 Data Boundary Guard (Cross-Domain Isolation)

```typescript
const boundaryGuard = defineObservePolicy({
  id: 'context-boundary-guard',
  match: (ctx) => ctx.tool === 'ctx-get',

  observe: (ctx, runtime) => {
    const source = ctx.args.source
    const namespace = source.split('.')[0]

    // Log cross-namespace access
    const previousNamespace = runtime.sessionState.lastContextNamespace
    if (previousNamespace && previousNamespace !== namespace) {
      runtime.trace.addEvent({
        type: 'context.namespace_switch',
        data: { from: previousNamespace, to: namespace, source }
      })
    }

    runtime.sessionState.lastContextNamespace = namespace
  }
})
```

---

## 6. Pack Capability Pruning

### 6.1 Role-Based Pack Selection

Don't expose all sources to every agent.

| Agent Role | Recommended Packs | Sources Available |
|------------|-------------------|-------------------|
| Code Assistant | repo, session (minimal) | repo.*, session.recent |
| Research Agent | docs, web, citation | docs.*, web.*, citation.* |
| Media Agent | images, docs (minimal) | images.*, docs.search |
| Full Assistant | all | all |

### 6.2 Pack Compatibility Checks

```typescript
function validatePackCompatibility(packs: Pack[]): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check sourceId conflicts
  const sourceIds = new Set<string>()
  for (const pack of packs) {
    for (const source of pack.contextSources ?? []) {
      if (sourceIds.has(source.id)) {
        errors.push(`Duplicate sourceId: ${source.id}`)
      }
      sourceIds.add(source.id)

      // Check kind declaration
      if (!source.kind) {
        errors.push(`Source ${source.id} missing required 'kind' field`)
      }

      // Check param shape compliance
      if (!isValidParamShape(source.kind, source.params)) {
        warnings.push(`Source ${source.id} params don't match standard ${source.kind} shape`)
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
```

---

## 7. Stable Model Workflow

### 7.1 Core Workflow Pattern

Inject into base system prompt:

```markdown
## Context Retrieval Pattern

When you need external information:

1. **Route** (if unsure):
   ctx.get("ctx.route", { intent: "search", query: "..." })

2. **Search** (find candidates):
   ctx.get("{namespace}.search", { query: "...", k: 10 })

3. **Open** (read details):
   ctx.get("{namespace}.open", { id: "..." }) for top 2-3 results

4. **Check coverage**:
   If coverage.complete=false, refine query or increase k

5. **Then act**:
   Edit/write/respond based on retrieved context

This pattern works across repo.*, docs.*, session.*, images.*.
```

### 7.2 Quick Decision Table

```markdown
## Context Source Quick Reference

| I need to... | Use | Kind |
|--------------|-----|------|
| See project structure | repo.index | index |
| Find code by keyword | repo.search | search |
| Read a file | repo.file | open |
| See document library | docs.index | index |
| Find documents by topic | docs.search | search |
| Read a document | docs.open | open |
| See recent conversation | session.recent | index |
| Find past discussion | session.search | search |
| Expand conversation context | session.thread | open |
| Get saved preference | memory.get | get |
| Find saved items | memory.search | search |

**Unsure?** Use `ctx.route` with your intent.
```

---

## 8. Implementation Roadmap

### Phase 1: Foundation (Required)

1. **Add `kind` field to ContextSource interface**
2. **Enforce param shape validation** in ContextManager
3. **Implement enhanced error responses** with suggestions and fuzzy matching
4. **Add `kindEcho` and `next` to ContextResult**

### Phase 2: Discovery Layer

5. **Implement ctx.catalog** (short listing)
6. **Implement ctx.describe** (full documentation)
7. **Update ctx-get dynamic description**

### Phase 3: Routing

8. **Implement ctx.route** (rule-based)
9. **Add routing policies** (guard, cost, boundary)

### Phase 4: Pack Integration

10. **Update all pack promptFragments** to new template
11. **Add pack compatibility validation**
12. **Update existing context sources** to declare kind and use standard param shapes

### Phase 5: Polish

13. **Add comprehensive tests** for discovery and routing
14. **Add telemetry** for route accuracy tracking
15. **Consider ML-based routing** for future enhancement

---

## 9. File Changes Summary

### New Files
| File | Description |
|------|-------------|
| `src/context-sources/ctx-catalog.ts` | ctx.catalog meta-source |
| `src/context-sources/ctx-describe.ts` | ctx.describe meta-source |
| `src/context-sources/ctx-route.ts` | ctx.route router source |
| `src/policies/routing-guard.ts` | Routing constraint policies |
| `src/core/param-validator.ts` | Standard param shape validation |

### Modified Files
| File | Description |
|------|-------------|
| `src/types/context.ts` | Add kind, kindEcho, next, param shapes |
| `src/core/context-manager.ts` | Add validation, error handling, fuzzy match |
| `src/tools/ctx-get.ts` | Dynamic description generation |
| `src/packs/*.ts` | Update promptFragments to new template |
| `src/context-sources/*.ts` | Add kind, use standard param shapes |

---

## 10. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Source selection accuracy | >90% | Correct namespace on first try |
| Parameter correctness | >85% | Valid params on first try |
| Self-repair rate | >80% | Successful retry after error |
| Route usage | >50% | Models use ctx.route when unsure |
| Average discovery calls | <2 | catalog + describe before success |
