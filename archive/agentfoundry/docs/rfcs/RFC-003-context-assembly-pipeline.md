# RFC-003: Context Assembly Pipeline

## Summary

This RFC proposes a **phased, priority-aware context assembly pipeline** for AgentFoundry. The current context system is pull-based and flat; this design introduces a structured pipeline with:

1. **Context Phases** — ordered stages with priority and budget allocation
2. **Selection Injection** — user-selected content passed to agent runs
3. **History Compression** — summarized index of older context for LLM to request
4. **Explicit Retrieval** — tools for LLM to fetch specific context on demand

> **RFC-009 Update:** The "Pinned" concept is now **Project Cards** (`project-cards`). WorkingSet and State Summary are first-class phases in the current framework. Entity @mentions should feed WorkingSet; file/URL mentions can remain selected context. Legacy `pinned` tags are only included when explicitly enabled.

## Problem Statement

### Motivating Scenario

A realistic agent application needs:

| Component | Description | How It Works |
|-----------|-------------|--------------|
| **agents.md** | Auto-generated project config, user-editable | Always loaded on every request |
| **User-selected knowledge** | UI shows knowledge library, user selects items | Selection → context for this request |
| **Session history** | Recent messages and tool outputs | Token-budget aware, newest first |
| **Compressed history** | Summary of older conversation | LLM can explicitly request specific parts |

### Current System Limitations

```
Current Context Flow:
┌─────────────────────────────┐
│ System Prompt               │  Fixed
│ Pack Prompt Fragments       │  Fixed
│ Messages (flat list)        │  No priority, no budget coordination
│ Tool Results (inline)       │  No control
└─────────────────────────────┘
```

**Problems:**

| Issue | Impact |
|-------|--------|
| No "always include" mechanism | Apps cannot guarantee certain content is in every request |
| No user selection injection | No way to pass UI selections to agent loop |
| No priority-based budget | All context sources compete equally for tokens |
| No compressed history | Long conversations lose early context entirely |
| Pull-only model | LLM must know what to query; can't browse what's available |

### Why Existing Primitives Don't Solve This

**Q: Can't we use `memory.list({ tags: ['project-card'] })`?**

A: This is pull-based. The agent must explicitly query. We need push-based injection that happens automatically before every LLM call.

**Q: Can't we add a context assembly hook?**

A: A single hook is insufficient. We need:
- Multiple phases with different priorities
- Budget coordination across phases
- Compression for overflow content
- Injection point for user selections

## Design Goals

1. **Phased Assembly** — Context built in priority order, not flat
2. **Budget Awareness** — Each phase gets allocated tokens, respects limits
3. **Push + Pull** — Some content auto-included, some on-demand
4. **User Selection** — Apps can inject context per-request
5. **Progressive Disclosure** — Compressed index enables LLM to request more
6. **Backward Compatible** — Existing agents work without changes

## Non-Goals

1. ❌ Automatic summarization quality (apps can plug in their own)
2. ❌ UI for selection (app-layer concern)
3. ❌ Specific file formats (agents.md, etc.)
4. ❌ Cross-session persistence (separate concern, use existing memory)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context Assembly Pipeline                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 1: SYSTEM (priority: 100, budget: reserved)       │    │
│  │   - System prompt                                       │    │
│  │   - Pack prompt fragments                               │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 2: PROJECT CARDS (priority: 90, budget: reserved) │    │
│  │   - Always-include items (agents.md, .cursorrules)      │    │
│  │   - Memory items tagged as project-card                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 3: SELECTED (priority: 80, budget: allocated)     │    │
│  │   - User-selected items for this request                │    │
│  │   - Passed via agent.run(prompt, { selected: [...] })   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 4: SESSION (priority: 50, budget: remaining)      │    │
│  │   - Recent messages (newest first)                      │    │
│  │   - Recent tool call results                            │    │
│  │   - Truncate oldest when budget exceeded                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Phase 5: INDEX (priority: 30, budget: fixed small)      │    │
│  │   - Compressed summary of excluded messages             │    │
│  │   - Catalog of available knowledge                      │    │
│  │   - Enables LLM to request via ctx-expand tool          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Output: Assembled context string for LLM request               │
└─────────────────────────────────────────────────────────────────┘
```

## Proposed API

### 1. Context Phase Interface

```typescript
// src/types/context-pipeline.ts

