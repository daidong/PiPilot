# Trace and ledger joins — identifier graph

Status: descriptive. Captures the identifiers actually present in the codebase as of 2026-05-05; flags gaps without changing them.

PiPilot writes telemetry and durable evidence to several stores: OTel
traces (`.research-pilot/traces/`), artifact JSON files
(`.research-pilot/artifacts/`), compaction state, session summaries, and
five JSONL ledgers. They share some identifiers and not others. This
document answers the questions:

> Given a `turnId`, how do I find its trace, its tool calls, the artifacts
> created during it, and the session summary it falls inside?

> Given an artifact, how do I trace back to the user message that caused
> it and the trace that recorded the agent's reasoning?

It does **not** propose new identifiers. It documents what exists and where the missing links require client-side joins.

---

## 1. Identifiers in scope

| Id | Stable across | Minted by | Lifetime |
|---|---|---|---|
| `sessionId` | one project's chat history | `loadOrCreateSessionId` at project open | until `.research-pilot/session.json` is reset |
| `turnId` | one user→assistant turn | IPC `agent:invoke` handler (`app/src/main/ipc.ts:1133`); falls back to a minted token if the renderer envelope omits `clientMessageId` | one turn |
| `clientMessageId` | one renderer-side message | renderer chat-store on submit (`app/src/renderer/stores/chat-store.ts`) | one message |
| `traceId` / `spanId` | one OTel trace / span | OTel SDK | one trace |
| `toolCallId` | one tool invocation | pi-agent-core (`AgentTool.execute(toolCallId, ...)`) | one tool call |
| `artifactId` | one artifact | `createArtifact` in `lib/memory-v2/store.ts` | until artifact is deleted |
| `provenance.messageId` | optional per-artifact pointer | per-create; rarely populated today | with the artifact |
| pi `AgentMessage.id` | one in-process message | pi-agent-core | in-process only — not persisted by us |

Two notes:

- `turnId` defaults to `envelope.clientMessageId` when the renderer
  supplies one, so in normal operation `turnId === clientMessageId`. The
  fallback minting path exists for older renderer builds and CLI/RPC
  callers.
- pi `AgentMessage.id` / `parentId` form the pi-agent-core session tree.
  PiPilot does not use pi's `SessionManager`, so these ids exist only in
  `agent.state.messages` during the lifetime of the coordinator. They
  are **not** queryable across restarts.

---

## 2. Where each store records which ids

| Store | sessionId | turnId | traceId | spanId | toolCallId | artifactId | clientTimestamp |
|---|---|---|---|---|---|---|---|
| Trace JSONL spans (`traces/spans.<date>.jsonl`) | yes (`gen_ai.conversation.id`) | yes (`pipilot.turn.id`) on root + step + tool spans | yes | yes | yes (`gen_ai.tool.call.id`) on `execute_tool` spans | – | – |
| `user-response-signals.jsonl` | – | yes | – | – | – | – | yes (via `messageContentHash` + `gapMsSincePreviousAssistant`) |
| `view-log.jsonl` | yes | optional | – | – | – | – | – |
| `artifact-ledger.jsonl` | – | optional | optional (`trace.getActiveSpan()`) | optional | optional | yes | – |
| `memory-ledger.jsonl` | – | optional | optional | optional | optional | – (memory rows are name-keyed) | – |
| Artifact JSON files (`artifacts/<type>/<id>.json`) | yes (`provenance.sessionId`) | – | – | – | – | yes | – |
| Session summary (`memory-v2/session-summaries/<sessionId>/<ts>.json`) | yes | indirect via `turnRange` | – | – | – | – | – (uses `createdAt`) |
| Compaction state (`memory-v2/compaction-state/<sessionId>.json`) | yes | – (`compactionCount` only) | – | – | – | – | – |

What is NOT recorded anywhere durable:

- The link from an assistant message back to its `traceId`. The agent
  loop emits `pipilot.turn.id` on the root span, and the coordinator
  knows the turnId at chat-time, but the persisted assistant message
  carries no trace pointer. To recover: query trace JSONL for the
  unique `pipilot.turn.id == turnId` root span (one per turn).
- A pi `AgentMessage.id` mapped to the renderer chat-store's UI message
  id. They're independent identifier spaces.
- `compaction` span events stamp `turnIds` as `msg-idx-N` placeholders
  rather than real turnIds — see §4 below.

---

## 3. Join paths

### 3.1 turnId → trace

```
turnId
  → query traces/spans.<date>.jsonl WHERE attributes['pipilot.turn.id'] == turnId
  → exactly one root span (gen_ai.operation.name = 'invoke_agent', no parent)
  → child spans by parentSpanId walk
```

The root span carries `gen_ai.conversation.id` (sessionId), `gen_ai.request.model`, `pipilot.runtime.full_prompt_hash`, and the resumption flags `pipilot.resumption.bootstrap_orphans` / `pipilot.resumption.summary_loaded`.

### 3.2 turnId → tool calls in that turn

```
turnId
  → traces filtered by pipilot.turn.id == turnId
  → spans with gen_ai.operation.name == 'execute_tool'
  → tool name (gen_ai.tool.name) + args event (pipilot.tool.args) + result event (pipilot.tool.result)
```

`toolCallId` (`gen_ai.tool.call.id`) is unique within a trace.

### 3.3 turnId → artifacts created during the turn

