# Pi-Mono Inspired Improvements

> Based on architectural comparison with [pi-mono](https://github.com/badlogic/pi-mono).
> See full analysis in conversation history.

## Status

| # | Improvement | Priority | Status |
|---|---|---|---|
| 1 | LLM-driven context compaction | High | ✅ Done |
| 2 | Parallel tool execution | High | ✅ Done |
| 3 | Typed agent hooks (`AgentHooks`) | High | ✅ Done |
| 4 | Operations interface DI per tool | Medium | ✅ Done |
| 5 | Tool result content/details separation | Medium | ✅ Done |
| 6 | No-throw contract on critical paths | Medium | ✅ Done |
| 7 | Steering/follow-up message queues | Medium | ✅ Done |
| 8 | Tree-structured session branching | Low | Backlog |
| 9 | Extension hot-reload | Low | Backlog |
| 10 | More providers + compat flags | Low | ✅ Done |
| 11 | Markdown-file skill support + install | Low | ✅ Done |
| 12 | Streaming-first event architecture | High | ✅ Done |

### Gap Analysis Batch 2

| GAP | Improvement | Priority | Status |
|---|---|---|---|
| GAP-16 | Edit tool fuzzy matching (BOM/CRLF/Unicode) | High | ✅ Done |
| GAP-3 | Iterative compaction summary (UPDATE prompt) | High | ✅ Done |
| GAP-11 | Skill pointer mode + `skill.load` context source | High | ✅ Done |
| GAP-9 | `transformContext` hook per LLM call | High | ✅ Done |
| GAP-5 | Dynamic API key callback | Medium | Backlog |
| GAP-2 | Per-call temperature/topP override | Medium | Backlog |
| GAP-1 | `stopSequences` per-call | Medium | Backlog |
| GAP-7 | Tool parameter `$defs`/`$ref` support | Medium | Backlog |
| GAP-12 | Tool retry signal from execute() | Medium | ✅ Done |
| GAP-14 | Structured output / JSON mode | Medium | Backlog |
| GAP-4 | Output token budget enforcement | Medium | Backlog |
| GAP-6 | Token pre-estimation before LLM call | Medium | ✅ Done |
| GAP-10 | Message pinning (never compacted) | Medium | ✅ Done |
| GAP-17 | Per-tool timeout in definition | Low | ✅ Done |
| GAP-18 | AbortSignal propagation to tools | Medium | ✅ Done |
| GAP-8 | `onCompaction` lifecycle hook | Low | Backlog |
| GAP-13 | `onRateLimitRetry` hook | Low | Backlog |
| GAP-15 | Conversation export/import | Low | Backlog |
| GAP-19 | Provider retry config | Low | Backlog |

---

## Implemented

### 1. LLM-driven Context Compaction

**Problem:** `CompactionEngineV2` used heuristic summarization — slicing the first 120 chars of each turn. This loses most semantic content, making long-conversation compaction nearly useless.

**Solution:** Added optional `summarizeFn` injection to `CompactionEngineV2`. When provided, compaction calls the LLM to generate a structured semantic summary covering goals, progress, decisions, file changes, and remaining work. Falls back to heuristic if the LLM call fails.

**Now default ON.** The summarizeFn is created automatically in `createAgent`. To opt out:

```yaml
# agent.yaml — disable LLM compaction and use fast heuristic instead
compaction:
  llmSummarization: false
```

```typescript
// Or via code
const agent = createAgent({
  kernelV2: { compaction: { llmSummarization: false } }
})
```

**Files changed:**
- `src/kernel-v2/compaction-engine-v2.ts` — accept `summarizeFn`, call it if available
- `src/kernel-v2/types.ts` — add `compaction.llmSummarization?: boolean` to config
- `src/kernel-v2/defaults.ts` — changed default to `true`
- `src/kernel-v2/kernel.ts` — accept and wire `summarizeFn` through to engine
- `src/agent/create-agent.ts` — opt-out logic; YAML merge; summarizeFn always created unless disabled
- `src/config/loader.ts` — added `compaction.llmSummarization` to `AgentYAMLConfig`
- `tests/kernel-v2/compaction-llm-summarization.test.ts` — 6 E2E tests

---

### 2. Parallel Tool Execution

**Problem:** All tool calls within a single LLM response were executed sequentially. If the agent asks to read 5 files simultaneously, they execute one-by-one.

**Solution:** Added `parallelToolExecution` option to `AgentLoopConfig`. When enabled, the pre-validation phase (3-strike check, subset check) runs sequentially, then all valid tool calls execute in parallel via `Promise.allSettled`. Results are collected in source order.

**Now default ON.** To opt out:

```yaml
# agent.yaml
parallelToolExecution: false   # force sequential
```

```typescript
// Or via code
const agent = createAgent({ parallelToolExecution: false })
```

**Files changed:**
- `src/agent/agent-loop.ts` — split execute phase, add `Promise.allSettled` path
- `src/agent/create-agent.ts` — default changed to `true`; reads from YAML
- `src/config/loader.ts` — added `parallelToolExecution` to `AgentYAMLConfig`

**Trade-offs:**
- Order of `recentSuccessfulTools` session state updates is non-deterministic within a round (still correct across rounds)
- 3-strike state is consistent — pre-checks are still sequential

---

### 3. Typed Agent Hooks (`AgentHooks`)

**Problem:** The existing `EventBus` uses string-typed events (`'tool:call'`, etc.) — no autocomplete, no compile-time safety, easy to mistype.

**Solution:** Added `AgentHooks` interface with strongly-typed lifecycle hooks that integrate with `AgentLoopConfig`. These complement (not replace) the EventBus. The hooks cover the most common extension points:

- `beforeToolCall` — can block tool execution with a reason
- `afterToolCall` — observe tool result
- `onTurnStart` / `onTurnEnd` — observe each LLM round
- `onRunStart` / `onRunEnd` — observe the full agent run

**Files changed:**
- `src/core/agent-hooks.ts` — new file, `AgentHooks` interface + payload types
- `src/agent/agent-loop.ts` — call hooks at the right lifecycle points
- `src/index.ts` — export `AgentHooks` and payload types

**Usage:**
```typescript
const agent = createAgent({
  hooks: {
    beforeToolCall: async ({ tool, input }) => {
      if (tool === 'bash' && input.command.includes('rm -rf')) {
        return { block: true, reason: 'Destructive command blocked' }
      }
    },
    afterToolCall: ({ tool, result, durationMs }) => {
      metrics.record(tool, durationMs)
    }
  }
})
```

---

## Backlog

### 4. Operations Interface DI per Tool (Medium)

**Problem:** Tools receive the full `Runtime` object. This makes it impossible to run tools against remote filesystems (SSH, Docker, containers) without replacing the whole Runtime.

**Approach:** Add optional `createOperations(runtime) => Operations` factory to tool definition. When present, construct per-invocation operations instead of passing raw Runtime.

### 5. Tool Result content/details Separation (Medium) ✅

**Problem:** Tool results have a single `data` field. The LLM gets the same JSON-serialized representation as the UI — no way to send a compact summary to the LLM while preserving full-fidelity data for the UI.

**Solution:** Added optional `llmSummary?: string` to `ToolResult`. When present, the agent loop sends this string to the LLM instead of serializing `data`. The `onToolResult` callback (UI path) still receives the full result object including `data`.

**Files changed:**
- `src/types/tool.ts` — add `llmSummary?: string` to `ToolResult`
- `src/agent/agent-loop.ts` — prefer `result.llmSummary` when building `resultContent` for LLM

**Usage:**
```typescript
// In a tool's execute():
return {
  success: true,
  data: { unifiedDiff: '--- a/foo.ts\n+++ b/foo.ts\n...', changedFiles: 3 },
  llmSummary: 'Changed 3 files: foo.ts, bar.ts, baz.ts'
  // LLM sees: "Changed 3 files: foo.ts, bar.ts, baz.ts"
  // UI via onToolResult sees: full { unifiedDiff, changedFiles } object
}
```

### 6. No-throw Contract on Critical Paths (Medium) ✅

**Problem:** `streamWithCallbacks` can throw before streaming starts (e.g. connection refused, SDK init error). This bypasses the transient-retry / context-overflow recovery logic in AgentLoop, crashing straight into the outer catch.

**Solution:** Added `Result<T, E>` discriminated union + `tryCatch()` utility. Wrapped the `streamWithCallbacks` call with `tryCatch()` so that thrown errors are funnelled into the existing `llmError` path — all recovery logic (transient retry, context-window trim, budget summary) runs unchanged.

**Files changed:**
- `src/utils/result.ts` — new file: `Result<T,E>`, `ok()`, `err()`, `tryCatch()`
- `src/agent/agent-loop.ts` — wrap `streamWithCallbacks` with `tryCatch`; convert throws to `llmError`
- `src/index.ts` — export `Result`, `ok`, `err`, `tryCatch`

**Usage:**
```typescript
import { tryCatch } from 'agent-foundry'

const r = await tryCatch(() => someRiskyAsyncOp())
if (!r.ok) {
  console.error(r.error.message)
  return
}
console.log(r.value) // typed and safe
```

### 7. Steering / Follow-up Message Queues (Medium) ✅

**Problem:** There's no way to inject a message mid-run without modifying the system prompt or waiting for the run to complete.

**Solution:** `AgentRunHandle` wraps `AgentLoop.run()` and exposes `steer()` and `followUp()`. The handle is `PromiseLike<AgentRunResult>` so `await agent.run(...)` is fully backward compatible.

- **`steer(message)`** — injected as a user-role message at the top of the next loop iteration, before the LLM call
- **`followUp(message)`** — queued and consumed when the agent would otherwise stop (no tool calls), continuing execution

Both buffer messages before the loop starts (handles timing) and drain them to the live `AgentLoop` once attached.

**Files changed:**
- `src/agent/agent-run-handle.ts` — new file, `AgentRunHandle` class
- `src/agent/agent-loop.ts` — `steeringQueue`, `followUpQueue`, `steer()`, `followUp()`, loop injection
- `src/agent/create-agent.ts` — `run()` returns `AgentRunHandle`; pass `parallelToolExecution`/`hooks` through
- `src/agent/define-agent.ts` — same pattern, `run()` returns `AgentRunHandle`
- `src/types/agent.ts` — `Agent.run` return type updated to `AgentRunHandle`
- `src/types/trace.ts` — added `agent.steering` and `agent.followUp` trace event types
- `src/index.ts` — export `AgentRunHandle`

**Usage:**
```typescript
// Backward compatible — await still works
const result = await agent.run('Research quantum computing')

// Mid-run steering
const handle = agent.run('Analyze this codebase')
setTimeout(() => handle.steer('Prioritize security issues'), 3000)
const result = await handle

// Agentic pipeline via follow-ups (chained before run starts)
const result = await agent
  .run('Research quantum computing')
  .followUp('Write an executive summary')
  .followUp('Translate the summary to Chinese')
```

### 8. Tree-structured Session Branching (Low)

Add `parentId` to turn records so conversations can branch. `agent.fork(fromTurnId)` creates a new session branch. Enables "try this approach, rollback to turn N if it fails."

### 9. Extension Hot-reload (Low)

Add file watcher on `~/.agentfoundry/extensions/` and `.agentfoundry/extensions/`. On change, reload the extension module and re-register its tools/policies/skills.

### 10. More Providers + Compat Flags (Low)

Add structured `compat` field to `ModelConfig` for OpenAI-compatible API variance (Groq, Cerebras, OpenRouter). Extend model registry to 20+ models.

### 11. Markdown-file Skill Support (Low)

Allow skills defined as `.md` files with YAML frontmatter (like pi-mono). Auto-discover from `~/.agentfoundry/skills/` and `.agentfoundry/skills/`.

---

## Gap Analysis Batch 2 — Implemented

### GAP-16. Edit Tool Fuzzy Matching (High) ✅

**Problem:** `edit` tool used exact string matching against raw file bytes. Files with BOM (`\uFEFF`), CRLF (`\r\n`), or Unicode normalization variants caused silent match failures — the agent would receive `old_string not found` even though the content was visually identical.

**Solution:** Normalize both the file content and `old_string`/`new_string` before matching:
1. Strip leading BOM from file content
2. Normalize `\r\n` and lone `\r` → `\n` in content, `old_string`, and `new_string`

**Files changed:**
- `src/tools/edit.ts` — normalize content after read; normalize old/new string before compare/replace

---

### GAP-3. Iterative Compaction Summary (High) ✅

**Problem:** `CompactionEngineV2` always generated a full summary from scratch. In long sessions with multiple compaction cycles, the LLM had to re-summarize already-compacted history, wasting tokens and losing coherence.

**Solution:** Added `previousSummary?: string` to `maybeCompact()`. When provided, uses `UPDATE_COMPACTION_PROMPT` which asks the LLM to incrementally update the previous summary with only the new turns. `KernelV2Impl` tracks the last segment summary per session in `lastCompactionSummaryBySession` and passes it on each subsequent compaction.

**Files changed:**
- `src/kernel-v2/compaction-engine-v2.ts` — `UPDATE_COMPACTION_PROMPT`; `previousSummary` param; branch in LLM path
- `src/kernel-v2/kernel.ts` — `lastCompactionSummaryBySession` map; pass `previousSummary` to `maybeCompact`

---

### GAP-11. Skill Pointer Mode + `skill.load` Context Source (High) ✅

**Problem:** Lazy/on-demand skills injected their full summary text (~80-100 tokens each) into the system prompt from the very first turn, even if the agent never needed them.

**Solution:**
- Lazy and on-demand skills now inject a compact pointer hint (~20 tokens) instead of the summary: `> **[skill:ID]** Short description — call ctx-get("skill.load", {"id": "ID"}) to load full instructions.`
- Added `skill.load` context source (registered in safe pack) — when the agent calls `ctx-get("skill.load", { id })`, it gets the full skill content on demand.
- Full content is still auto-loaded when `onToolUsed` fires (lazy strategy unchanged).

**Token savings:** ~60-80 tokens per lazy/on-demand skill per turn before first use.

**Files changed:**
- `src/skills/skill-manager.ts` — `buildPointerContent()`; removed `buildSummaryContent()`; use pointer in `initializeSkillContent` and `downgrade`
- `src/context-sources/skill-load.ts` — new context source `skill.load`
- `src/context-sources/index.ts` — export + register in `builtinContextSources`
- `src/packs/safe.ts` — register `skillLoad` context source in both pack variants

**Usage:**
```typescript
// Agent sees in system prompt:
// > **[skill:git-workflow]** Git operations and branch management — call ctx-get("skill.load", {"id": "git-workflow"}) to load full instructions.

// Agent calls when needed:
// ctx-get("skill.load", { "id": "git-workflow" })
// → returns full procedures, examples, troubleshooting
```

---

### GAP-9. `transformContext` Hook (High) ✅

**Problem:** No way to modify the message array sent to the LLM on a per-call basis. RAG injection, message filtering, and dynamic system augmentation required patching the core loop.

**Solution:** Added optional `transformContext` to `AgentLoopConfig` and `CreateAgentOptions`. Called just before each LLM request with a shallow copy of `this.messages`. The return value is what gets sent to the LLM. The original message history is never modified — changes are scoped to the outbound call only.

**Files changed:**
- `src/agent/agent-loop.ts` — `transformContext?` in `AgentLoopConfig`; apply before `streamWithCallbacks`
- `src/agent/create-agent.ts` — `transformContext?` in `CreateAgentOptions`; wire through to `AgentLoop`
- `src/index.ts` — export note

**Usage:**
```typescript
// RAG injection: prepend retrieved context to every LLM call
const agent = createAgent({
  transformContext: async (messages) => {
    const context = await vectorDB.search(messages.at(-1)?.content)
    return [
      { role: 'user', content: `Relevant context:\n${context}` },
      ...messages
    ]
  }
})

// Message filtering: remove tool results older than N turns
const agent = createAgent({
  transformContext: (messages) => {
    const recent = messages.slice(-20)
    return recent
  }
})
```

---

## Gap Analysis Batch 3 — Implemented

### GAP-17. Per-tool Timeout (Low) ✅

**Problem:** Long-running tools (e.g. `bash` running a slow build) had no individual timeout — only the overall IO limit applied.

**Solution:** Added `timeout?: number` (milliseconds) to the `Tool` and `ToolConfig` interfaces. `ToolRegistry.call()` wraps `tool.execute()` in a `Promise.race` with a cleanup timer when the field is set. `defineTool()` copies the field through.

**Files changed:**
- `src/types/tool.ts` — `timeout?: number` on `Tool` and `ToolConfig`
- `src/core/tool-registry.ts` — `withTimeout<T>()` helper; applied in `call()`
- `src/factories/define-tool.ts` — copy `timeout` from config

**Usage:**
```typescript
const myTool = defineTool({
  name: 'slow-op',
  timeout: 30_000, // 30 s hard cap
  execute: async (input) => { /* ... */ }
})
```

---

### GAP-18. AbortSignal Propagation (Medium) ✅

**Problem:** `agent.stop()` set a boolean flag but did not cancel in-flight I/O — `bash` commands and other async operations continued until they completed naturally.

**Solution:**
- `AgentLoop.run()` creates a fresh `AbortController` each call
- `AgentLoop.stop()` also calls `controller.abort()`
- Both `toolRegistry.call()` invocations in the loop pass `signal: this.abortController?.signal`
- `ToolRegistry.call()` already threads `signal` into `ToolContext`
- `RuntimeIO.exec()` attaches a `SIGTERM` handler on `options.signal`
- `bash` tool destructures `signal` from context and passes it to `runtime.io.exec()`

**Files changed:**
- `src/types/tool.ts` — `signal?: AbortSignal` on `ToolContext`
- `src/types/runtime.ts` — `signal?: AbortSignal` on `ExecOptions`
- `src/agent/agent-loop.ts` — `abortController` field, init in `run()`, abort in `stop()`, pass signal to tool calls
- `src/core/runtime-io.ts` — SIGTERM handler in `exec()` when signal given
- `src/tools/bash.ts` — destructure `signal` from context; pass to `runtime.io.exec()`

---

### GAP-10. Message Pinning (Medium) ✅

**Problem:** There was no way to keep messages permanently visible in every LLM call — useful for persistent instructions, identity documents, or critical context that must never be lost to compaction or trimming.

**Solution:**
- `AgentLoop` gains a `pinnedMessages: Message[]` array, initialized from `config.pinnedMessages`
- Before each LLM call, pinned messages are prepended to `messagesToSend` (after `transformContext`)
- `AgentLoop.pin(message)` adds a message dynamically
- `AgentRunHandle.pin(message)` buffers the call before the loop attaches, then drains on attach
- `CreateAgentOptions.pinnedMessages` wired through to `AgentLoopConfig`

**Files changed:**
- `src/core/message-store.ts` — `pin()` method, pinned array, `buildView()` prepends pinned
- `src/agent/agent-loop.ts` — delegates to `this.store.pin()`
- `src/agent/agent-run-handle.ts` — `pin()` with pre-attach buffer, `_pinBuffer`
- `src/agent/create-agent.ts` — `pinnedMessages` and `preCallTrimThreshold` in `CreateAgentOptions`, wired to `AgentLoop`

**Usage:**
```typescript
// Static pinning at creation
const agent = createAgent({
  pinnedMessages: [
    { role: 'user', content: 'You are helping with project X. Always cite sources.' }
  ]
})

// Dynamic pinning mid-run
const handle = agent.run('Start the analysis')
handle.pin({ role: 'user', content: 'Focus on security vulnerabilities only.' })
const result = await handle
```

---

### GAP-6. Token Pre-estimation Before LLM Call (Medium) ✅

**Problem:** The agent had no proactive defense against context overflow — it relied entirely on post-hoc error recovery (context trim after a 400 error). This caused wasted API calls.

**Solution:** After building `messagesToSend`, estimate tokens via `countTokens(JSON.stringify(messagesToSend))`. If the estimate exceeds `contextWindow * preCallTrimThreshold` (default 0.85), drop the oldest non-pinned messages until back under the threshold.

**Files changed:**
- `src/agent/agent-loop.ts` — delegates to `MessageStore.buildView()` for transform→pin→trim pipeline
- `src/core/message-store.ts` — `trimToFit()` implements the token estimation and oldest-first drop
- `src/agent/create-agent.ts` — `contextWindow` (already existed) and `preCallTrimThreshold` wired through

**Usage:**
```typescript
const agent = createAgent({
  contextWindow: 128_000,      // model's actual window
  preCallTrimThreshold: 0.85,  // trim when >85% full (default)
})
```

---

## Architecture: MessageStore Extraction

**Problem:** `agent-loop.ts` (~1370 lines) mixed execution logic with message state management — `this.messages`, `this.pinnedMessages`, transform/pin/trim pipeline were scattered across ~25 call sites.

**Solution:** Extracted `MessageStore` class (`src/core/message-store.ts`, ~105 lines) that owns all message state:
- `append()` / `appendAll()` — add messages to history
- `pin()` — pin messages (never trimmed)
- `getHistory()` / `getPinned()` — immutable snapshots
- `setHistory()` / `clear()` — compaction support
- `buildView()` — constructs the LLM call view: transform → pin → trim (GAP-9 + GAP-10 + GAP-6)

`AgentLoop` now holds `private store: MessageStore` and delegates all message operations. The 25-line messagesToSend construction block collapsed to `await this.store.buildView()`.

**Files changed:**
- `src/core/message-store.ts` — new file (~105 lines)
- `src/agent/agent-loop.ts` — replaced all `this.messages` / `this.pinnedMessages` with `this.store.*`
- `tests/core/message-store.test.ts` — 12 behavior tests

This is the embryo of the **View** primitive — the fifth orthogonal axis alongside Tool, Policy, Context Source, and Message.

---

### GAP-12. Tool Retry Signal from execute() (Medium) ✅

**Problem:** When a tool fails due to a transient issue (e.g., external API 503), the framework classifies the error via heuristic pattern matching on the error string. This is unreliable — the tool knows *why* it failed but has no way to communicate that. All non-classified errors fall through to `agent_retry` (LLM round-trip), wasting tokens on something the executor could retry silently.

**Solution:** Added `retry?: ToolRetrySignal` field to `ToolResult`. When a tool returns `success: false` with `retry.shouldRetry: true`, the executor retries the tool call transparently (no LLM round-trip), using the tool's suggested delay and attempt count. This takes priority over the framework's error classification.

Safety constraints:
- `maxAttempts` capped at 5 regardless of what the tool requests
- `RetryBudget` still enforced — budget exhaustion stops retries
- On each retry, the executor checks if the latest result still has `shouldRetry: true` — tools can withdraw the retry request mid-sequence
- If retries are exhausted, the error falls through to `agent_retry` with the tool's optional `guidance` appended to the feedback

**Interface:**
```typescript
interface ToolRetrySignal {
  shouldRetry: boolean    // Request executor-level retry
  delayMs?: number        // Delay between retries (default: 1000ms)
  maxAttempts?: number    // Max retries (default: 2, capped at 5)
  guidance?: string       // Custom advice for LLM if retries exhausted
}

// Usage in tool execute():
return {
  success: false,
  error: 'Service temporarily unavailable',
  retry: { shouldRetry: true, delayMs: 2000, maxAttempts: 3 }
}
```

**Files changed:**
- `src/types/tool.ts` — `ToolRetrySignal` interface, `retry?` field on `ToolResult`
- `src/types/index.ts` — export `ToolRetrySignal`
- `src/index.ts` — export `ToolRetrySignal`
- `src/agent/agent-loop.ts` — executor retry loop checks `result.retry` before error classification; appends `retry.guidance` to feedback
- `tests/agent/tool-retry-signal.test.ts` — 7 behavior tests

### 4. Operations Interface DI per Tool (Medium) ✅

**Problem:** All tools share the same `RuntimeIO` instance — the agent's local filesystem. This makes it impossible to run specific tools against remote hosts (SSH, Docker) or sandboxed environments without replacing the entire agent's IO.

**Solution:** Two-layer IO provider design:

1. **Agent-level**: `ioProvider` on `CreateAgentOptions` — replaces the default `LocalRuntimeIO` for all tools
2. **Tool-level**: `createIO` on `Tool`/`ToolConfig` — per-tool IO override, receives the agent's default IO for composition

Priority: `tool.createIO` > `agent.ioProvider` > default `LocalRuntimeIO`

This enables mixed local+remote workflows: most tools use local IO, but a `deploy` tool targets a Docker container, and a `remote-exec` tool uses SSH — all in the same agent.

**Interface:**
```typescript
// Agent-level: all tools default to this IO
const agent = createAgent({
  ioProvider: ({ projectPath }) => createSSHIO({ host: 'build-server', projectPath })
})

// Tool-level: override for specific tools
const deployTool = defineTool({
  name: 'deploy',
  // ...
  createIO: (defaultIO, runtime) => createDockerIO({ container: 'app' })
})

// Hybrid: reads from remote, writes to local
const hybridTool = defineTool({
  name: 'sync',
  // ...
  createIO: (defaultIO, runtime) => ({
    ...defaultIO,                           // local writes
    readFile: remoteIO.readFile,            // remote reads
    exec: remoteIO.exec                     // remote exec
  })
})
```

**Key design decisions:**
- `createIO` is called on every `ToolRegistry.call()` invocation (not cached) — tools can return different IOs based on runtime state
- The custom IO is set on a shallow copy of the runtime object — the shared runtime is never mutated
- `ioProvider` is synchronous (matches `createAgent`'s synchronous return); `tool.createIO` supports async (awaited in `ToolRegistry.call()`)

**Files changed:**
- `src/types/tool.ts` — `createIO?` field on `Tool` and `ToolConfig`
- `src/factories/define-tool.ts` — passes `createIO` through
- `src/core/tool-registry.ts` — assembles per-tool IO in `call()`, creates runtime copy with custom IO
- `src/agent/create-agent.ts` — `ioProvider?` on `CreateAgentOptions`, wired into RuntimeIO construction
- `tests/core/operations-di.test.ts` — 9 behavior tests

### 12. Streaming-First Event Architecture (High) ✅

**Problem:** AgentFoundry's streaming was callback-based (`onStream`, `onToolCall`, `onToolResult`). Consumers couldn't iterate over a unified event stream — they had to register separate callbacks, which made composition, filtering, and SSE forwarding clumsy. Pi-mono's core abstraction is streaming-first: `for await (const event of agent.run(...))`.

**Solution:** Unified `AgentEvent` type + `AsyncIterable` API at both `AgentLoop` and `AgentRunHandle` levels.

New consumer API:
```typescript
// Streaming consumption (new)
for await (const event of agent.run(prompt).events()) {
  switch (event.type) {
    case 'text-delta':    process.stdout.write(event.text); break
    case 'tool-call':     console.log(`→ ${event.tool}`); break
    case 'tool-result':   console.log(`${event.tool}: ${event.success}`); break
    case 'step-start':    console.log(`Step ${event.step}`); break
    case 'done':          console.log(event.result.output); break
  }
}

// Traditional await (fully backward-compatible, unchanged)
const result = await agent.run(prompt)

// Callback API (still works, fires alongside stream events)
createAgent({ onStream: (chunk) => ..., onToolCall: (t, i) => ... })
```

**AgentEvent types:**
- `text-delta` — incremental LLM text chunk
- `tool-call` — LLM requested a tool call
- `tool-result` — tool execution completed (success/failure, duration)
- `step-start` / `step-finish` — step (LLM round) boundaries
- `error` — recoverable/non-recoverable error
- `done` — run completed, contains full `AgentRunResult`

**Architecture:**
1. `AgentLoop.run()` instrumented to push events to an optional `AsyncChannel` when active
2. `AgentLoop.runStream()` sets up the channel, delegates to `run()`, yields events + final `done`
3. `AgentRunHandle` constructor accepts `emitEvent` callback from executor
4. `createAgent` uses `runStream()` internally, forwards events to handle's replay channel
5. `AgentRunHandle.events()` returns the replay channel as `AsyncIterable<AgentEvent>`
6. `AsyncChannel` utility bridges push-based callbacks to pull-based `AsyncIterator`

**Key design decisions:**
- Zero changes to `AgentLoop.run()` internals — events are emitted via `_eventChannel?.push()` at instrumented points
- Callbacks (`onText`, `onToolCall`, `onToolResult`) still fire alongside stream events
- `steer()` / `followUp()` / `stop()` work in stream mode
- All 1535 existing tests pass unchanged (full backward compatibility)

**Files changed:**
- `src/types/agent-event.ts` — new file: `AgentEvent` union type + per-event interfaces
- `src/types/index.ts` — exports AgentEvent types
- `src/index.ts` — exports AgentEvent types
- `src/utils/async-channel.ts` — new file: callback→AsyncIterator bridge
- `src/agent/agent-loop.ts` — `_eventChannel` field, `runStream()` method, event push at 6 instrumented points
- `src/agent/agent-run-handle.ts` — `events()` method, replay channel via `emitEvent` callback
- `src/agent/create-agent.ts` — switched to `runStream()`, wires `emitEvent` to handle
- `tests/utils/async-channel.test.ts` — 6 channel unit tests
- `tests/agent/agent-stream.test.ts` — 7 streaming behavior tests
- `examples/hello-world/with-streaming.ts` — streaming consumption example

### 10. More Providers + Compat Flags (Low) ✅

**Problem:** AgentFoundry supported only 4 providers (OpenAI, Anthropic, Google, DeepSeek) with 19 models. Adding new OpenAI-compatible providers (Groq, xAI, Cerebras, etc.) required writing new SDK initialization code and hardcoded if/else branches.

**Solution:** Two-axis provider architecture inspired by pi-mono:

1. **API Protocol** (`ApiProtocol`) — the wire-level contract: `openai-chat`, `openai-responses`, `anthropic-messages`, `google-generative`
2. **Provider Definition** (`ProviderDefinition`) — declarative brand config: `id`, `baseUrl`, `apiKeyEnv`, `compat` flags, `models[]`
3. **Compat Flags** (`OpenAICompat`) — structured quirk descriptions: `maxTokensField`, `supportsDeveloperRole`, `supportsStrictMode`, `supportsReasoningEffort`, `thinkingFormat`, etc.

New providers are added as pure configuration — no new code branches needed. The streaming layer uses `apiProtocol` + `compat` flags instead of `if (provider === 'xxx')` checks.

**7 new Tier 2 providers added** (Groq, xAI, Cerebras, OpenRouter, Together, Fireworks, Mistral) with ~20 new models. Users can also register custom providers at runtime.

**Usage:**
```yaml
# agent.yaml — use Groq
model:
  default: "llama-3.3-70b-versatile"
  provider: "groq"
```

```typescript
// Code — use any registered provider
const agent = createAgent({ model: 'grok-3', provider: 'xai' })

// Register a custom OpenAI-compatible provider
import { registerProvider } from 'agent-foundry'
registerProvider({
  id: 'my-corp',
  name: 'Corp LLM',
  apiProtocol: 'openai-chat',
  baseUrl: 'https://llm.corp.internal/v1',
  apiKeyEnv: 'CORP_LLM_KEY',
  compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
  models: [
    { id: 'corp-72b', name: 'Corp 72B',
      capabilities: { temperature: true, reasoning: false, toolcall: true, input: ['text'], output: ['text'] },
      limit: { maxContext: 128_000, maxOutput: 8_192 } }
  ]
})
```

**Files changed:**
- `src/llm/compat.ts` — new file: `ApiProtocol`, `OpenAICompat`, `ResolvedCompat`, `resolveCompat()`
- `src/llm/provider-definitions.ts` — new file: `ProviderDefinition`, `ModelDefinition`, 11 builtin providers, runtime registry API
- `src/llm/provider.types.ts` — `ProviderID` expanded with Tier 2 IDs + open string extension
- `src/llm/models.ts` — auto-registers Tier 2 models from provider definitions
- `src/llm/provider.ts` — `getLanguageModel()` handles dynamic providers; `resolveApiKey()` uses definition's `apiKeyEnv`; `getAllProviders()` includes all providers
- `src/llm/stream.ts` — `ProviderContext` replaces raw `ProviderID`; `buildReasoningProviderOptions()` uses protocol; `convertMessages()` uses `apiProtocol` + `compat.supportsCaching`
- `src/llm/provider-style.ts` — style normalization applies to all non-Anthropic providers
- `src/llm/index.ts` — exports compat + provider-definitions modules
- `src/llm/cost-calculator.ts` — `Record<string, number>` for extensibility
- `src/index.ts` — exports new public API
- `src/config/loader.ts` — accepts any provider string in validation
- `src/agent/create-agent.ts` — Tier 2 env var detection; dynamic API key resolution
- `src/cli/validate-deep.ts` — flexible provider type maps
- `src/config/loader.ts` — `ProviderConfigEntry` interface; `model.provider` accepts `string | ProviderConfigEntry`; inline provider validation; `resolveProviderIdFromConfig()` helper
- `src/config/index.ts` — exports new types and helper
- `src/agent/create-agent.ts` — `registerInlineProvider()` converts YAML model config to `ProviderDefinition` and registers it; resolves provider ID from union type
- `src/cli/validate-deep.ts` — handles `model.provider` as string or object
- `tests/llm/provider-definitions.test.ts` — 20 tests for provider registry + compat
- `tests/llm/compat-streaming.test.ts` — 15 tests for compat-driven streaming behavior
- `tests/config/yaml-provider.test.ts` — 17 tests for YAML inline provider config, validation, and registration

**YAML inline provider support (PR3):**

Users can now define custom providers directly in `agent.yaml` without writing any code:

```yaml
# agent.yaml — custom OpenAI-compatible provider
model:
  default: "my-model"
  provider:
    id: "my-provider"
    name: "My Provider"
    baseUrl: "https://my-llm.internal/v1"
    apiProtocol: "openai-chat"
    apiKeyEnv: "MY_LLM_KEY"
    compat:
      maxTokensField: "max_tokens"
      supportsDeveloperRole: false
    models:
      - id: "my-model"
        name: "My Model"
        maxContext: 32000
        maxOutput: 4096
        toolcall: true
```

The inline provider is automatically registered via `registerProvider()` during `createAgent()`, making it immediately available for model resolution and SDK creation.

### 11. Markdown-file Skill Support + Install (Low) ✅

**Problem:** Skills could already be loaded from `SKILL.md` files in `.agentfoundry/skills/`, but there was no way to install them from external sources (GitHub, URLs) and no CLI to manage them. Users had to manually create directories and copy files.

**Solution:** Added a complete skill distribution/installation system:

1. **`SkillInstaller`** — core install/remove/list logic supporting GitHub paths and URLs
2. **CLI `skill` subcommand** — `list`, `install`, `remove`, `info`
3. **YAML `skills` field** — declare skill dependencies in `agent.yaml` for auto-install
4. **Provenance tracking** — `.source.json` metadata file records install source

**CLI Usage:**
```bash
# List all available skills (local + community-builtin)
agent-foundry skill list

# Install from GitHub (owner/repo/path)
agent-foundry skill install anthropics/af-skills/web-research

# Install from URL
agent-foundry skill install https://example.com/my-skill/SKILL.md

# Remove a skill
agent-foundry skill remove web-research

# Show skill details
agent-foundry skill info markitdown
```

**YAML Declaration (auto-install on first run):**
```yaml
# agent.yaml
skills:
  - id: "markitdown"                        # local skill (already installed)
  - github: "user/repo/skills/web-research"  # auto-install from GitHub
  - url: "https://example.com/SKILL.md"      # auto-install from URL
```

**Install from GitHub:**
- Parses `owner/repo[/path]` format
- Uses GitHub Contents API to download `SKILL.md` + `scripts/`
- Supports `GITHUB_TOKEN` env var for private repos and rate limits
- Skills persist in `.agentfoundry/skills/<skill-id>/`

**Files changed:**
- `src/skills/skill-installer.ts` — new file: `SkillInstaller` class with GitHub/URL download, remove, list
- `src/cli/skill.ts` — new file: CLI `skill list/install/remove/info` subcommands
- `src/cli/bin.ts` — wired `skill` command into CLI router
- `src/cli/index.ts` — exports skill command
- `src/config/loader.ts` — `SkillDependencyEntry` interface, `skills` field in `AgentYAMLConfig`, validation
- `src/config/index.ts` — exports new types
- `src/agent/create-agent.ts` — auto-install declared skills in `initPacks()` before ExternalSkillLoader runs
- `src/skills/index.ts` — exports `SkillInstaller`
- `src/index.ts` — exports new types and classes
- `tests/skills/skill-installer.test.ts` — 11 tests for install, list, remove, provenance
- `tests/config/yaml-skills.test.ts` — 11 tests for YAML skills validation
