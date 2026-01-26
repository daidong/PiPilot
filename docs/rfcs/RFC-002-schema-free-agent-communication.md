# RFC-002: Schema-Free Agent Communication

## Summary

This RFC proposes simplifying the AgentFoundry Team API by removing mandatory Zod schemas in favor of a **schema-free** approach with **JSON output mode** and **Object I/O**. This reduces boilerplate by 60-70% while maintaining the serialization efficiency gains from RFC-001.

## Motivation

### Current Pain Points

RFC-001 introduced contract-first design with Zod schemas to eliminate serialization tax. However, user feedback reveals new pain points:

1. **Schema Overhead**: Users spend 30-50% of code defining Zod schemas
2. **Schema Design Difficulty**: Hard to predict exact LLM output structure
3. **Parse Failures**: LLM may not always produce schema-compliant output
4. **Over-Engineering**: Most agent-to-agent communication doesn't need strict contracts

### Key Insight

From analyzing the A2A protocol and industry practices:

> **LLM-to-LLM communication doesn't require strict schemas.**
>
> - LLMs can understand varied input formats (like humans)
> - Schemas are for **code**, not for **LLM understanding**
> - The serialization tax came from **string I/O**, not from **lack of schemas**

### The Real Problem RFC-001 Solved

| Problem | Solution | Requires Schema? |
|---------|----------|------------------|
| Multiple JSON.stringify/parse | Object I/O | ❌ No |
| Regex extraction from markdown | JSON output mode | ❌ No |
| TypeScript type safety | Zod schemas | ✅ Yes (optional) |
| Output format validation | Zod schemas | ✅ Yes (optional) |

**We can keep the serialization benefits without mandatory schemas.**

## Design Principles

1. **Schema-Free by Default**: No Zod definitions required
2. **JSON Output Mode**: Ensure valid JSON without strict schema
3. **Object I/O**: Pass objects between agents, no stringify/parse
4. **Prompt Engineering**: Describe expected structure in system prompt
5. **Graceful Uncertainty**: Use optional chaining for field access
6. **Schema as Enhancement**: Optional schemas when code needs guarantees

## Proposed API

### 1. Simple Agent Definition

```typescript
import { defineAgent } from 'agent-foundry/team'

// Minimal agent - no schemas required
const researcher = defineAgent({
  id: 'researcher',
  system: `You are a research assistant.

Output your findings as JSON:
{
  "findings": [{ "title": "string", "summary": "string", "relevance": "high|medium|low" }],
  "recommendation": "string"
}`,
  prompt: (input) => `Research this topic: ${input.topic ?? input}`
})

const reviewer = defineAgent({
  id: 'reviewer',
  system: `You are a quality reviewer.

Output your review as JSON:
{
  "approved": boolean,
  "feedback": "string",
  "score": number (1-10)
}`,
  prompt: (input) => `Review this research:\n\n${format(input)}`
})
```

### 2. Team Definition

```typescript
import { defineTeam, seq, branch, step } from 'agent-foundry/team'

const researchTeam = defineTeam({
  id: 'research-team',
  agents: { researcher, reviewer },

  flow: seq(
    step('researcher'),
    step('reviewer'),
    branch({
      if: (state) => state.reviewer?.approved === true,
      then: step('publisher'),
      else: step('reviser')
    })
  )
})
```

### 3. Step with Input/Output Mapping

```typescript
// Explicit input/output paths (optional)
const team = defineTeam({
  id: 'analysis-team',
  agents: { analyzer, summarizer, reviewer },

  flow: seq(
    // Simple: output stored at agent id
    step('analyzer'),  // output → state.analyzer

    // Explicit paths
    step('summarizer')
      .from('analyzer.findings')  // read from path
      .to('summary'),             // write to path

    // Transform input
    step('reviewer')
      .from((state) => ({
        content: state.summary,
        originalFindings: state.analyzer.findings
      }))
      .to('review')
  )
})
```

### 4. Built-in Format Helper

```typescript
import { format } from 'agent-foundry/team'

const agent = defineAgent({
  id: 'writer',
  system: '...',
  prompt: (input) => `
Write based on this research:

${format(input)}

