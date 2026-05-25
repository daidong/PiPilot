# RFC: Tool Error Standardization for Agent Self-Correction

**Status:** Draft
**Date:** 2026-03-24
**Author:** Research Copilot Team

## Motivation

Agent 遇到工具错误时，能否自我修复取决于错误返回的信息质量。当前工具的错误处理质量参差不齐：

- **好的例子**：`convert-document.ts` 返回 error_code + 结构化上下文 + 具体修复建议
- **坏的例子**：`literature-search.ts` API 失败时静默返回空数组，agent 误以为"没找到论文"

核心原则：**错误是给 Agent 的指令，不是给人看的日志。**

好的工具错误应该回答三个问题：
1. 什么坏了？（error_code）
2. 为什么坏了？（context）
3. 怎么修？（suggestions）

## Design

### 1. Standardized ToolResult Interface

```typescript
// lib/tools/tool-utils.ts

/** Error codes that agent can programmatically switch on */
type ToolErrorCode =
  // Input errors — agent should fix parameters and retry
  | 'MISSING_PARAMETER'
  | 'INVALID_PARAMETER'
  | 'FILE_NOT_FOUND'
  | 'PATH_OUTSIDE_WORKSPACE'
  // Dependency errors — agent should check prerequisites
  | 'LLM_UNAVAILABLE'
  | 'CONVERTER_NOT_FOUND'
  | 'RUNTIME_NOT_FOUND'
  // External service errors — agent should retry or use fallback
  | 'API_ERROR'
  | 'API_RATE_LIMITED'
  | 'DOWNLOAD_FAILED'
  | 'NETWORK_TIMEOUT'
  // Processing errors
  | 'CONVERSION_FAILED'
  | 'EXECUTION_FAILED'
  | 'PARSE_FAILED'
  | 'OUTPUT_TOO_LARGE'
  // Data errors
  | 'NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'

interface ToolResult {
  success: boolean
  data?: unknown
  error?: string                    // Human-readable error message
  error_code?: ToolErrorCode        // Machine-readable error classification
  retryable?: boolean               // Should agent retry this call?
  suggestions?: string[]            // Actionable next steps for agent
  context?: Record<string, unknown> // Diagnostic metadata (paths, status codes, etc.)
  warnings?: string[]               // Non-fatal issues (partial results, degraded mode)
}
```

### 2. toAgentResult Enhancement

```typescript
function toAgentResult(toolName: string, result: ToolResult): AgentToolResult {
  let text: string

  if (result.success) {
    // Success path — unchanged, but include warnings if present
    if (result.data === undefined || result.data === null) {
      text = `[${toolName}] OK`
    } else if (typeof result.data === 'string') {
      text = result.data
    } else {
      text = JSON.stringify(result.data, null, 2)
    }
    if (result.warnings?.length) {
      text += `\n\n⚠ Warnings:\n${result.warnings.map(w => `- ${w}`).join('\n')}`
    }
  } else {
    // Error path — structured for agent self-correction
    const parts: string[] = []
    parts.push(`Error [${result.error_code ?? 'UNKNOWN'}]: ${result.error ?? 'Tool execution failed'}`)
    if (result.retryable !== undefined) {
      parts.push(`Retryable: ${result.retryable ? 'yes' : 'no'}`)
    }
    if (result.suggestions?.length) {
      parts.push(`Suggestions:\n${result.suggestions.map(s => `- ${s}`).join('\n')}`)
    }
    if (result.context && Object.keys(result.context).length > 0) {
      parts.push(`Context: ${JSON.stringify(result.context)}`)
    }
    text = parts.join('\n')
  }

  const MAX_RESULT_CHARS = 100_000
  const bounded = truncateHeadTail(text, MAX_RESULT_CHARS)

  return {
    content: [{ type: 'text', text: bounded }],
    details: { success: result.success, tool_name: toolName }
  }
}
```

### 3. Helper: toolError()

为了减少各工具中的 boilerplate，提供一个 builder：

