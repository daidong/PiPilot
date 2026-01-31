# RFC-007: Comprehensive Tracing & Observability

**Status:** Draft
**Author:** Captain + Claude
**Created:** 2026-01-30

## 1. Problem

AgentFoundry has tracing primitives (`TraceCollector`, `EventBus`, `TeamEventEmitter`, `ActivityFormatter`) but they are **disconnected, internal-only, and lack export capabilities**. When debugging a multi-step agent session, developers must:

1. Read raw console logs
2. Manually correlate tool calls to agent steps
3. Guess at timing and token costs
4. Have no way to replay, query, or visualize past runs

### What exists today

| Component | File | What it does | What it lacks |
|-----------|------|-------------|---------------|
| `TraceCollector` | `src/core/trace-collector.ts` | Records events with correlation context (runId, stepId, agentId, sessionId), supports spans | No export, no cost tracking, no tree visualization, no persistence |
| `EventBus` | `src/core/event-bus.ts` | Pub/sub for framework events (file:read, tool:call, policy:deny) | Fire-and-forget, no recording, no replay |
| `TeamEventEmitter` | `src/team/runtime/events.ts` | Typed events for multi-agent flows with spanId/parentSpanId/depth | Separate from TraceCollector, no unified view |
| `ActivityFormatter` | `src/trace/activity-formatter.ts` | Tool call/result -> human-readable labels | UI-only, not queryable |
| `TraceEvent` types | `src/types/trace.ts` | 25+ event types covering agent lifecycle, tools, policies, LLM, errors | Type definitions only, consumed only by TraceCollector |
| Error/Retry system (RFC-005) | `src/core/errors.ts`, `retry.ts`, `feedback.ts` | Error classification, retry budget tracking | Events recorded but not surfaced in any UI or export |

### Concrete debugging pain points

**"Why did the agent call `bash` 7 times?"** — No way to see the full call tree with inputs/outputs. Must grep logs.

**"How much did this session cost?"** — No token or cost tracking at any level. The LLM response includes usage data but it's discarded.

**"The agent got stuck in a loop — what happened?"** — The retry system (RFC-005) records `error.retrying` events but they're only in the in-memory TraceCollector. After the process ends, they're gone.

**"Which tool call took 30 seconds?"** — Spans exist but there's no timeline view or duration query.

**"Compare run A vs run B"** — No run persistence, no diff capability.

### What competing frameworks do

**OpenAI Agents SDK** provides:
- Hierarchical traces with typed spans (agent, generation, function, guardrail, handoff)
- `TraceProvider` → `BatchTraceProcessor` → `BackendSpanExporter` pipeline
- Built-in dashboard visualization
- Sensitive data controls (`trace_include_sensitive_data`)
- `group_id` to link traces across conversations
- Custom spans via `custom_span()` context manager

**W&B Weave** provides:
- `@weave.op()` decorator auto-captures inputs/outputs/duration/exceptions
- Nested traces via call stack tracking
- Auto-patching of LLM libraries (OpenAI, Anthropic)
- Cost calculation from LLM usage
- Feedback/annotation system on calls
- Query API for filtering traces programmatically
- Saved views for common filter patterns
- Thread pool context propagation for parallel execution

**Claude Agent SDK** provides:
- Hooks system (PreToolUse, PostToolUse, SessionStart, SessionEnd) for lifecycle observation
- `parent_tool_use_id` for subagent correlation
- Session resume/fork for execution replay

### Design principles from these systems

1. **Zero-config default**: Tracing should work out of the box with no setup
2. **Hierarchical spans**: All operations nest into a tree (run → step → tool-call → sub-operation)
3. **Pluggable export**: Separate collection from export (processor/exporter pipeline)
4. **Cost awareness**: Token usage and estimated cost tracked per span
5. **Sensitive data control**: Option to redact inputs/outputs
6. **Query and replay**: Traces are persistent and queryable after the fact

---

## 2. Design

### 2.1 Core Model: Trace → Span → Event

```
Trace (one agent.run() or team.run() invocation)
├── Span: agent-loop
│   ├── Span: llm-request (tokens, cost, model)
│   ├── Span: tool-call "read" (input, output, duration)
│   ├── Span: tool-call "bash" (input, output, duration)
│   ├── Span: llm-request
│   └── Span: tool-call "write"
├── Span: agent-loop (step 2)
│   └── ...
└── Event: agent.complete (final result)
```

