# RFC-007: Practical Tracing Export (MVP)

**Status:** Draft (Rescoped)
**Author:** Captain + Claude
**Created:** 2026-01-30
**Updated:** 2026-02-05

## 1. Problem

AgentFoundry already emits a rich set of trace events (`TraceCollector`, `TraceEvent`), but the data is **ephemeral** and **not exported**. Developers currently must:

- Read raw console logs
- Manually correlate tool calls, steps, and LLM responses
- Lose trace data after the process ends
- Have no run summary (cost, tokens, duration) persisted

The goal is to make tracing **useful and durable** without introducing a full-blown observability pipeline.

---

## 2. Scope (MVP)

**This RFC is intentionally smaller than the previous draft.**

### In scope

- Keep `TraceCollector` as the primary API.
- Add **JSONL export** (one file per run).
- Add **run summary** export (tokens, cost, duration, success).
- Add **minimal span-style timing** for:
  - `agent.run`
  - `llm.request`
  - `tool.call` (already spans in `ToolRegistry`)

### Out of scope (for now)

- Span processors / exporters pipeline
- AsyncLocalStorage context propagation
- Query API / CLI
- Cost table duplication (reuse `TokenTracker` usage data)
- OpenTelemetry compatibility
- Full UI tracing dashboard

---

## 3. Proposed Design (TraceCollector v2)

### 3.1 Trace Export

`TraceCollector` gains export configuration and a `flush()` method. When enabled, it writes:

- `trace-<runId>.jsonl` — one event per line
- `trace-<runId>.summary.json` — run-level summary

**Default behavior:**

- Export enabled by default in `createAgent()` with output dir:
  `./.agentfoundry/traces/`
- Export can be disabled or redirected by config.

### 3.2 Minimal Run Summary

The summary file includes:

```json
{
  "runId": "...",
  "sessionId": "...",
  "agentId": "...",
  "startedAt": "2026-02-05T01:23:45.000Z",
  "durationMs": 12345,
  "success": true,
  "error": null,
  "steps": 4,
  "totalEvents": 128,
  "byType": { "tool.call": 22, "llm.request": 4 },
  "usage": {
    "tokens": { ... },
    "cost": { ... },
    "callCount": 4,
    "cacheHitRate": 0.65,
    "durationMs": 12000
  }
}
```

### 3.3 Minimal Span Timing

We avoid introducing a new Tracer API. Instead:

- `TraceCollector.startSpan()` / `endSpan()` are used to time:
  - `agent.run`
  - `llm.request`
  - `tool.call` (already in `ToolRegistry`)

This gives duration for the most important units without re-architecting the system.

---

## 4. Configuration

### TraceCollectorConfig (new fields)

```typescript
interface TraceCollectorConfig {
  sessionId: string
  runId?: string
  agentId?: string
  export?: {
    enabled?: boolean
    dir?: string
    writeJsonl?: boolean
    writeSummary?: boolean
  }
}
```

### AgentConfig (new optional trace section)

```typescript
interface AgentConfig {
  trace?: {
    export?: {
      enabled?: boolean
      dir?: string
      writeJsonl?: boolean
      writeSummary?: boolean
    }
  }
}
```

---

## 5. Implementation Plan (MVP)

### Phase 1 (this RFC)

- Add export support to `TraceCollector`
- Add run summary (from `TokenTracker`)
- Add `trace.startRun()` / `trace.flush()` lifecycle
- Instrument `agent.run` + `llm.request` spans

### Phase 2 (future RFC)

- Optional pipeline processors / external exporters
- Async context propagation
- Query API / CLI

---

## 6. Migration / Compatibility

- No breaking API changes.
- Existing `trace.record()` calls still work.
- Export is additive; can be disabled with config.

---

## 7. Why This Is Enough Now

This MVP solves the real pain points (persistence, run summaries, timing for LLM/tool calls) without introducing a large tracing subsystem. We can grow into a full Tracer pipeline later if/when the framework justifies it.