```typescript
function toolError(
  code: ToolErrorCode,
  message: string,
  opts?: {
    retryable?: boolean
    suggestions?: string[]
    context?: Record<string, unknown>
  }
): ToolResult {
  return {
    success: false,
    error: message,
    error_code: code,
    retryable: opts?.retryable ?? false,
    suggestions: opts?.suggestions,
    context: opts?.context,
  }
}
```

Usage:
```typescript
// Before:
return toAgentResult('web_search', { success: false, error: 'Missing query.' })

// After:
return toAgentResult('web_search', toolError('MISSING_PARAMETER', 'Missing query.', {
  suggestions: ['Provide a non-empty query string.']
}))
```

### 4. Helper: toolWarning() for partial results

```typescript
function toolSuccess(data: unknown, warnings?: string[]): ToolResult {
  return { success: true, data, warnings }
}
```

## Per-Tool Migration Plan

### P0 — Fix Silent Failures (literature-search.ts)

**Problem:** API search helpers (`searchSemanticScholar`, `searchArxiv`, etc.) return `[]` on failure. Agent can't distinguish "no papers exist" from "API is down".

**Fix:** Change return type to include error info. Track which sources failed vs succeeded.

```typescript
// Before:
async function searchSemanticScholar(query: string, limit = 10): Promise<PaperResult[]> {
  try {
    const res = await fetch(...)
    if (!res.ok) return []     // ← silent fail
  } catch { return [] }        // ← silent fail
}

// After:
interface SourceSearchResult {
  papers: PaperResult[]
  error?: string        // null if successful
  statusCode?: number
}

async function searchSemanticScholar(query: string, limit = 10): Promise<SourceSearchResult> {
  try {
    const res = await fetch(...)
    if (!res.ok) return {
      papers: [],
      error: `Semantic Scholar API returned ${res.status}`,
      statusCode: res.status
    }
    // ... parse papers ...
    return { papers }
  } catch (err) {
    return {
      papers: [],
      error: `Semantic Scholar request failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
```

Then in the main pipeline, aggregate source diagnostics:

```typescript
// Collect source-level diagnostics
const sourceResults: Record<string, { papers: number; error?: string }> = {}

for (const src of batch.sources) {
  const searchFn = SOURCE_DISPATCH[src]
  if (!searchFn) continue
  const result = await searchFn(q, 10)
  allPapers.push(...result.papers)
  if (result.error) {
    sourceResults[src] = { papers: result.papers.length, error: result.error }
  } else {
    sourceResults[src] = { papers: result.papers.length }
  }
}

// In final result, include warnings about failed sources
if (deduplicated.length === 0) {
  const failedSources = Object.entries(sourceResults)
    .filter(([_, r]) => r.error)
    .map(([name, r]) => `${name}: ${r.error}`)

  return toAgentResult('literature-search', toolError(
    failedSources.length > 0 ? 'API_ERROR' : 'NOT_FOUND',
    failedSources.length > 0
      ? `No papers found. ${failedSources.length} source(s) failed.`
      : 'No papers found matching the query.',
    {
      retryable: failedSources.length > 0,
      context: { sourceResults, queriesUsed },
      suggestions: failedSources.length > 0
        ? ['Some APIs may be temporarily unavailable. Retry in a few minutes.',
           'Try narrowing the query or using different search terms.']
        : ['Try broader search terms.',
           'Check if the topic uses different terminology in academic literature.']
    }
  ))
}
```

### P0 — Fix review parsing silent degradation

```typescript
// Before: silently defaults to score=5 for all papers
if (!parsed) {
  review = {
    approved: true,
    relevantPapers: deduplicated.slice(0, 12).map(p => ({
      ...p, relevanceScore: 5,
      relevanceJustification: 'Review parsing failed; included by default.'
    })),
    ...
  }
}

// After: return with warning so agent knows the review was degraded
if (!parsed) {
  review = { /* same fallback */ }
  reviewWarnings.push(
    'LLM review parsing failed — papers included with default relevance score. '
    + 'Relevance scores may not be accurate.'
  )
}