**Trace**: Top-level container. Has `traceId`, `sessionId`, `groupId`, metadata.
**Span**: Timed operation with parent/child nesting. Has `spanId`, `parentSpanId`, `type`, `input`, `output`, `status`, `startTime`, `endTime`, `attributes`.
**Event**: Point-in-time annotation on a span (errors, state changes, annotations). Lightweight, no duration.

### 2.2 Span Types

| Type | Auto-created by | Key attributes |
|------|----------------|----------------|
| `agent.run` | AgentLoop.run() | prompt, model, result |
| `agent.step` | AgentLoop step iteration | stepNumber |
| `llm.request` | LLM call wrapper | model, promptTokens, completionTokens, cost, finishReason |
| `tool.call` | ToolRegistry.execute() | toolName, input, output, success |
| `policy.evaluate` | PolicyEngine.evaluate() | phase (guard/mutate/observe), policyId, decision |
| `context.fetch` | ContextManager.gather() | sourceId, cacheHit |
| `team.run` | TeamRuntime.run() | teamId, flowType |
| `team.step` | FlowExecutor | stepId, agentId |
| `mcp.call` | MCP client wrapper | serverName, method |
| `error.retry` | RetryBudget | category, attempt, mode |
| `custom` | User code via `tracer.span()` | user-defined |

### 2.3 Architecture: Collect → Process → Export

```
                    ┌─────────────┐
Code instrumentation│   Tracer    │  (singleton per run)
   tracer.span()    │  (collect)  │
   tracer.event()   └──────┬──────┘
                           │ CompletedSpan / Event
                    ┌──────▼──────┐
                    │  Processor  │  (batch, filter, transform)
                    │  Pipeline   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Console  │ │  JSON    │ │ External │
        │ Exporter │ │ Exporter │ │ Exporter │
        └──────────┘ └──────────┘ └──────────┘
         (stderr)     (.traces/)   (OTLP, W&B)
```

### 2.4 API Surface

#### Tracer (replaces TraceCollector)

```typescript
interface Tracer {
  // Start a new trace (top-level run)
  startTrace(options?: TraceOptions): TraceContext

  // Create a span within the current trace
  span<T>(type: SpanType, name: string, fn: (span: ActiveSpan) => T | Promise<T>): T | Promise<T>

  // Record a point-in-time event
  event(type: string, data?: Record<string, unknown>): void

  // Get current active span (for nesting)
  activeSpan(): ActiveSpan | null

  // Configuration
  configure(config: TracerConfig): void
}

interface TraceOptions {
  traceId?: string          // Override auto-generated ID
  sessionId?: string        // Link to session
  groupId?: string          // Link related traces (e.g., same conversation)
  metadata?: Record<string, unknown>
  redactInputs?: boolean    // Strip sensitive data from inputs
  redactOutputs?: boolean   // Strip sensitive data from outputs
}

interface ActiveSpan {
  spanId: string
  traceId: string

  // Set attributes during execution
  setAttribute(key: string, value: SpanAttributeValue): void
  setAttributes(attrs: Record<string, SpanAttributeValue>): void

  // Record token usage (for LLM spans)
  recordUsage(usage: TokenUsage): void

  // Record status
  setStatus(status: 'ok' | 'error', message?: string): void

  // Add event to this span
  event(name: string, data?: Record<string, unknown>): void

  // Create child span
  child<T>(type: SpanType, name: string, fn: (span: ActiveSpan) => T | Promise<T>): T | Promise<T>
}

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens?: number       // Auto-calculated if omitted
  model?: string
  estimatedCostUsd?: number  // Calculated from model pricing table
}
```

#### Span Processor & Exporter

```typescript
interface SpanProcessor {
  onSpanStart(span: ReadableSpan): void
  onSpanEnd(span: ReadableSpan): void
  shutdown(): Promise<void>
}

interface SpanExporter {
  export(spans: ReadableSpan[]): Promise<ExportResult>
  shutdown(): Promise<void>
}

type ExportResult = { code: 'success' } | { code: 'failed'; error: Error }

// Built-in processors
class BatchSpanProcessor implements SpanProcessor {
  constructor(exporter: SpanExporter, options?: {
    maxBatchSize?: number      // Default: 100
    flushIntervalMs?: number   // Default: 5000
  })
}

class SimpleSpanProcessor implements SpanProcessor {
  constructor(exporter: SpanExporter)  // Export immediately on span end
}
```

