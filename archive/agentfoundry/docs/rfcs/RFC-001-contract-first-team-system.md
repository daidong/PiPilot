# RFC-001: Contract-First Team System with Structured I/O

## Summary

This RFC proposes a fundamental redesign of the AgentFoundry team system to adopt a **contract-first** approach with **structured input/output** as the internal default. The goal is to eliminate the "protocol and glue" code that users currently write, reducing complexity by 60-80%.

## Problem Statement

The current `literature-agent` example demonstrates ~2,160 lines of code. Analysis reveals that users are forced to write "protocol layer" code that should be handled by the framework:

### Root Causes

| Root Cause | Symptom | Impact |
|------------|---------|--------|
| No unified message envelope | Triple serialization tax (JSON stringify/parse at every boundary) | Each agent: parse input → regex extract JSON → parse again |
| Edge adaptation not first-class | Searcher handles 3 different input shapes | Agents become "multi-modal adapters" instead of single-purpose |
| Structured output delegated to agents | Every LLM agent writes regex to extract JSON from markdown | Duplicated, fragile code |
| State blackboard untyped | String paths + `unknown` values | Errors surface late, no IDE support |
| No runtime-level events | Users write `onProgress` callbacks in invokers | Repeated boilerplate |
| Until conditions don't express business semantics | `noCriticalIssues` instead of `approved === true` | Concept mapping overhead |

### Current Pain: String I/O Serialization Tax

```
User Request (object)
    ↓ JSON.stringify (Team)
Agent.run(input: string)
    ↓ JSON.parse (Agent)
    ↓ Build prompt
    ↓ LLM generates text
    ↓ Regex extract ```json block
    ↓ JSON.parse (Agent)
    ↓ JSON.stringify (Agent return)
Agent returns { output: string }
    ↓ JSON.parse (Team)
State stores object
    ↓ JSON.stringify (next invoke)
... repeat for every agent ...
```

**This is 6+ serialization operations per agent invocation.** With a 4-agent pipeline doing 2 review loops, that's 48+ unnecessary parse/stringify operations.

## Proposed Design

### Core Principle: Contract-First

Every agent declares its input and output schemas. The framework:
1. Validates inputs before invoking agents
2. Uses AI SDK's structured output (`Output.object`) to guarantee typed responses
3. Stores objects in state, never JSON strings
4. Validates outputs before passing to next agent

### 1. Structured LLM Client (`src/llm/structured.ts`)

A unified LLM calling facade that handles structured output, retry, and repair:

```typescript
import { generateText, Output } from 'ai'
import type { ZodSchema } from 'zod'

export interface StructuredCallOptions<T> {
  model: LanguageModelV1
  system?: string
  prompt?: string
  messages?: CoreMessage[]

  // Structured output
  schema: ZodSchema<T>
  schemaName?: string
  schemaDescription?: string

  // Optional
  tools?: Record<string, CoreTool>
  temperature?: number
  maxTokens?: number

  // Retry and repair
  retries?: number
  repair?: (error: unknown) => { system?: string; prompt?: string }

  // Observability
  trace?: (event: TraceEvent) => void
}

export async function generateStructured<T>(
  options: StructuredCallOptions<T>
): Promise<T> {
  const {
    model, system, prompt, messages,
    schema, schemaName, schemaDescription,
    tools, temperature, maxTokens,
    retries = 1, repair, trace
  } = options

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      trace?.({ type: 'llm.call.start', attempt, schemaName })

      const result = await generateText({
        model,
        system,
        prompt,
        messages,
        tools,
        temperature,
        maxTokens,
        // AI SDK structured output - validates automatically
        output: Output.object({
          schema,
          name: schemaName,
          description: schemaDescription
        })
      })

      trace?.({ type: 'llm.call.ok', attempt, schemaName })
      return result.output as T

    } catch (error) {
      trace?.({ type: 'llm.call.fail', attempt, schemaName, error: String(error) })

      if (attempt === retries || !repair) throw error

      // Apply repair strategy for next attempt
      const fix = repair(error)
      if (fix.system) options.system = fix.system
      if (fix.prompt) options.prompt = fix.prompt
    }
  }

  throw new Error('generateStructured: unreachable')
}
```

### 2. LLM Agent Definition (`src/agent/define-llm-agent.ts`)

A specialized factory for LLM-only agents (no tools):

```typescript
import { z, ZodSchema } from 'zod'
import { generateStructured } from '../llm/structured.js'