// Include in final result:
return toAgentResult('literature-search', {
  success: true,
  data: payload,
  warnings: reviewWarnings.length > 0 ? reviewWarnings : undefined
})
```

### P1 — Standardize entity-tools.ts

```typescript
// Before:
if (!title) return { success: false, error: 'title is required' }
if (!existsSync(resolvedFilePath)) {
  return { success: false, error: `File not found: ${filePath}` }
}

// After:
if (!title) return toolError('MISSING_PARAMETER', 'title is required', {
  suggestions: ['Provide a non-empty title string for the artifact.']
})
if (!existsSync(resolvedFilePath)) {
  return toolError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
    suggestions: [
      `Check the file path relative to project root: ${projectPath}`,
      'Use the find or glob tool to locate the correct file path.'
    ],
    context: { resolvedPath: resolvedFilePath, projectPath }
  })
}
```

### P1 — Standardize web-tools.ts

```typescript
// Before:
return toAgentResult('web_search', {
  success: false,
  error: 'BRAVE_API_KEY is required when provider=brave. Set BRAVE_API_KEY or use provider=arxiv.',
})

// After:
return toAgentResult('web_search', toolError('MISSING_PARAMETER',
  'BRAVE_API_KEY is required when provider=brave.', {
  suggestions: [
    'Set BRAVE_API_KEY environment variable.',
    'Use provider=arxiv as a fallback for academic search.'
  ]
}))
```

### P2 — Standardize data-analyze.ts

Mostly good already. Add `suggestions` to existing errors:

```typescript
// Before:
return toAgentResult('data_analyze', { success: false, error: `File not found: ${filePath}` })

// After:
return toAgentResult('data_analyze', toolError('FILE_NOT_FOUND', `File not found: ${filePath}`, {
  suggestions: [
    'Verify the file path is relative to the workspace root.',
    'Use the find tool to locate the data file.'
  ],
  context: { workspacePath: ctx.workspacePath }
}))
```

### P2 — Standardize paper-enrichment.ts

Add error details to the return result:

```typescript
// Before:
return { success: true, enriched, skipped, failed }

// After:
return {
  success: true,
  enriched,
  skipped,
  failed,
  failureDetails: failures  // Array of { paperId, error } for failed papers
}
```

### P3 — wrapResearchTool adapter in index.ts

```typescript
// Before:
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: errorMsg }) }],
    details: { success: false, error: errorMsg }
  }
}

// After: pass through structured error fields
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err)
  const errorResult: ToolResult = toolError('EXECUTION_FAILED', errorMsg, {
    retryable: false,
    suggestions: ['Check tool parameters and try again.']
  })
  return toAgentResult(tool.name, errorResult)
}
```

## Migration Strategy

1. **Phase 1**: Update `tool-utils.ts` with new `ToolResult` interface, `toolError()`, `toolSuccess()` — backwards compatible since new fields are optional
2. **Phase 2**: Migrate `literature-search.ts` (P0 — fix silent failures)
3. **Phase 3**: Migrate `entity-tools.ts`, `web-tools.ts` (P1)
4. **Phase 4**: Migrate `data-analyze.ts`, `paper-enrichment.ts`, `convert-document.ts` (P2/P3)
5. **Phase 5**: Update `wrapResearchTool` adapter in `index.ts`

Each phase is independently deployable. Existing tools continue to work because `error_code`, `retryable`, `suggestions`, `context`, `warnings` are all optional additions.

## Testing Checklist

- [ ] Existing tools still return correct success results
- [ ] Error results include error_code, suggestions
- [ ] literature-search API failures are no longer silent
- [ ] literature-search "0 papers" distinguishes "not found" from "API down"
- [ ] entity-tools file-not-found includes path context
- [ ] wrapResearchTool adapter passes through structured errors
- [ ] toAgentResult formats warnings correctly on success
- [ ] toAgentResult formats structured errors correctly on failure