#### Built-in Exporters

```typescript
// Writes human-readable summary to stderr (default in dev)
class ConsoleExporter implements SpanExporter { }

// Writes JSONL to .research-pilot/traces/ directory (default in all modes)
// One file per trace: trace-<id>.jsonl, one span per line
class JsonFileExporter implements SpanExporter {
  constructor(options?: { dir?: string; maxFileSizeMb?: number })
}

// No-op exporter for unit tests
class NoopExporter implements SpanExporter { }
```

### 2.5 Tracer Configuration

```typescript
interface TracerConfig {
  enabled?: boolean                    // Default: true
  processors?: SpanProcessor[]         // Default: [BatchSpanProcessor(JsonFileExporter)]
  redactByDefault?: boolean            // Default: false
  costTable?: Record<string, ModelCost>  // Custom cost overrides
  maxSpansPerTrace?: number            // Default: 10000 (safety limit)
}

interface ModelCost {
  promptTokenCostPer1k: number
  completionTokenCostPer1k: number
}

// Default cost table ships with common models
const DEFAULT_COST_TABLE: Record<string, ModelCost> = {
  'gpt-5.2': { promptTokenCostPer1k: 0.01, completionTokenCostPer1k: 0.03 },
  'gpt-4o': { promptTokenCostPer1k: 0.005, completionTokenCostPer1k: 0.015 },
  // ... etc
}
```

### 2.6 Auto-Instrumentation Points

These locations are instrumented automatically — no user code changes needed:

| Location | Span type | What's captured |
|----------|-----------|-----------------|
| `AgentLoop.run()` | `agent.run` | prompt, model, final result, total cost |
| `AgentLoop` step iteration | `agent.step` | step number |
| `generateText()` / `streamText()` in llm/ | `llm.request` | model, token usage, finish reason, duration |
| `ToolRegistry.execute()` | `tool.call` | tool name, sanitized input, output, duration |
| `PolicyEngine.evaluate()` | `policy.evaluate` | phase, policy ID, decision (allow/deny/mutate) |
| `ContextManager.gather()` | `context.fetch` | source ID, cache hit, byte size |
| `TeamRuntime.run()` | `team.run` | team ID, flow definition |
| `FlowExecutor` step | `team.step` | step ID, agent ID, input/output |
| `RetryBudget.record()` | Event on parent span | error category, attempt, retry mode |
| MCP client calls | `mcp.call` | server name, method, duration |

### 2.7 Context Propagation

For multi-agent teams with parallel execution, trace context must propagate across:

```typescript
// AsyncLocalStorage-based context propagation (Node.js)
import { AsyncLocalStorage } from 'async_hooks'

const traceContext = new AsyncLocalStorage<TraceContext>()

// When spawning parallel agents:
async function executeParallel(agents: Agent[], inputs: unknown[]) {
  return Promise.all(agents.map((agent, i) =>
    traceContext.run(currentContext.fork(), () => agent.run(inputs[i]))
  ))
}
```

This ensures each parallel branch creates child spans under the correct parent, identical to how Weave's `ThreadPoolExecutor` maintains context.

### 2.8 Cost Tracking

Every `llm.request` span records token usage. Cost rolls up the span tree:

```typescript
// On each LLM response:
span.recordUsage({
  promptTokens: response.usage.prompt_tokens,
  completionTokens: response.usage.completion_tokens,
  model: 'gpt-5.2'
})
// Tracer auto-calculates estimatedCostUsd from cost table

// Trace-level rollup (computed on trace end):
trace.totalCost = sum(allSpans.filter(s => s.type === 'llm.request').map(s => s.usage.estimatedCostUsd))
trace.totalTokens = { prompt: sum(...), completion: sum(...) }
```

### 2.9 Query API (for JSON file exporter)