/**
 * A phase in the context assembly pipeline.
 * Phases are executed in priority order (highest first).
 */
export interface ContextPhase {
  /** Unique identifier for this phase */
  id: string

  /** Higher priority = assembled earlier, gets budget first */
  priority: number

  /** How tokens are allocated to this phase */
  budget: PhaseBudget

  /**
   * Assemble context fragments for this phase.
   * @param ctx - Assembly context with runtime, selections, budget info
   * @returns Fragments to include in context
   */
  assemble(ctx: AssemblyContext): Promise<ContextFragment[]>

  /** Optional: Whether this phase is enabled */
  enabled?: boolean | ((runtime: Runtime) => boolean)
}

export type PhaseBudget =
  | { type: 'reserved'; tokens: number }      // Guaranteed allocation
  | { type: 'percentage'; value: number }     // % of total budget
  | { type: 'remaining' }                     // Whatever's left
  | { type: 'fixed'; tokens: number }         // Fixed, may be cut if over

export interface AssemblyContext {
  runtime: Runtime
  totalBudget: number                         // Total tokens available
  usedBudget: number                          // Tokens used by prior phases
  remainingBudget: number                     // Tokens available for this phase
  selectedContext: ContextSelection[]         // User selections for this request
  excludedMessages: Message[]                 // Messages cut from session phase
}

export interface ContextFragment {
  /** Source identifier for debugging */
  source: string
  /** Content to include */
  content: string
  /** Tokens used by this fragment */
  tokens: number
  /** Metadata for tracing */
  metadata?: Record<string, unknown>
}
```

### 2. Built-in Phases

```typescript
// src/context/phases/system-phase.ts

export const systemPhase: ContextPhase = {
  id: 'system',
  priority: 100,
  budget: { type: 'reserved', tokens: 2000 },

  async assemble(ctx) {
    const fragments: ContextFragment[] = []

    // System prompt
    if (ctx.runtime.systemPrompt) {
      fragments.push({
        source: 'system-prompt',
        content: ctx.runtime.systemPrompt,
        tokens: countTokens(ctx.runtime.systemPrompt)
      })
    }

    // Pack prompt fragments
    for (const pack of ctx.runtime.packs) {
      if (pack.promptFragment) {
        fragments.push({
          source: `pack:${pack.id}`,
          content: pack.promptFragment,
          tokens: countTokens(pack.promptFragment)
        })
      }
    }

    return fragments
  }
}
```

```typescript
// src/context/phases/project-cards-phase.ts

export const projectCardsPhase: ContextPhase = {
  id: 'project-cards',
  priority: 90,
  budget: { type: 'reserved', tokens: 2000 },

  async assemble(ctx) {
    const fragments: ContextFragment[] = []

    // Get Project Card memory items
    const projectCards = await ctx.runtime.memoryStorage?.list({
      tags: ['project-card'],
      status: 'active'
    }) ?? []

    // Sort by priority (higher first)
    const sorted = projectCards.sort((a, b) =>
      (b.metadata?.priority ?? 0) - (a.metadata?.priority ?? 0)
    )

    let usedTokens = 0
    for (const item of sorted) {
      const content = renderMemoryItem(item)
      const tokens = countTokens(content)

      if (usedTokens + tokens > ctx.remainingBudget) break

      fragments.push({
        source: `project-cards:${item.key}`,
        content,
        tokens,
        metadata: { key: item.key, priority: item.metadata?.priority }
      })
      usedTokens += tokens
    }

    return fragments
  }
}
```

```typescript
// src/context/phases/selected-phase.ts

