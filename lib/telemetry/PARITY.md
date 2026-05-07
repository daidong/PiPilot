# RealtimeBuffer ↔ trace-store parity (P2.5)

The renderer currently has two recovery paths for in-flight state:

| Path | Lives in | Recovers | Drives |
|---|---|---|---|
| `RealtimeBuffer` (legacy) | `app/src/main/realtime-buffer.ts` | `agent:get-realtime-snapshot` IPC | activity-store, tool-events-store, progress-store, tool-progress-store |
| `trace-store` (new, P2) | `app/src/renderer/stores/trace-store.ts` | `trace:live` channel + `trace:snapshot(traceId)` IPC | future: replaces activity-store |

The two are **kept side-by-side in P2**. The cutover (deleting RealtimeBuffer)
is deferred until P3+ once we have a two-week diff against real usage.

## What each path captures

**RealtimeBuffer (broader, ephemeral):**

- streaming text deltas (`streamingText`)
- progress / todo items (`upsertProgressItem`)
- per-tool-call status (`pushToolEvent`)
- per-tool progress updates (`pushToolProgress`)
- ad-hoc activity events (`pushActivity` — system messages, etc.)

It is reset on `project:close`, has no on-disk durability, and only survives
for the lifetime of the Electron main process.

**trace-store (narrow, durable):**

- ended OTel spans only (`onEnd` in `LiveSpanProcessor`)
- attributes drawn from a fixed allowlist (see `live-processor.ts:LIVE_ATTR_KEYS`)
- span events (compaction discards, skill loads, etc.)

The data lives forever in `traces/spans.{date}.jsonl`; `trace-store` is a
bounded in-memory cache (50 traces FIFO) of *recently seen or hydrated* trace
ids. Cold-start mid-trace = `hydrate(traceId)` reads from disk.

## Equivalence claim

For each event RealtimeBuffer surfaces, here is the corresponding trace span:

| Buffer event | Trace span | Notes |
|---|---|---|
| `tool-call` activity | `execute_tool {name}` span (open) | Buffer fires on `beforeToolCall`; span starts in the same hook |
| `tool-result` activity | `execute_tool {name}` span (close) | Buffer fires on `afterToolCall`; span ends in the same hook |
| LLM streaming chunk | `chat {model}` span | Buffer accumulates text deltas; span sees only start/end |
| `usage` event | Attributes on `chat` span | Buffer forwards to renderer; span carries `gen_ai.usage.*` |
| Skill loaded | `pipilot.skill.load` event on step span | Both fire in the same `load_skill` afterToolCall path |
| `progress` / todo updates | **NOT in trace** | Layer-3 / UI concern; would be a `pipilot.progress.*` extension if we ever wanted them traced |

**Streaming chunks** are the only Buffer-only surface that matters for live UI.
The trace path will not match per-chunk fidelity; this is intentional (per-chunk
spans would be wasteful). The streaming path stays on Buffer until we add a
distinct `pipilot.stream.*` event channel — out of scope for P2.

## Gate criterion (from spec §11 P2)

> "A renderer remount during an active trace produces an identical view via
> either path."

Identical here means **same set of tool calls, same model, same status**, with
the trace-store path additionally carrying token usage. Streaming partial text
is allowed to diverge (Buffer has it; trace doesn't until per-chunk events
land).

This is verified manually for now: open a project, send a chat that uses tools,
trigger a renderer reload mid-task, and confirm both stores show the same
in-flight tool calls.

## When to retire RealtimeBuffer

Two preconditions:

1. trace-store has been in production for >= 2 weeks with telemetry on by default.
2. A `pipilot.stream.*` event surface exists for live streaming text (or we
   accept that mid-stream remount loses the in-progress text — which is what
   most browsers do anyway).

Until both are met, RealtimeBuffer stays. Removing it earlier risks regressing
the live-UX feel for a research-grade tool where users frequently reload.

---

# Wire-level capture coverage

`tracedCompleteSimple` (`lib/telemetry/llm-trace.ts`) attaches OTel `chat`
spans plus full request/response wire capture (via pi-ai's `onPayload` /
`onResponse` hooks) to every LLM call that goes through it. Coverage is
exhaustive **except** for the gap below.

## Covered (wire-level)

- Main agent loop — `Agent.prompt` triggers pi's per-step provider call. The
  `onPayload` / `onResponse` hooks set on the `Agent` constructor
  (`lib/agents/coordinator.ts:599 / :614`) feed the active `invoke_agent step`
  span.
- Six explicit sub-LLM call sites, all routed through `tracedCompleteSimple`:
  - `coordinator.ts:178` intent router
  - `coordinator.ts:472` `callLlm` (research-tool sub-call)
  - `coordinator.ts:507` `callLlmVision` (image sub-call)
  - `coordinator.ts:960` session-summary generator
  - `lib/memory/extractor.ts:168` background memory extractor
  - `app/src/main/ipc.ts:1008` wiki background `callLlm`

## Known gap — accepted as span-only

**`generateSummary()` during context compaction.**
`coordinator.ts:711` calls pi-coding-agent's `generateSummary(...)`, which
internally calls `pi-ai.completeSimple()` directly. That bypasses
`tracedCompleteSimple`, so the compaction summarizer LLM call is **not**
captured at the wire level.

What we do have:

- A `summarize context` span opened around the call
  (`coordinator.ts:693 / :722`)
- Span attributes: `gen_ai.operation.name = "pipilot.summarize"`,
  `pipilot.compaction.discarded_messages`, `pipilot.compaction.kept_tokens`
- A `pipilot.compaction.discarded` event with the discarded message indices

What we do **not** have on this path:

- `gen_ai.input.messages` / `gen_ai.system_instructions` events
- `pipilot.chat.request_payload` event (post-`convertMessages` wire body)
- `gen_ai.usage.*` attributes (input/output/cache tokens)
- `http.response.status_code` and rate-limit headers
- `gen_ai.response.finish_reasons`

### Why we accept this

- pi does not expose hooks on its internal summarizer call. Closing the gap
  requires either (a) waiting for pi to surface a hook, or (b) localizing
  the summarizer (re-implementing pi's compaction prompt and update-summary
  semantics here), which forfeits the upgrade path on `pi-coding-agent`.
- Compaction events are rare (only when context exceeds threshold), bounded
  by the `summarize context` span timing, and outcome-visible via the
  resulting `compaction summary` injected into the next turn.

### When to revisit

- pi-coding-agent grows hooks on `generateSummary` → switch to wired
  variant, no further work needed
- Compaction-related token cost becomes a meaningful slice of project spend
  (track via aggregated `summarize context` span counts) → consider
  localizing the summarizer
- Audit / compliance requires wire-level capture of every token billed →
  forces the localize path regardless of cost

Keep this section updated when adding new sub-LLM call sites: every new
site must either go through `tracedCompleteSimple` or be listed here as
an accepted gap with rationale.