```typescript
interface TraceQuery {
  // Load a trace from disk
  loadTrace(traceId: string): Promise<Trace | null>

  // List traces with filters
  listTraces(filter?: TraceFilter): Promise<TraceSummary[]>

  // Get spans for a trace
  getSpans(traceId: string, filter?: SpanFilter): Promise<ReadableSpan[]>
}

interface TraceFilter {
  sessionId?: string
  groupId?: string
  after?: Date
  before?: Date
  minCostUsd?: number
  hasError?: boolean
}

interface SpanFilter {
  type?: SpanType
  minDurationMs?: number
  status?: 'ok' | 'error'
  toolName?: string
}
```

### 2.10 Sensitive Data Controls

```typescript
// Global redaction
const tracer = createTracer({ redactByDefault: true })

// Per-span override
tracer.span('tool.call', 'write', (span) => {
  span.setAttribute('redact', false)  // Allow this span's data
  // ...
})

// Custom redactor
const tracer = createTracer({
  redactor: (key: string, value: unknown) => {
    if (key === 'apiKey' || key === 'password') return '[REDACTED]'
    return value
  }
})
```

---

## 3. Integration with Existing Systems

### 3.1 Replacing TraceCollector

The new `Tracer` subsumes `TraceCollector`. Migration is mechanical:

```typescript
// Before (TraceCollector)
trace.record({ type: 'tool.call', data: { tool: name, args } })
const spanId = trace.startSpan('tool.call', { tool: name })
// ... execute ...
trace.endSpan(spanId, { result })

// After (Tracer)
await tracer.span('tool.call', name, async (span) => {
  span.setAttributes({ tool: name, args })
  const result = await execute()
  span.setAttributes({ result })
  return result
})
```

The function-scoped span API eliminates the manual `startSpan`/`endSpan` pattern and guarantees spans are always closed (even on exceptions).

### 3.2 Unifying EventBus and TeamEventEmitter

Both systems continue to exist for their pub/sub role (UI updates, reactive behavior). But observability data flows through the Tracer instead:

- `EventBus` framework events (`tool:call`, `tool:complete`) become side-effects of Tracer spans, not the source of truth
- `TeamEventEmitter` events (`agent.started`, `step.completed`) are emitted by the Tracer's auto-instrumentation of FlowExecutor

### 3.3 ActivityFormatter

Unchanged. It continues to convert tool call/result data into human-readable labels for UI. It reads from the same tool definitions. The Tracer records the raw data; the formatter presents it.

### 3.4 Error/Retry System (RFC-005)

Error events (`error.classified`, `error.retrying`, `error.recovered`, `error.exhausted`) become events on the parent span instead of standalone TraceCollector records:

```typescript
// In retry loop:
parentSpan.event('error.retrying', {
  category: agentError.category,
  attempt: n,
  mode: strategy.mode
})
```

This preserves full context — you can see which span's execution triggered the retry.

---

## 4. File Structure

```
src/trace/
├── tracer.ts              # Tracer class (singleton, context propagation)
├── span.ts                # ActiveSpan, ReadableSpan, CompletedSpan
├── trace-context.ts       # AsyncLocalStorage-based context propagation
├── cost.ts                # Cost table + calculation
├── redact.ts              # Sensitive data redaction
├── processors/
│   ├── batch.ts           # BatchSpanProcessor
│   └── simple.ts          # SimpleSpanProcessor (immediate export)
├── exporters/
│   ├── console.ts         # Human-readable stderr output
│   ├── json-file.ts       # JSONL file export to .traces/
│   └── noop.ts             # NoopExporter for testing
├── query.ts               # TraceQuery for reading persisted traces
├── activity-formatter.ts  # (existing, unchanged)
└── index.ts               # Public exports
```

---

## 5. Implementation Phases

### Phase 1: Core Tracer + JSON Export
- `Tracer`, `ActiveSpan`, `ReadableSpan` classes
- `AsyncLocalStorage` context propagation
- `JsonFileExporter` writing JSONL to `.research-pilot/traces/`
- `ConsoleExporter` for dev mode
- Auto-instrument: `AgentLoop.run()`, `AgentLoop` steps, tool calls

### Phase 2: LLM + Cost Tracking
- Auto-instrument `generateText()`/`streamText()` calls
- `TokenUsage` recording on `llm.request` spans
- Cost table with common models
- Trace-level cost rollup

### Phase 3: Full Auto-Instrumentation
- Policy engine spans
- Context manager spans
- MCP call spans
- Team runtime spans (replace TeamEventEmitter observability role)
- Error/retry events on spans