export const selectedPhase: ContextPhase = {
  id: 'selected',
  priority: 80,
  budget: { type: 'percentage', value: 30 },

  async assemble(ctx) {
    if (!ctx.selectedContext.length) return []

    const fragments: ContextFragment[] = []
    let usedTokens = 0

    for (const selection of ctx.selectedContext) {
      const content = await resolveSelection(selection, ctx.runtime)
      if (!content) continue

      const tokens = countTokens(content)
      if (usedTokens + tokens > ctx.remainingBudget) break

      fragments.push({
        source: `selected:${selection.type}:${selection.ref}`,
        content,
        tokens,
        metadata: { selection }
      })
      usedTokens += tokens
    }

    return fragments
  }
}

async function resolveSelection(
  selection: ContextSelection,
  runtime: Runtime
): Promise<string | undefined> {
  switch (selection.type) {
    case 'memory':
      const item = await runtime.memoryStorage?.get(selection.ref)
      return item ? renderMemoryItem(item) : undefined

    case 'file':
      return await runtime.io.read(selection.ref)

    case 'message':
      // Parse range like '45-50'
      const [start, end] = selection.ref.split('-').map(Number)
      const messages = await runtime.messageStore?.getRange(start, end)
      return messages ? renderMessages(messages) : undefined

    default:
      return undefined
  }
}
```

```typescript
// src/context/phases/session-phase.ts

export const sessionPhase: ContextPhase = {
  id: 'session',
  priority: 50,
  budget: { type: 'remaining' },

  async assemble(ctx) {
    const messages = ctx.runtime.messages ?? []
    const fragments: ContextFragment[] = []
    const excluded: Message[] = []

    let usedTokens = 0

    // Process newest first
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const content = renderMessage(msg)
      const tokens = countTokens(content)

      if (usedTokens + tokens > ctx.remainingBudget) {
        // This message doesn't fit, exclude it
        excluded.push(msg)
        continue
      }

      fragments.unshift({  // Maintain chronological order
        source: `message:${msg.id}`,
        content,
        tokens,
        metadata: { messageId: msg.id, role: msg.role }
      })
      usedTokens += tokens
    }

    // Store excluded messages for index phase
    ctx.excludedMessages.push(...excluded)

    return fragments
  }
}
```

```typescript
// src/context/phases/index-phase.ts

export const indexPhase: ContextPhase = {
  id: 'index',
  priority: 30,
  budget: { type: 'fixed', tokens: 500 },

  async assemble(ctx) {
    const fragments: ContextFragment[] = []

    // Compress excluded messages into index
    if (ctx.excludedMessages.length > 0) {
      const compressed = await compressMessages(
        ctx.excludedMessages,
        ctx.runtime.compressor
      )

      fragments.push({
        source: 'compressed-history',
        content: `## Earlier Conversation (${ctx.excludedMessages.length} messages)\n\n${compressed.summary}\n\nUse \`ctx-expand\` tool to retrieve specific sections:\n${compressed.segments.map(s => `- ${s.id}: ${s.summary}`).join('\n')}`,
        tokens: compressed.tokens,
        metadata: { segmentCount: compressed.segments.length }
      })
    }

    // Index of available knowledge
    const knowledgeItems = await ctx.runtime.memoryStorage?.list({
      namespace: 'knowledge'
    }) ?? []

    if (knowledgeItems.length > 0) {
      const index = knowledgeItems
        .map(item => `- ${item.key}: ${item.description ?? 'No description'}`)
        .join('\n')

      fragments.push({
        source: 'knowledge-index',
        content: `## Available Knowledge (${knowledgeItems.length} items)\n\n${index}\n\nUse \`ctx-expand\` tool to retrieve specific items.`,
        tokens: countTokens(index) + 50,  // Header overhead
        metadata: { itemCount: knowledgeItems.length }
      })
    }

    return fragments
  }
}
```

### 3. Context Pipeline Executor

```typescript
// src/context/pipeline.ts