Focus on the key findings.
`
})

// format() intelligently converts input:
// - Object → JSON with 2-space indent
// - Array → numbered list or JSON based on content
// - String → as-is
// - Undefined → "(no input)"
```

### 5. Optional Schema (When Needed)

```typescript
import { defineAgent, withSchema } from 'agent-foundry/team'
import { z } from 'zod'

// Only add schema when code needs specific field access
const reviewer = defineAgent({
  id: 'reviewer',
  system: '...',
  prompt: (input) => `...`,

  // Optional: adds validation + TypeScript types
  output: withSchema(z.object({
    approved: z.boolean(),
    score: z.number()
  }))
})

// Now TypeScript knows the output type
// And validation runs automatically with retry on failure
```

### 6. Configuration Options

```typescript
const agent = defineAgent({
  id: 'agent',
  system: '...',
  prompt: (input) => '...',

  // Optional configuration
  config: {
    // JSON output mode (default: true)
    jsonMode: true,

    // Retry on JSON parse failure (default: 2)
    maxRetries: 2,

    // Temperature (default: 0.7)
    temperature: 0.7,

    // Model override
    model: 'gpt-4o'
  }
})
```

## Complete Example: Literature Research Team

### Before (with Schemas) - ~150 lines

```typescript
// schemas.ts - 60 lines of Zod definitions
const QueryPlanSchema = z.object({
  queries: z.array(z.string()),
  sources: z.array(z.enum(['arxiv', 'semantic_scholar'])),
  timeRange: z.object({ start: z.number(), end: z.number() }).optional()
})

const PaperSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number(),
  abstract: z.string(),
  citations: z.number()
})

const SearchResultsSchema = z.object({
  papers: z.array(PaperSchema),
  totalFound: z.number()
})

const ReviewSchema = z.object({
  approved: z.boolean(),
  relevantPapers: z.array(PaperSchema),
  issues: z.array(z.string()),
  additionalQueries: z.array(z.string()).optional()
})

// agents.ts - 90 lines
const planner = defineLLMAgent({
  id: 'planner',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: QueryPlanSchema,
  system: '...',
  buildPrompt: (input) => `...`
})

// ... more agents with full schema definitions
```

### After (Schema-Free) - ~50 lines

```typescript
import { defineAgent, defineTeam, seq, branch, step, format } from 'agent-foundry/team'

// Agents - clean and simple
const planner = defineAgent({
  id: 'planner',
  system: `You are a query planner for academic research.

Output JSON:
{
  "queries": ["search query 1", "search query 2"],
  "sources": ["arxiv", "semantic_scholar"],
  "timeRange": { "start": 2020, "end": 2024 } // optional
}`,
  prompt: (input) => `Plan search queries for: ${input.topic ?? input}`
})

const searcher = defineAgent({
  id: 'searcher',
  type: 'tool',  // Uses tool instead of LLM
  tool: 'literature.search',
  mapInput: (plan) => ({
    queries: plan.queries,
    sources: plan.sources
  })
})

const reviewer = defineAgent({
  id: 'reviewer',
  system: `You are a research quality reviewer.

Output JSON:
{
  "approved": boolean,
  "relevantPapers": [{ "title": "...", "reason": "..." }],
  "issues": ["issue 1", "issue 2"],
  "additionalQueries": ["query 1"] // if not approved
}`,
  prompt: (input) => `Review these search results:\n\n${format(input)}`
})

const summarizer = defineAgent({
  id: 'summarizer',
  system: `You are a research synthesizer.

Output JSON:
{
  "title": "string",
  "summary": "string",
  "keyFindings": ["finding 1", "finding 2"],
  "gaps": ["gap 1", "gap 2"]
}`,
  prompt: (input) => `Synthesize findings from:\n\n${format(input.relevantPapers)}`
})

// Team definition
export const literatureTeam = defineTeam({
  id: 'literature-research',
  agents: { planner, searcher, reviewer, summarizer },

  flow: seq(
    step('planner'),
    step('searcher').from('planner'),
    step('reviewer').from('searcher'),
    branch({
      if: (s) => s.reviewer?.approved !== true,
      then: seq(
        step('searcher').from((s) => ({
          queries: s.reviewer?.additionalQueries ?? [],
          sources: ['arxiv', 'semantic_scholar']
        })),
        step('reviewer').from('searcher')
      ),
      maxIterations: 2
    }),
    step('summarizer').from('reviewer')
  )
})

// Usage
const result = await literatureTeam.run({ topic: 'transformer architectures' })
console.log(result.summarizer.title)
console.log(result.summarizer.keyFindings)
```