export interface LLMAgentDefinition<TInput, TOutput> {
  id: string
  description?: string

  // Model configuration
  model?: string
  temperature?: number
  maxTokens?: number

  // Contract
  inputSchema: ZodSchema<TInput>
  outputSchema: ZodSchema<TOutput>

  // Prompt generation
  system: string
  buildPrompt: (input: TInput) => string

  // Optional hooks
  preProcess?: (input: TInput) => TInput | Promise<TInput>
  postProcess?: (output: TOutput) => TOutput | Promise<TOutput>
}

export interface LLMAgent<TInput, TOutput> {
  id: string
  kind: 'llm-agent'
  inputSchema: ZodSchema<TInput>
  outputSchema: ZodSchema<TOutput>

  run: (input: TInput, ctx: AgentContext) => Promise<TOutput>
}

export function defineLLMAgent<TInput, TOutput>(
  definition: LLMAgentDefinition<TInput, TOutput>
): LLMAgent<TInput, TOutput> {
  return {
    id: definition.id,
    kind: 'llm-agent',
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,

    async run(input: TInput, ctx: AgentContext): Promise<TOutput> {
      // 1. Validate input
      const validatedInput = definition.inputSchema.parse(input)

      // 2. Optional pre-processing
      const processedInput = definition.preProcess
        ? await definition.preProcess(validatedInput)
        : validatedInput

      // 3. Build prompt
      const prompt = definition.buildPrompt(processedInput)

      // 4. Call LLM with structured output
      const output = await generateStructured({
        model: ctx.getLanguageModel(definition.model),
        system: definition.system,
        prompt,
        schema: definition.outputSchema,
        schemaName: `${definition.id}Output`,
        temperature: definition.temperature,
        maxTokens: definition.maxTokens,
        trace: ctx.trace
      })

      // 5. Optional post-processing
      return definition.postProcess
        ? await definition.postProcess(output)
        : output
    }
  }
}
```

### 3. Tool Agent Definition (`src/agent/define-tool-agent.ts`)

For agents that wrap a tool with typed I/O:

```typescript
export interface ToolAgentDefinition<TInput, TOutput> {
  id: string
  description?: string

  // Tool to execute
  tool: string  // Tool ID from registry

  // Contract
  inputSchema: ZodSchema<TInput>
  outputSchema: ZodSchema<TOutput>

  // Input transformation (from agent input to tool input)
  buildToolInput?: (input: TInput) => unknown

  // Output transformation (from tool output to agent output)
  transformOutput?: (toolOutput: unknown) => TOutput
}

export function defineToolAgent<TInput, TOutput>(
  definition: ToolAgentDefinition<TInput, TOutput>
): ToolAgent<TInput, TOutput>
```

### 4. Typed State Blackboard (`src/team/state/typed-blackboard.ts`)

State with schema validation:

```typescript
import { z, ZodSchema } from 'zod'

export interface StateSchema {
  [key: string]: ZodSchema<unknown>
}