export interface ContextPipeline {
  phases: ContextPhase[]

  /** Execute pipeline and return assembled context */
  assemble(options: AssembleOptions): Promise<AssembledContext>
}

export interface AssembleOptions {
  runtime: Runtime
  totalBudget: number
  selectedContext?: ContextSelection[]
}

export interface AssembledContext {
  /** Full assembled context string */
  content: string

  /** Total tokens used */
  totalTokens: number

  /** Breakdown by phase */
  phases: PhaseResult[]

  /** Messages that were excluded (for debugging) */
  excludedMessages: Message[]
}

export interface PhaseResult {
  phaseId: string
  fragments: ContextFragment[]
  tokensUsed: number
  tokensAllocated: number
}

export function createContextPipeline(phases: ContextPhase[]): ContextPipeline {
  // Sort by priority (highest first)
  const sortedPhases = [...phases].sort((a, b) => b.priority - a.priority)

  return {
    phases: sortedPhases,

    async assemble(options) {
      const { runtime, totalBudget, selectedContext = [] } = options

      const results: PhaseResult[] = []
      const excludedMessages: Message[] = []
      let usedBudget = 0

      // Calculate budget allocations
      const allocations = calculateAllocations(sortedPhases, totalBudget)

      for (const phase of sortedPhases) {
        // Check if phase is enabled
        if (phase.enabled === false) continue
        if (typeof phase.enabled === 'function' && !phase.enabled(runtime)) continue

        const allocation = allocations.get(phase.id) ?? 0
        const remainingBudget = Math.min(allocation, totalBudget - usedBudget)

        const ctx: AssemblyContext = {
          runtime,
          totalBudget,
          usedBudget,
          remainingBudget,
          selectedContext,
          excludedMessages
        }

        const fragments = await phase.assemble(ctx)
        const tokensUsed = fragments.reduce((sum, f) => sum + f.tokens, 0)

        results.push({
          phaseId: phase.id,
          fragments,
          tokensUsed,
          tokensAllocated: allocation
        })

        usedBudget += tokensUsed
      }

      // Combine all fragments into final content
      const allFragments = results.flatMap(r => r.fragments)
      const content = allFragments.map(f => f.content).join('\n\n')

      return {
        content,
        totalTokens: usedBudget,
        phases: results,
        excludedMessages
      }
    }
  }
}

function calculateAllocations(
  phases: ContextPhase[],
  totalBudget: number
): Map<string, number> {
  const allocations = new Map<string, number>()
  let remaining = totalBudget

  // First pass: reserved budgets
  for (const phase of phases) {
    if (phase.budget.type === 'reserved') {
      const allocation = Math.min(phase.budget.tokens, remaining)
      allocations.set(phase.id, allocation)
      remaining -= allocation
    }
  }

  // Second pass: fixed budgets
  for (const phase of phases) {
    if (phase.budget.type === 'fixed') {
      const allocation = Math.min(phase.budget.tokens, remaining)
      allocations.set(phase.id, allocation)
      remaining -= allocation
    }
  }

  // Third pass: percentage budgets
  const percentageBase = remaining
  for (const phase of phases) {
    if (phase.budget.type === 'percentage') {
      const allocation = Math.floor(percentageBase * phase.budget.value / 100)
      allocations.set(phase.id, allocation)
      remaining -= allocation
    }
  }

  // Fourth pass: remaining budgets
  for (const phase of phases) {
    if (phase.budget.type === 'remaining') {
      allocations.set(phase.id, remaining)
      remaining = 0
      break  // Only one phase can have 'remaining'
    }
  }

  return allocations
}
```

### 4. Selection Injection via Agent Run

```typescript
// src/types/agent.ts

export interface AgentRunOptions {
  /** User-selected context items for this request */
  selectedContext?: ContextSelection[]

  /** Override token budget for this request */
  tokenBudget?: number

  /** Additional context phases for this request only */
  additionalPhases?: ContextPhase[]
}

