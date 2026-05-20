# Context Compaction — implementation reference

How Research Copilot prevents the agent's conversation from overflowing the
underlying LLM's context window. This is a code-level walkthrough of the
mechanism, not a user guide. Audience: contributors who need to debug,
extend, or rebuild the compaction path.

## The problem

Every LLM has a fixed context window (Opus 4.7: 200K tokens, Sonnet 4.6:
1M, GPT-5: 256K, etc.). A long chat — many turns, tool calls, file reads,
long script outputs — accumulates messages on `agent.state.messages` and
eventually each provider request would exceed that ceiling.

Without compaction, the request would fail and the session would be
unusable. With compaction, older messages are summarized into a single
synthetic message and dropped, keeping the recent suffix intact so the
agent maintains continuity for the user's current task.

## Three layers, working together

| Layer | When it fires | What it does | Lossy? |
|---|---|---|---|
| **transformContext** (per-step) | Before every LLM call within a chat | Summarizes the oldest messages, keeps a recent-token window | Yes (LLM-generated summary) |
| **CompactionState persistence** | After each successful compaction | Writes the running summary to disk so the next compaction extends rather than regenerates | Lossless storage of a lossy artifact |
| **Session bootstrap** (per-restart) | First `chat()` after coordinator construction | Replays orphan user/assistant messages (post-last-SessionSummary) into the new agent's context | **Lossless** — verbatim replay |

The first does live compaction; the second amortizes the LLM cost across
restarts; the third recovers in-flight turns that a previous process
didn't get to summarize.

## Layer 1 — `transformContext` hook

Wired into the pi-mono `Agent` at construction time
(`lib/agents/coordinator.ts:736`). pi-mono invokes it before every step's
provider request with the current `messages: AgentMessage[]`. The hook
either returns `messages` unchanged or returns a shorter array with the
oldest turns replaced by one summary message.

### Token estimation

We don't tokenize precisely (would need the provider's exact tokenizer);
we approximate with **4 chars ≈ 1 token** (`estimateCharsAsTokens`,
`coordinator.ts:92`). Two components add up:

- **Message tokens** — `estimateCompactionMessageTokens`
  (`coordinator.ts:118`) — walks each message's content blocks. For
  assistant messages on reasoning models, this **also counts thinking
  signatures, tool-call signatures, and text signatures** — the provider
  resends those over the wire, so omitting them in our estimate would
  cause us to underestimate and overflow.
- **Fixed overhead** — `estimateFixedRequestTokens` (`coordinator.ts:96`)
  — system prompt + the JSON-serialized tools array. Both ride along on
  every step's request, so they count against the budget every step,
  not just once.

Total = message tokens + fixed overhead. Compared against
`piModel.contextWindow` minus a reserve (see settings below).

### Compaction settings

`createCompactionSettings(model, thinkingLevel)` (`coordinator.ts:145`)
derives the budget knobs from the model type:

| Setting | Reasoning model (thinking=on) | Non-reasoning |
|---|---|---|
| `reserveTokens` | max(default, **48,000**) | DEFAULT_COMPACTION_SETTINGS.reserveTokens |
| `keepRecentTokens` | **20,000** | **30,000** |

Why reasoning models reserve more: thinking tokens are sent over the
wire and cost real budget. The reserve is a guardrail — when total
tokens cross `contextWindow - reserveTokens`, compaction fires, leaving
headroom for the upcoming response (and its thinking budget).

Reasoning models keep *fewer* recent tokens because each kept assistant
message also drags its thinking signature along; non-reasoning keep
more because their messages are cheaper per char.

### Cut-point algorithm

```
walk messages back-to-front, accumulating tokens
when accumulated > keepRecentTokens:
  cutIndex = current position
break
```

The result: `messages.slice(0, cutIndex)` gets summarized,
`messages.slice(cutIndex)` is kept verbatim.