export function createTypedState<T extends StateSchema>(schema: T) {
  type StateType = {
    [K in keyof T]: z.infer<T[K]>
  }

  const state = new Map<string, unknown>()

  return {
    schema,

    get<K extends keyof T>(key: K): z.infer<T[K]> | undefined {
      return state.get(key as string) as z.infer<T[K]> | undefined
    },

    set<K extends keyof T>(key: K, value: z.infer<T[K]>): void {
      // Validate before storing
      const validated = schema[key].parse(value)
      state.set(key as string, validated)
    },

    // Path-based access for nested objects
    getPath<R>(path: string): R | undefined {
      const [root, ...rest] = path.split('.')
      let value = state.get(root)
      for (const key of rest) {
        if (value == null || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[key]
      }
      return value as R
    }
  }
}

// Helper for defining state schema in team
export const state = {
  schema: <T extends StateSchema>(schema: T) => ({
    type: 'typed-state' as const,
    schema
  }),

  path: <T>(path: string) => ({
    type: 'state-ref' as const,
    path,
    _phantom: undefined as unknown as T
  }),

  initial: <T>() => ({
    type: 'initial-ref' as const,
    _phantom: undefined as unknown as T
  })
}
```

### 5. Edge Adaptation Combinators (`src/team/flow/edges.ts`)

First-class edge transformation:

```typescript
// Transform input before passing to next step
export function mapInput<TFrom, TTo>(
  source: InputRef<TFrom>,
  transform: (input: TFrom) => TTo
): InputRef<TTo> {
  return {
    type: 'mapped',
    source,
    transform
  }
}

// Conditional branching without polluting agent logic
export function branch<T>(config: {
  when: (state: T) => boolean
  then: FlowSpec
  else: FlowSpec
}): FlowSpec {
  return {
    kind: 'branch',
    condition: config.when,
    then: config.then,
    else: config.else
  }
}

// No-op step (for conditional branches that skip)
export const noop: FlowSpec = { kind: 'noop' }
```

### 6. Step Builder Pattern (`src/team/flow/step.ts`)

Fluent API for step definition:

```typescript
export function step<TInput, TOutput>(
  agent: LLMAgent<TInput, TOutput> | ToolAgent<TInput, TOutput>
) {
  return {
    in<TIn extends TInput>(input: InputRef<TIn>) {
      return {
        out(statePath: StateRef<TOutput>) {
          return {
            kind: 'invoke' as const,
            agent: agent.id,
            input,
            outputAs: statePath,
            // Carry schemas for validation
            _inputSchema: agent.inputSchema,
            _outputSchema: agent.outputSchema
          }
        },
        // If no output storage needed
        build() {
          return {
            kind: 'invoke' as const,
            agent: agent.id,
            input,
            _inputSchema: agent.inputSchema,
            _outputSchema: agent.outputSchema
          }
        }
      }
    }
  }
}
```

### 7. Business-Semantic Until Conditions (`src/team/flow/until.ts`)

Expressive stop conditions:

```typescript
export const until = {
  // Direct field comparison
  field: <T>(path: StateRef<T>) => ({
    eq: (value: T): UntilSpec => ({
      type: 'field-eq',
      path: path.path,
      value
    }),
    neq: (value: T): UntilSpec => ({
      type: 'field-neq',
      path: path.path,
      value
    }),
    truthy: (): UntilSpec => ({
      type: 'field-truthy',
      path: path.path
    }),
    falsy: (): UntilSpec => ({
      type: 'field-falsy',
      path: path.path
    })
  }),

  // Schema-based validator
  validator: <T>(
    path: StateRef<T>,
    schema: ZodSchema<T>,
    check: (value: T) => boolean
  ): UntilSpec => ({
    type: 'validator',
    path: path.path,
    schema,
    check
  }),

  // Existing conditions
  maxIterations: (n: number): UntilSpec => ({
    type: 'max-iterations',
    count: n
  }),

  noProgress: (windowSize?: number): UntilSpec => ({
    type: 'no-progress',
    windowSize
  })
}
```

### 8. Runtime Events (`src/team/runtime/events.ts`)

First-class event system:

```typescript
export interface TeamRuntimeEvents {
  'team.started': { teamId: string; input: unknown }
  'team.completed': { teamId: string; output: unknown; durationMs: number }
  'team.failed': { teamId: string; error: Error }

  'agent.started': { agentId: string; input: unknown }
  'agent.completed': { agentId: string; output: unknown; durationMs: number; tokens?: TokenUsage }
  'agent.failed': { agentId: string; error: Error }

  'step.started': { stepId: string; kind: string }
  'step.completed': { stepId: string; output: unknown }
  'step.failed': { stepId: string; error: Error }

  'loop.iteration': { loopId: string; iteration: number }
  'loop.completed': { loopId: string; totalIterations: number; reason: string }

  'state.updated': { path: string; value: unknown }
}

export interface TeamRuntime {
  on<E extends keyof TeamRuntimeEvents>(
    event: E,
    handler: (data: TeamRuntimeEvents[E]) => void
  ): () => void

  emit<E extends keyof TeamRuntimeEvents>(
    event: E,
    data: TeamRuntimeEvents[E]
  ): void
}
```

### 9. Revised Team Definition

Putting it all together:

```typescript
import { z } from 'zod'
import {
  defineTeam,
  defineLLMAgent,
  defineToolAgent,
  seq, loop, branch, step, noop,
  mapInput, state, until
} from 'agent-foundry/team'

// ============================================================================
// Schemas (contracts)
// ============================================================================

const QueryPlanSchema = z.object({
  originalRequest: z.string(),
  searchQueries: z.array(z.string()).min(1),
  searchStrategy: z.object({
    focusAreas: z.array(z.string()),
    suggestedSources: z.array(z.enum(['semantic_scholar', 'arxiv', 'openalex'])),
    timeRange: z.object({ start: z.number(), end: z.number() }).optional()
  }),
  expectedTopics: z.array(z.string())
})

const SearchResultsSchema = z.object({
  papers: z.array(PaperSchema),
  totalFound: z.number(),
  queriesUsed: z.array(z.string())
})

const ReviewResultSchema = z.object({
  approved: z.boolean(),
  relevantPapers: z.array(PaperSchema),
  confidence: z.number(),
  issues: z.array(z.string()),
  additionalQueries: z.array(z.string()).optional()
})

const SummarySchema = z.object({
  title: z.string(),
  overview: z.string(),
  keyFindings: z.array(z.string()),
  researchGaps: z.array(z.string())
})

// ============================================================================
// Agents (single responsibility)
// ============================================================================

const planner = defineLLMAgent({
  id: 'planner',
  inputSchema: z.object({ userRequest: z.string() }),
  outputSchema: QueryPlanSchema,
  system: 'You are a Query Planning Specialist for academic literature research.',
  buildPrompt: ({ userRequest }) =>
    `Analyze this research request and create a search strategy:\n\n"${userRequest}"`
})

const searcher = defineToolAgent({
  id: 'searcher',
  tool: 'literature.search',
  inputSchema: z.object({
    queries: z.array(z.string()),
    sources: z.array(z.string())
  }),
  outputSchema: SearchResultsSchema
})

const reviewer = defineLLMAgent({
  id: 'reviewer',
  inputSchema: SearchResultsSchema,
  outputSchema: ReviewResultSchema,
  system: 'You are a Research Quality Reviewer. Evaluate search results for relevance.',
  buildPrompt: (results) => `Review these ${results.papers.length} papers...`
})

const summarizer = defineLLMAgent({
  id: 'summarizer',
  inputSchema: ReviewResultSchema,
  outputSchema: SummarySchema,
  system: 'You are a Research Synthesizer. Create comprehensive summaries.',
  buildPrompt: (review) => `Synthesize findings from ${review.relevantPapers.length} papers...`
})

// ============================================================================
// Team (orchestration only)
// ============================================================================

export const literatureTeam = defineTeam({
  id: 'literature-research',

  // Typed state schema
  state: state.schema({
    plan: QueryPlanSchema.optional(),
    search: SearchResultsSchema.optional(),
    review: ReviewResultSchema.optional(),
    summary: SummarySchema.optional()
  }),

  // Agents registry (ID inferred from key)
  agents: { planner, searcher, reviewer, summarizer },

  // Flow definition
  flow: seq(
    // Step 1: Plan
    step(planner)
      .in(state.initial<{ userRequest: string }>())
      .out(state.path('plan')),

    // Step 2: Initial search
    step(searcher)
      .in(mapInput(state.path('plan'), plan => ({
        queries: plan.searchQueries,
        sources: plan.searchStrategy.suggestedSources
      })))
      .out(state.path('search')),

    // Step 3: Review loop
    loop(
      seq(
        step(reviewer)
          .in(state.path('search'))
          .out(state.path('review')),

        // Only refine search if not approved
        branch({
          when: (s) => s.review?.approved === false,
          then: step(searcher)
            .in(mapInput(state.path('review'), r => ({
              queries: r.additionalQueries ?? [],
              sources: ['semantic_scholar', 'arxiv', 'openalex']
            })))
            .out(state.path('search')),
          else: noop
        })
      ),
      until.field(state.path<boolean>('review.approved')).eq(true),
      { maxIters: 2 }
    ),

    // Step 4: Summarize
    step(summarizer)
      .in(state.path('review'))
      .out(state.path('summary'))
  )
})

// ============================================================================
// Usage
// ============================================================================

const runtime = createTeamRuntime(literatureTeam, {
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o'
})

// Subscribe to events
runtime.on('agent.started', ({ agentId }) => {
  console.log(`Starting ${agentId}...`)
})

runtime.on('agent.completed', ({ agentId, durationMs, tokens }) => {
  console.log(`${agentId} completed in ${durationMs}ms (${tokens?.totalTokens} tokens)`)
})

// Execute
const result = await runtime.run({ userRequest: 'Find papers on transformer architectures' })

// Type-safe access to final state
console.log(result.state.summary?.title)
console.log(result.state.summary?.keyFindings)
```

## Comparison: Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| **Lines of code** | ~2,160 | ~200 |
| **Serialization ops per agent** | 6+ | 0 (objects flow directly) |
| **JSON extraction logic** | In every LLM agent | Framework handles via `Output.object` |
| **Edge adaptation** | Inside Searcher agent (3 cases) | Explicit `mapInput` + `branch` |
| **State type safety** | None (string paths, `unknown` values) | Full (Zod schemas, typed paths) |
| **Event handling** | Manual `onProgress` callbacks | `runtime.on('agent.started', ...)` |
| **Until conditions** | `noCriticalIssues` (framework concept) | `until.field('review.approved').eq(true)` (business concept) |
| **Agent responsibility** | Parse + adapt + execute + format | Execute only |

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

1. **`src/llm/structured.ts`** - Unified structured LLM client
   - `generateStructured<T>()` function
   - Retry and repair logic
   - Trace integration

2. **`src/agent/define-llm-agent.ts`** - LLM agent factory
   - Schema-based I/O
   - Pre/post processing hooks

3. **`src/agent/define-tool-agent.ts`** - Tool agent factory
   - Tool wrapping with typed I/O

### Phase 2: State & Edges (Week 2-3)

4. **`src/team/state/typed-blackboard.ts`** - Typed state management
   - Schema validation on write
   - Type-safe getters

5. **`src/team/flow/edges.ts`** - Edge combinators
   - `mapInput()`
   - `branch()` / `noop`

6. **`src/team/flow/step.ts`** - Step builder
   - Fluent API: `step(agent).in(...).out(...)`

### Phase 3: Flow & Until (Week 3-4)

7. **`src/team/flow/until.ts`** - Business-semantic conditions
   - `until.field(path).eq(value)`
   - `until.validator(path, schema, check)`

8. **`src/team/flow/executor.ts`** - Updated executor
   - Handle new edge types
   - Schema validation at boundaries

### Phase 4: Runtime & Events (Week 4-5)

9. **`src/team/runtime/events.ts`** - Event system
   - Typed event emitter
   - Standard event taxonomy

10. **`src/team/team-runtime.ts`** - Updated runtime
    - Integrate events
    - Simplified agent resolution (no duck typing)

### Phase 5: Migration & Examples (Week 5-6)

11. **Migrate `literature-agent`** example
12. **Update documentation**
13. **Write migration guide**

## Migration Path

### Non-Breaking Phase

- New APIs are additive
- Existing `defineAgent()`, `agentHandle()`, `invoke()` continue to work
- New `defineLLMAgent()`, `step()`, `mapInput()` available alongside

### Soft Deprecation Phase

- Log warnings for:
  - `Agent.run(string)` - suggest typed agents
  - `input.state('string')` without schema - suggest `state.path()`
  - Duck-typed agents - suggest `kind: 'llm-agent'` marker

### Breaking Changes (v2.0)

- Remove string-based `Agent.run()`
- Require `kind` marker on all agents
- Require state schema for teams

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| AI SDK `Output.object` limitations | Fallback to `generateObject` or manual parsing if needed |
| Schema overhead at runtime | Schemas are compiled once; validation is fast |
| Learning curve for new API | Comprehensive examples and migration guide |
| Breaking existing users | Phased rollout with soft deprecation |

## Success Metrics

1. **Literature agent example reduced to <300 lines**
2. **Zero JSON.parse calls in user agent code**
3. **100% type coverage from input to output**
4. **Event subscription replaces all manual onProgress callbacks**

## References

- [AI SDK Structured Output Documentation](https://sdk.vercel.ai/docs/ai-sdk-core/generating-structured-data)
- [Zod Documentation](https://zod.dev/)
- Current implementation: `src/team/`
- Example with issues: `examples/literature-agent/`
