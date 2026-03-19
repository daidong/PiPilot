# Pi-Mono Inspired Improvements

> Based on architectural comparison with [pi-mono](https://github.com/badlogic/pi-mono).
> See full analysis in conversation history.

## Status

| # | Improvement | Priority | Status |
|---|---|---|---|
| 1 | LLM-driven context compaction | High | ✅ Done |
| 2 | Parallel tool execution | High | ✅ Done |
| 3 | Typed agent hooks (`AgentHooks`) | High | ✅ Done |
| 4 | Operations interface DI per tool | Medium | Backlog |
| 5 | Tool result content/details separation | Medium | ✅ Done |
| 6 | No-throw contract on critical paths | Medium | ✅ Done |
| 7 | Steering/follow-up message queues | Medium | ✅ Done |
| 8 | Tree-structured session branching | Low | Backlog |
| 9 | Extension hot-reload | Low | Backlog |
| 10 | More providers + compat flags | Low | Backlog |
| 11 | Markdown-file skill support | Low | Backlog |

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
| GAP-12 | Tool retry signal from execute() | Medium | Backlog |
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
- `src/agent/agent-loop.ts` — `pinnedMessages` field, `pin()` method, config option
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
- `src/agent/agent-loop.ts` — import `countTokens`; trim loop after `messagesToSend` is finalized
- `src/agent/create-agent.ts` — `contextWindow` (already existed) and `preCallTrimThreshold` wired through

**Usage:**
```typescript
const agent = createAgent({
  contextWindow: 128_000,      // model's actual window
  preCallTrimThreshold: 0.85,  // trim when >85% full (default)
})
```