**`normalizeCompactionCutIndex` (`coordinator.ts:234`)** — the
tool-call/tool-result invariant. If the cut lands on a `toolResult`
message, we back up so the cut sits *before* the assistant
toolCall that produced it. A toolResult orphaned from its toolCall
breaks the conversation protocol (every toolResult must have a
matching toolCall in the same context). Splitting in the middle of a
batch of toolResults is also rejected by the loop.

Edge cases:
- `cutIndex <= 1` → too little to summarize; return unchanged.
- `cutIndex >= messages.length` → cap at length-1 so we always keep at
  least the latest user message.
- LLM call fails → catch, return original `messages`. Compaction must
  never break the agent path.

### Summary generation

`generateSummary` (imported from pi-coding-agent) is called with:

- `messagesToSummarize` (the dropped prefix)
- `piModel` (the same model the agent is using)
- `settings.reserveTokens` (so the summary itself can't exceed it)
- `currentKey` (the API key, freshly resolved)
- `signal` (so a stop() during compaction abandons cleanly)
- `compactionSummary` — **the previous summary**, when this isn't the
  first compaction in the session

That last argument is what makes compaction *iterative*. The first
compaction summarizes raw turns; the second extends the first summary
with newly-dropped turns; the Nth extension doesn't have to re-read all
N×(window-worth) of original messages. Cost scales with newly-discarded
content, not total session history.

### Injection

The summary lands as a single synthetic **user** message at index 0:

```
[Previous conversation summary]

{summary text}

---

The conversation continues below.
```

Why a user message: assistant messages must respect tool-call/result
pairing (no orphan tool calls), but a user role doesn't. Putting it at
index 0 also matches the natural reading order — "here's what happened
before, then we continue".

The hook mutates `messages` in place (`messages.splice(0, ..., ...)`)
*and* returns the new array. The in-place mutation is needed so later
tool steps within the same `agent.invoke()` call see the compacted
context — without it, the next step would resend the entire
pre-compaction transcript.

## Layer 2 — `CompactionState` persistence

A successful compaction writes a JSON file to
`.research-pilot/memory-v2/compaction-state/<sessionId>.json`:

```json
{
  "schemaVersion": 1,
  "sessionId": "session-abc",
  "summary": "...",
  "compactionCount": 3,
  "updatedAt": "2026-05-19T10:23:11.123Z"
}
```

Read on coordinator construction (`coordinator.ts:696`), passed to
`generateSummary` as the `previousSummary` argument on subsequent
compactions. **Survives process restart.**

Without this, every restart of a long-lived session would force
re-summarizing from raw turns at the next compaction event. Persistence
turns "compaction is expensive once per session restart" into "compaction
is expensive once per compaction event, ever".

Schema-versioned (`COMPACTION_STATE_SCHEMA_VERSION = 1`). Mismatched
versions are treated as "no prior state" — the next compaction starts
fresh. Corrupt JSON, missing fields, or malformed data are also treated
as no state — `readCompactionState` never throws, never blocks startup.

Boundary trade-off (documented inline at `store.ts:618`): when the
session bootstrap (Layer 3) replays orphans whose content overlaps with
what the persisted summary already covers, the LLM extending the summary
is *expected* to dedupe but may include minor overlap. The alternative —
dropping the persisted summary on bootstrap — costs full
re-summarization every restart, which defeats the persistence. We accept
the small overlap risk.

## Layer 3 — Session bootstrap (orphan replay)

`createSessionBootstrap` (`lib/agents/session-bootstrap.ts:42`). Runs
**once** per coordinator lifetime, on the first `chat()` call.

The idea: a previous process can crash, be killed, or be exited cleanly
mid-turn. Those most-recent user/assistant messages exist in
`<workspace>/.research-pilot/sessions/<sessionId>.jsonl` but were never
folded into a `SessionSummary`. They're *orphans* — visible to the user
in the UI scroll history but invisible to the new agent.

`readOrphanMessages(projectPath, sessionId, cutoffMs)` returns all
messages with `timestamp > cutoffMs`, where the cutoff is the latest
SessionSummary's `createdAt` (or 0 if no summary exists). These are
injected into the new agent as a "Recent Conversation" block (built by
`buildRecentConversationContext`).

**This is lossless** — no LLM compression. The replayed turns are
verbatim. The agent resumes with the *exact* context the user sees,
just in a single context block rather than turn-by-turn messages.

After the first call, `consume()` returns empty regardless of input —
subsequent chats rely on `agent.state.messages` accumulating normally.

## Data layout on disk

```
<workspace>/.research-pilot/
├── sessions/
│   └── <sessionId>.jsonl              ← raw turn log (append-only)
└── memory-v2/
    ├── session-summaries/
    │   └── <sessionId>/<n>.json       ← coarser-grain SessionSummary
    │                                    (turn ranges; topic / open
    │                                    questions; written by separate
    │                                    end-of-task path)
    ├── compaction-state/
    │   └── <sessionId>.json           ← Layer 2 — running summary
    └── ledger.jsonl                   ← artifact ledger (unrelated)
```

The `sessions/` JSONL is the ground truth — anything in `memory-v2/` is
a derived index. Deleting `memory-v2/` is recoverable; deleting
`sessions/` loses turns permanently.

## Telemetry

Every compaction opens a `summarize context` span
(`coordinator.ts:792`) with attributes:

- `gen_ai.operation.name = 'pipilot.summarize'`
- `pipilot.compaction.discarded_messages` — how many got dropped
- `pipilot.compaction.kept_tokens` — recent-window token count
- `pipilot.compaction.fixed_overhead_tokens` — system+tools cost

Events:

- `pipilot.compaction.discarded` — message indexes (joinable via the
  user-response-signals ledger to user-visible turn IDs, per
  telemetry-trace.md §6.8)
- `pipilot.compaction.summary_text` — the redacted summary body (up to
  4 KB, blob-stored if longer; §6.9 extension so summary provenance is
  self-contained without grovelling the next turn's request payload)

This is what makes compactions reviewable post-hoc — open the trace,
see what context the agent dropped on which turn and what it kept.

## Failure modes

| Failure | Behavior |
|---|---|
| `generateSummary` throws | Catch, log (when `debug`), return original messages. Agent path unaffected; next step retries with full context. |
| API key resolution throws | Same as above. |
| Disk write of CompactionState throws | Best-effort; swallowed. Next compaction will re-summarize from current state (a one-shot cost, not a recurring one). |
| `signal` aborted mid-summary | `generateSummary` throws AbortError; same catch path. |
| Corrupt CompactionState on read | `readCompactionState` returns `null`; next compaction starts fresh. Never throws. |
| `messages.length <= 1` after cut normalization | Return original — too little to summarize. |

The invariant: **compaction failures must never break the agent.** The
agent path stays on the original message list; the worst case is a
provider request hitting the context-window ceiling and erroring. That's
worse than a successful compaction but better than the whole session
becoming unusable due to a transient summarizer failure.

## Constants quick-reference

Defined at the top of `lib/agents/coordinator.ts`:

```ts
const REASONING_COMPACTION_RESERVE_TOKENS = 48_000
const REASONING_KEEP_RECENT_TOKENS        = 20_000
const NON_REASONING_KEEP_RECENT_TOKENS    = 30_000
```

`DEFAULT_COMPACTION_SETTINGS` is imported from
`@mariozechner/pi-coding-agent`. To tune: prefer overriding in
`createCompactionSettings` rather than editing pi-mono's defaults.

## Files touched

- `lib/agents/coordinator.ts:60-156, 690-881` — main implementation
- `lib/agents/session-bootstrap.ts` — Layer 3
- `lib/memory-v2/store.ts:594-700` — `SessionSummary` + `CompactionState`
  read/write
- `lib/memory-v2/__tests__/compaction-state.test.ts` — schema-version
  guard tests
- Tests in `lib/agents/__tests__/` — cut-point normalization, integration

## Adjacent docs

- `docs/spec/telemetry-trace.md` §6.2, §6.8, §6.9 — compaction-related
  telemetry semantics
- `lib/docs/rfc/` — there is no compaction RFC; the design grew
  organically alongside pi-mono's `transformContext` hook
