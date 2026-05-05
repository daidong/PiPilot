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