## State Management

### State Structure

```typescript
// State is a simple object, keyed by agent id or custom path
interface TeamState {
  [agentId: string]: unknown  // Agent outputs
  [customPath: string]: unknown  // Custom paths from .to()
}

// Example state after execution:
{
  planner: { queries: [...], sources: [...] },
  searcher: { papers: [...], totalFound: 42 },
  reviewer: { approved: true, relevantPapers: [...] },
  summarizer: { title: '...', summary: '...', keyFindings: [...] }
}
```

### Accessing State in Branches

```typescript
branch({
  // Safe access with optional chaining
  if: (state) => state.reviewer?.approved === true,

  // Or with nullish coalescing
  if: (state) => (state.reviewer?.score ?? 0) >= 7,

  // Or with helper
  if: (state) => get(state, 'reviewer.approved', false),

  then: step('publisher'),
  else: step('reviser')
})
```

## Migration Path

### Phase 1: Add Schema-Free API (Non-Breaking)

- Add `defineAgent()` as alias for schema-free agents
- Existing `defineLLMAgent()` with schemas continues to work
- Both can coexist in same team

### Phase 2: Soft Deprecation

- Log info message when using verbose schema definitions
- Suggest schema-free alternative in docs
- Update examples to schema-free style

### Phase 3: Documentation Update

- Rewrite Team documentation with schema-free as default
- Add "Advanced: Using Schemas" section for when needed
- Update all examples

## Comparison with Industry

| Framework | Schema Approach |
|-----------|-----------------|
| **A2A Protocol** | Parts + MIME types, no strict schema |
| **ACP Protocol** | Flexible task schemas |
| **LangGraph** | TypedDict optional, often untyped |
| **CrewAI** | Pydantic optional, string I/O common |
| **AutoGen** | No schema requirement |
| **AgentFoundry (new)** | Schema-free default, optional schemas |

## FAQ

### Q: What if LLM outputs invalid JSON?

**A:** JSON output mode (`responseFormat: { type: "json_object" }`) ensures valid JSON. If parsing still fails, automatic retry kicks in (default: 2 retries).

### Q: What if LLM outputs unexpected fields?

**A:** That's fine! Use optional chaining (`result?.field`) and provide fallbacks. LLMs are flexible—downstream agents can handle variations.

### Q: When should I use schemas?

**A:** Add schemas when:
1. Code needs guaranteed field access (not just LLM-to-LLM)
2. Storing to database with specific columns
3. External API expects exact format
4. You want TypeScript autocomplete

### Q: Is this less reliable than schemas?

**A:** Different trade-off:
- Schemas: Fail fast on format mismatch
- Schema-free: Graceful degradation, LLM handles variations

For production, combine schema-free with good prompt engineering and monitoring.

## Implementation Plan

### Week 1: Core API
- [ ] `defineAgent()` function
- [ ] `format()` helper
- [ ] JSON output mode integration
- [ ] Retry on parse failure

### Week 2: Team Integration
- [ ] Update `step()` to work with schema-free agents
- [ ] `.from()` and `.to()` path mapping
- [ ] State management updates

### Week 3: Testing & Examples
- [ ] Unit tests for new API
- [ ] Migrate literature-agent example
- [ ] Migrate dataanalysis-agent example

### Week 4: Documentation
- [ ] Update TEAM.md
- [ ] Update API.md
- [ ] Migration guide

## Success Metrics

1. **Code Reduction**: 60%+ fewer lines in team definitions
2. **No Schema Requirement**: New users can build teams without Zod
3. **Maintained Efficiency**: No serialization regression (Object I/O preserved)
4. **Backward Compatible**: Existing schema-based teams continue to work

## References

- [RFC-001: Contract-First Team System](./RFC-001-contract-first-team-system.md)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/)
- [Agent Communication Protocol (ACP)](https://www.ibm.com/think/topics/agent-communication-protocol)
- [OpenAI JSON Mode](https://platform.openai.com/docs/guides/structured-outputs)