export interface ContextSelection {
  /** Type of content being selected */
  type: 'memory' | 'file' | 'message' | 'url' | 'custom'

  /** Reference to the content (key, path, range, URL, etc.) */
  ref: string

  /** Max tokens for this selection (optional) */
  maxTokens?: number

  /** Custom resolver for 'custom' type */
  resolve?: (runtime: Runtime) => Promise<string>
}
```

```typescript
// Usage in application

// User selects items in UI
const userSelections: ContextSelection[] = [
  { type: 'memory', ref: 'ideas/transformer-optimization' },
  { type: 'file', ref: '/docs/architecture.md' },
  { type: 'message', ref: '45-60' },  // Message range
  { type: 'url', ref: 'https://example.com/docs' },
  {
    type: 'custom',
    ref: 'database-schema',
    resolve: async (runtime) => {
      const schema = await fetchDatabaseSchema()
      return formatSchema(schema)
    }
  }
]

// Pass to agent run
const result = await agent.run('Help me optimize this query', {
  selectedContext: userSelections,
  tokenBudget: 16000
})
```

### 5. History Compression

```typescript
// src/types/context-pipeline.ts

export interface HistoryCompressor {
  /**
   * Compress messages into a summary with addressable segments.
   */
  compress(messages: Message[], options?: CompressOptions): Promise<CompressedHistory>
}

export interface CompressOptions {
  /** Max tokens for the compressed output */
  maxTokens?: number

  /** How to segment messages */
  segmentStrategy?: 'fixed-size' | 'topic-based' | 'time-based'

  /** Target segment size (for fixed-size) */
  segmentSize?: number
}

export interface CompressedHistory {
  /** Human-readable summary of all messages */
  summary: string

  /** Addressable segments for retrieval */
  segments: HistorySegment[]

  /** Total tokens used by this compression */
  tokens: number
}

export interface HistorySegment {
  /** Unique ID for retrieval */
  id: string

  /** Message range (inclusive) */
  range: { start: number; end: number }

  /** Short summary of this segment */
  summary: string

  /** Keywords for search */
  keywords: string[]

  /** Number of messages in segment */
  messageCount: number
}
```

```typescript
// src/context/compressors/simple-compressor.ts

/**
 * Simple compressor that groups messages and generates summaries.
 * Apps can replace with LLM-based compressor for better quality.
 */
export class SimpleHistoryCompressor implements HistoryCompressor {
  async compress(messages: Message[], options?: CompressOptions): Promise<CompressedHistory> {
    const segmentSize = options?.segmentSize ?? 20
    const segments: HistorySegment[] = []

    // Group messages into segments
    for (let i = 0; i < messages.length; i += segmentSize) {
      const segmentMessages = messages.slice(i, i + segmentSize)
      const segment = this.createSegment(segmentMessages, i, segments.length)
      segments.push(segment)
    }

    // Generate overall summary
    const summary = segments.length > 0
      ? `${messages.length} messages in ${segments.length} segments covering: ${segments.map(s => s.summary).join('; ')}`
      : 'No excluded messages'

    return {
      summary,
      segments,
      tokens: countTokens(summary) + segments.reduce((sum, s) => sum + countTokens(s.summary), 0)
    }
  }

  private createSegment(messages: Message[], startIndex: number, segmentIndex: number): HistorySegment {
    // Extract topics/keywords from messages
    const keywords = this.extractKeywords(messages)
    const summary = this.generateSummary(messages)

    return {
      id: `seg-${segmentIndex}`,
      range: { start: startIndex, end: startIndex + messages.length - 1 },
      summary,
      keywords,
      messageCount: messages.length
    }
  }

  private extractKeywords(messages: Message[]): string[] {
    // Simple keyword extraction (apps can use better NLP)
    const text = messages.map(m => m.content).join(' ')
    const words = text.toLowerCase().split(/\W+/)
    const counts = new Map<string, number>()

    for (const word of words) {
      if (word.length > 4) {  // Skip short words
        counts.set(word, (counts.get(word) ?? 0) + 1)
      }
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word)
  }