```
turnId
  → artifact-ledger rows WHERE turnId == turnId
  → artifactId, op, contentHash, version, traceId/spanId
```

When `artifact-ledger.turnId` is missing (rows produced outside an
active trace context, e.g. `migrate-import-history` backfill), fall back
to:

```
turnId
  → user-response-signals row → clientTimestamp
  → artifact-ledger rows in the same session whose timestamp falls in the
    [clientTimestamp, next turn's clientTimestamp) window
```

This fallback is approximate; rows produced by background tasks (wiki
agent, memory extractor) may share that window.

### 3.4 artifact → originating turn

```
artifactId
  → artifact-ledger rows for this artifactId, ordered by version
  → each row has turnId? + traceId?
  → resolve the create row (op == 'create') to get the originating turnId
```

If `provenance.messageId` is set on the artifact JSON, it points at the
client message id that spawned the artifact — but this field is rarely
populated today. The ledger is the authoritative path.

### 3.5 turnId → session summary covering it

```
turnId
  → user-response-signals row → ordinal position in this session's turn stream
  → session-summary entries WHERE turnRange[0] <= ordinal <= turnRange[1]
```

Session summaries cover turn-ranges by ordinal, not by turnId, so this
requires walking the signals ledger to compute the ordinal for the
target turnId. There is no direct turnId-in-summary link.

### 3.6 turn → compaction events

Compaction is a coordinator-internal event — it does not carry a turnId
and does not appear in user-response-signals. To find compaction events
that occurred "around" a turn:

```
turnId
  → trace JSONL filtered by pipilot.turn.id == turnId
  → child spans with name 'summarize context'
  → span event 'pipilot.compaction.discarded' (turnIds field is msg-idx-N placeholders, not real turnIds)
```

The compaction state file at `memory-v2/compaction-state/<sessionId>.json`
records only `compactionCount` and the running summary string — there
is no per-event audit of which turns were folded in. See `lib/telemetry/PARITY.md#wire-level-capture-coverage` for the wire-capture gap on the underlying `generateSummary` LLM call.

---

## 4. Known gaps

These are documented, not bugs to fix here. Each is acceptable in the
current state because the workaround is a deterministic client-side join.

### 4.1 Compaction `discardedTurnIds` are placeholders

`lib/agents/coordinator.ts:687` attaches the `pipilot.compaction.discarded`
event with `turnIds: messagesToSummarize.map((_, i) => 'msg-idx-' + i)`.
The comment explicitly notes: *"AgentMessage doesn't carry our turnId, so
we attach the indexes; Layer 3 can join by message index → turnId via
the user-response-signals ledger."*

Recovery: walk the signals ledger for this session, take the first N
turnIds prior to the compaction span's start timestamp, where N matches
`pipilot.compaction.discarded_messages`. This is exact when no orphan
recovery has occurred since the prior turn.

### 4.2 Assistant message has no trace pointer

The assistant message stored in `agent.state.messages` carries no
`traceId` field. The link is via the **uniqueness of `turnId` per
session within the trace JSONL**: one and only one root span per turn.

Recovery: filter trace JSONL by `gen_ai.conversation.id == sessionId AND
pipilot.turn.id == turnId`.

### 4.3 `provenance.messageId` is partial

`Artifact.provenance.messageId` is defined in `lib/types.ts:78` but most
artifact-create paths do not populate it. Do not rely on this field as a
join key. Use the artifact-ledger.

### 4.4 Background sub-LLM calls have a separate trace root

`memory/extractor.ts` and `app/src/main/ipc.ts` (wiki-bg) detach into
`ROOT_CONTEXT` — these calls produce root `chat` spans with no
`pipilot.turn.id`. They share `gen_ai.conversation.id` (sessionId) but
not `turnId`. This is intentional per spec §6.5 (background work must
not extend the user-task trace lifetime) and is documented in
`PARITY.md`.

### 4.5 Renderer chat-store ids do not map to pi message ids

The renderer's `chat-store.ts` assigns its own UI message ids for
display state. These are not used in any persistent store other than
the renderer's session JSONL (`sessions/<sessionId>.jsonl`). They share
the timestamp space with `clientTimestamp` and can be joined via that,
but no id-to-id mapping exists.

---

## 5. Recipe: full reconstruction of a single turn

Given `(sessionId, turnId)`:

1. **trace**: open the trace JSONL covering the day, filter by
   `gen_ai.conversation.id == sessionId AND pipilot.turn.id == turnId` —
   gets the root span + all its children (steps, tools, summarize).
2. **user message hash + length + gap**: lookup
   `user-response-signals.jsonl` row with the same turnId.
3. **artifacts**: query `artifact-ledger.jsonl` for rows with this
   turnId. If empty, fall back to the timestamp window from step 2.
4. **memory ops**: query `memory-ledger.jsonl` for rows with this
   turnId.
5. **session position**: count signals rows with `previousTurnId`
   chain back to the session start to derive the turn ordinal; locate
   the session-summary entry whose `turnRange` contains it.
6. **compaction (if any)**: among the trace's `summarize context`
   children, the `pipilot.compaction.discarded_messages` count
   indicates how many prior turns were folded into the running compaction
   summary at this point.

Steps 1–4 are O(1) lookups by indexed fields; step 5 requires walking
the signals ledger; step 6 requires only the trace.