### Phase 4: Query + Visualization
- `TraceQuery` API for reading `.research-pilot/traces/` JSONL files
- CLI command: `npx agent-foundry trace list`, `npx agent-foundry trace show <id>`

### Phase 5: Advanced Features
- Sensitive data redaction
- Custom span support for user code
- Trace comparison (diff two runs)
- Feedback/annotation system on spans

---

## 6. Example Usage

### Default (zero-config)

```typescript
// Just works — all spans auto-recorded to .traces/
const agent = createAgent({ apiKey, projectPath })
const result = await agent.run('Summarize the paper')
// .research-pilot/traces/trace-<id>.jsonl now contains the full span tree
```

### Custom configuration

```typescript
import { createAgent, ConsoleExporter, SimpleSpanProcessor } from 'agent-foundry'

const agent = createAgent({
  apiKey,
  projectPath,
  trace: {
    // Use SimpleSpanProcessor for immediate console output during development
    processors: [
      new SimpleSpanProcessor(new ConsoleExporter())
    ]
  }
})
```

### Manual spans in user code

```typescript
import { tracer } from 'agent-foundry'

async function myPipeline(input: string) {
  return tracer.span('custom', 'my-pipeline', async (span) => {
    span.setAttribute('inputLength', input.length)

    const cleaned = await tracer.span('custom', 'preprocess', async () => {
      return cleanInput(input)
    })

    const result = await agent.run(cleaned)
    span.setAttribute('outputLength', result.length)
    return result
  })
}
```

### Querying past traces

```typescript
import { createTraceQuery } from 'agent-foundry'

const query = createTraceQuery({ dir: '.research-pilot/traces' })

// Find expensive runs
const expensive = await query.listTraces({ minCostUsd: 0.50 })

// Get all tool calls in a specific trace
const tools = await query.getSpans(traceId, { type: 'tool.call' })
for (const span of tools) {
  console.log(`${span.name}: ${span.durationMs}ms`)
}
```

---

## 7. Migration Path

| Current | New | Breaking? |
|---------|-----|-----------|
| `TraceCollector` | `Tracer` | No — TraceCollector deprecated, Tracer is new API |
| `trace.record()` | `tracer.event()` | No — old API continues to work during deprecation period |
| `trace.startSpan()`/`endSpan()` | `tracer.span(fn)` | No — old API still works |
| `EventBus` | Unchanged (pub/sub role preserved) | No |
| `TeamEventEmitter` | Unchanged (pub/sub role preserved) | No |
| Agent callbacks (`onToolCall`, `onToolResult`) | Still work, also captured by Tracer | No |

No breaking changes. The Tracer is additive. Old APIs are deprecated but functional.

---

## 8. Non-Goals

- **Real-time streaming UI dashboard** — Out of scope for framework. Apps can build this from the exporter pipeline (the research-pilot desktop already does via `onToolCall`/`onToolResult` callbacks).
- **Distributed tracing across network boundaries** — AgentFoundry runs in a single process (or spawns child processes). An OTLP exporter adapter can be added later if needed.
- **OpenTelemetry compatibility** — We use our own lean span format. A thin export adapter can be added later without changing core types.
- **Log aggregation** — Tracing is for structured spans, not general-purpose logging. `console.log` remains for unstructured debug output.
- **Automatic PII detection** — The redaction system requires explicit configuration. Automatic PII detection is an ML problem outside our scope.

---

## 9. Decisions (Resolved)

1. **JSONL format** — One span per line, one file per trace (`trace-<id>.jsonl`). Simpler to append, stream-parse, and `grep`. Each line is a self-contained JSON object.

2. **No OpenTelemetry alignment** — We use our own lean span shape. No need for OTel's verbose resource/scope/attribute model. If OTLP export is needed later, a thin adapter can translate on export. This keeps our core types simple and framework-specific.

3. **Traces live inside `.research-pilot/traces/`** — Co-located with other project state. Cleaned up when the project directory is removed. Not cluttering the project root. Path constant added to `PATHS.traces`.

4. **Singleton Tracer** — One global `Tracer` instance accessed via `import { tracer } from 'agent-foundry'`. Uses `AsyncLocalStorage` for context propagation so nesting works automatically. For testing, `tracer.configure()` can swap processors/exporters, and a `NoopTracer` is available for unit tests.