  private generateSummary(messages: Message[]): string {
    const roles = messages.reduce((acc, m) => {
      acc[m.role] = (acc[m.role] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)

    const toolCalls = messages.filter(m => m.toolCall).length

    return `${messages.length} messages (${roles.user ?? 0} user, ${roles.assistant ?? 0} assistant)${toolCalls > 0 ? `, ${toolCalls} tool calls` : ''}`
  }
}
```

```typescript
// src/context/compressors/llm-compressor.ts

/**
 * LLM-based compressor for higher quality summaries.
 */
export class LLMHistoryCompressor implements HistoryCompressor {
  constructor(private llmClient: LLMClient) {}

  async compress(messages: Message[], options?: CompressOptions): Promise<CompressedHistory> {
    const segmentSize = options?.segmentSize ?? 20
    const segments: HistorySegment[] = []

    // Group and summarize each segment with LLM
    for (let i = 0; i < messages.length; i += segmentSize) {
      const segmentMessages = messages.slice(i, i + segmentSize)
      const segment = await this.summarizeSegment(segmentMessages, i, segments.length)
      segments.push(segment)
    }

    // Generate overall summary with LLM
    const summary = await this.generateOverallSummary(segments)

    return {
      summary,
      segments,
      tokens: countTokens(summary) + segments.reduce((sum, s) => sum + countTokens(s.summary), 0)
    }
  }

  private async summarizeSegment(messages: Message[], startIndex: number, segmentIndex: number): Promise<HistorySegment> {
    const messagesText = messages.map(m => `[${m.role}]: ${m.content.slice(0, 200)}`).join('\n')

    const result = await this.llmClient.generate({
      system: 'Summarize this conversation segment in 1-2 sentences. Extract 3-5 key topics.',
      prompt: messagesText,
      maxTokens: 100
    })

    // Parse LLM response (simplified)
    const [summary, ...keywords] = result.split('\n')

    return {
      id: `seg-${segmentIndex}`,
      range: { start: startIndex, end: startIndex + messages.length - 1 },
      summary: summary.trim(),
      keywords: keywords.map(k => k.trim()).filter(Boolean),
      messageCount: messages.length
    }
  }

  private async generateOverallSummary(segments: HistorySegment[]): Promise<string> {
    const segmentSummaries = segments.map(s => `- ${s.id}: ${s.summary}`).join('\n')

    const result = await this.llmClient.generate({
      system: 'Create a brief overview of this conversation history.',
      prompt: segmentSummaries,
      maxTokens: 150
    })

    return result.trim()
  }
}
```

### 6. Context Expand Tool

```typescript
// src/tools/ctx-expand.ts

export const ctxExpandTool = defineTool({
  name: 'ctx-expand',
  description: `Retrieve specific context that was summarized in the compressed history index.

Use this when you need details about earlier conversation or knowledge items.

Examples:
- ctx-expand({ type: 'segment', ref: 'seg-0' })  // Get messages from segment 0
- ctx-expand({ type: 'message', ref: '45-60' })  // Get specific message range
- ctx-expand({ type: 'memory', ref: 'ideas/optimization' })  // Get knowledge item
- ctx-expand({ type: 'search', ref: 'authentication bug' })  // Search history`,

  parameters: {
    type: {
      type: 'string',
      enum: ['segment', 'message', 'memory', 'search'],
      required: true,
      description: 'Type of context to retrieve'
    },
    ref: {
      type: 'string',
      required: true,
      description: 'Reference: segment ID, message range, memory key, or search query'
    },
    maxTokens: {
      type: 'number',
      required: false,
      description: 'Max tokens to return (default: 2000)'
    }
  },

  execute: async ({ type, ref, maxTokens = 2000 }, runtime) => {
    switch (type) {
      case 'segment': {
        // Retrieve messages from a compressed segment
        const segment = runtime.compressedHistory?.segments.find(s => s.id === ref)
        if (!segment) {
          return { success: false, error: `Segment not found: ${ref}` }
        }

        const messages = await runtime.messageStore?.getRange(
          segment.range.start,
          segment.range.end
        )

        return {
          success: true,
          data: {
            segment: ref,
            range: segment.range,
            messages: truncateToTokens(renderMessages(messages), maxTokens)
          }
        }
      }

      case 'message': {
        // Parse range like '45-60' or single message '45'
        const [start, end] = ref.includes('-')
          ? ref.split('-').map(Number)
          : [Number(ref), Number(ref)]

        const messages = await runtime.messageStore?.getRange(start, end)
        if (!messages?.length) {
          return { success: false, error: `Messages not found: ${ref}` }
        }

        return {
          success: true,
          data: {
            range: { start, end },
            messages: truncateToTokens(renderMessages(messages), maxTokens)
          }
        }
      }

      case 'memory': {
        const item = await runtime.memoryStorage?.get(ref)
        if (!item) {
          return { success: false, error: `Memory item not found: ${ref}` }
        }

        return {
          success: true,
          data: {
            key: ref,
            content: truncateToTokens(renderMemoryItem(item), maxTokens)
          }
        }
      }

      case 'search': {
        // Search across history and memory
        const historyResults = await runtime.messageStore?.search(ref, { limit: 5 })
        const memoryResults = await runtime.memoryStorage?.search({ query: ref, limit: 5 })

        return {
          success: true,
          data: {
            query: ref,
            historyMatches: historyResults?.map(m => ({
              id: m.id,
              preview: m.content.slice(0, 200)
            })),
            memoryMatches: memoryResults?.map(item => ({
              key: item.key,
              preview: String(item.value).slice(0, 200)
            }))
          }
        }
      }

      default:
        return { success: false, error: `Unknown type: ${type}` }
    }
  }
})
```

### 7. Integration with AgentLoop

```typescript
// src/agent/agent-loop.ts (modified)

export class AgentLoop {
  private pipeline: ContextPipeline

  constructor(config: AgentLoopConfig) {
    // Initialize pipeline with default phases
    this.pipeline = createContextPipeline([
      systemPhase,
      projectCardsPhase,
      selectedPhase,
      workingSetPhase,
      stateSummaryPhase,
      sessionPhase,
      indexPhase,
      // Apps can add custom phases via config
      ...(config.additionalPhases ?? [])
    ])
  }

  async run(prompt: string, options?: AgentRunOptions): Promise<AgentResult> {
    const { selectedContext = [], tokenBudget = 8000 } = options ?? {}

    // Assemble context using pipeline
    const assembled = await this.pipeline.assemble({
      runtime: this.runtime,
      totalBudget: tokenBudget,
      selectedContext
    })

    // Store compressed history for ctx-expand tool
    this.runtime.compressedHistory = {
      segments: assembled.phases.find(p => p.phaseId === 'index')
        ?.fragments.find(f => f.source === 'compressed-history')
        ?.metadata?.segments ?? []
    }

    // Build messages for LLM
    const messages = [
      { role: 'system', content: assembled.content },
      { role: 'user', content: prompt }
    ]

    // Continue with LLM call...
  }
}
```

### 8. Pack for Context Pipeline

```typescript
// src/packs/context-pipeline.ts

export function contextPipelinePack(options?: ContextPipelineOptions): Pack {
  const compressor = options?.compressor ?? new SimpleHistoryCompressor()

  return definePack({
    id: 'context-pipeline',
    description: 'Phased context assembly with compression and expansion',

    tools: [ctxExpandTool],

    promptFragment: `
## Context System

Your context is assembled in phases:
1. System configuration (always present)
2. Project Cards (long-term memory)
3. WorkingSet (runtime focus)
4. User-selected items (explicit selections)
5. State summary (session memory)
6. Recent session history
7. Compressed index of older history

If you need information from the compressed index, use the ctx-expand tool.
`,

    onInit: async (runtime) => {
      runtime.compressor = compressor
    }
  })
}
```

## Example: Complete Application

```typescript
// Application using the context pipeline

import { createAgent, packs } from 'agent-foundry'
import { contextPipelinePack, LLMHistoryCompressor } from 'agent-foundry/context'

// Create agent with context pipeline
const agent = createAgent({
  packs: [
    packs.standard(),
    packs.kvMemory(),
    contextPipelinePack({
      compressor: new LLMHistoryCompressor(llmClient)  // Better summaries
    })
  ]
})

// Pin important project knowledge (done once or via UI)
await agent.runtime.memoryStorage.put('config/agents', agentsMdContent, {
  tags: ['project-card'],
  metadata: { priority: 100 }  // High priority
})

await agent.runtime.memoryStorage.put('knowledge/architecture', architectureDoc, {
  tags: ['project-card'],
  metadata: { priority: 50 }
})

// User selects items in UI for this request
const userSelections: ContextSelection[] = [
  { type: 'memory', ref: 'ideas/caching-strategy' },
  { type: 'file', ref: '/src/db/queries.ts' },
  { type: 'message', ref: '100-120' }  // Earlier discussion
]

// Run agent with selections
const result = await agent.run('How should we optimize the database queries?', {
  selectedContext: userSelections,
  tokenBudget: 16000
})

// Context assembled:
// 1. System prompt + pack fragments (reserved: 2000 tokens)
// 2. Project Cards: agents.md, architecture doc (reserved: 2000 tokens)
// 3. Selected: caching idea, queries.ts, messages 100-120 (30%: ~3600 tokens)
// 4. Session: recent messages (remaining: ~7900 tokens)
// 5. Index: compressed older history (fixed: 500 tokens)
```

## Migration Path

### Phase 1: Add Pipeline (Non-Breaking)

- Add `ContextPhase` interface and built-in phases
- Add `ContextPipeline` executor
- Add `contextPipelinePack`
- Existing agents continue to work (use default flat assembly)

### Phase 2: Integrate with AgentLoop

- AgentLoop uses pipeline when pack is included
- Add `selectedContext` to `AgentRunOptions`
- Add `ctx-expand` tool

### Phase 3: Make Default

- Pipeline becomes default context assembly
- Old flat assembly deprecated
- Migration guide for custom context handling

## Comparison: Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| Context assembly | Flat, unordered | Phased, priority-ordered |
| Budget allocation | Per-source, uncoordinated | Coordinated across phases |
| Always-include | Not supported | Project Cards phase with reserved budget |
| User selection | Not supported | `selectedContext` in run options |
| Long conversations | Early messages lost | Compressed index + ctx-expand |
| LLM context awareness | Doesn't know what's available | Index shows retrievable content |

## Success Metrics

1. **Phase Execution**: All phases execute in priority order
2. **Budget Respect**: Total tokens stay within budget
3. **Selection Works**: User selections appear in context
4. **Compression Quality**: LLM can retrieve relevant history via ctx-expand
5. **Backward Compatible**: Existing agents work without changes

## Open Questions

1. **Compression Quality**: How good is simple keyword extraction? When to use LLM compression?
   - Proposal: Simple by default, LLM compression opt-in

2. **Segment Granularity**: Fixed-size vs topic-based segmentation?
   - Proposal: Fixed-size default, topic-based as option

3. **Cache Invalidation**: When to regenerate compressed history?
   - Proposal: Regenerate when excluded messages change

4. **Multi-Turn Selection**: Should selections persist across turns?
   - Proposal: Per-request by default, app can persist if needed

## References

- Current context system: `src/core/context-manager.ts`, `src/types/context.ts`
- Session history: `src/core/message-store.ts`
- Memory storage: `src/core/memory-storage.ts`
- Agent loop: `src/agent/agent-loop.ts`
