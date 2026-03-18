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
| 5 | Tool result content/details separation | Medium | Backlog |
| 6 | No-throw contract on critical paths | Medium | Backlog |
| 7 | Steering/follow-up message queues | Medium | Backlog |
| 8 | Tree-structured session branching | Low | Backlog |
| 9 | Extension hot-reload | Low | Backlog |
| 10 | More providers + compat flags | Low | Backlog |
| 11 | Markdown-file skill support | Low | Backlog |

---

## Implemented

### 1. LLM-driven Context Compaction

**Problem:** `CompactionEngineV2` used heuristic summarization — slicing the first 120 chars of each turn. This loses most semantic content, making long-conversation compaction nearly useless.

**Solution:** Added optional `summarizeFn` injection to `CompactionEngineV2`. When provided, compaction calls the LLM to generate a structured semantic summary covering goals, progress, decisions, file changes, and remaining work. Falls back to heuristic if the LLM call fails.

**Files changed:**
- `src/kernel-v2/compaction-engine-v2.ts` — accept `summarizeFn`, call it if available
- `src/kernel-v2/types.ts` — add `compaction.llmSummarization?: boolean` to config
- `src/kernel-v2/kernel.ts` — accept and wire `summarizeFn` through to engine
- `src/agent/create-agent.ts` — inject LLM-based summarizeFn when enabled

**Usage:**
```yaml
# agent.yaml
kernelV2:
  compaction:
    llmSummarization: true   # default: false
```

---

### 2. Parallel Tool Execution

**Problem:** All tool calls within a single LLM response were executed sequentially. If the agent asks to read 5 files simultaneously, they execute one-by-one.

**Solution:** Added `parallelToolExecution` option to `AgentLoopConfig`. When enabled, the pre-validation phase (3-strike check, subset check) runs sequentially, then all valid tool calls execute in parallel via `Promise.allSettled`. Results are collected in source order.

**Files changed:**
- `src/agent/agent-loop.ts` — split execute phase, add `Promise.allSettled` path

**Usage:**
```typescript
const agent = createAgent({
  parallelToolExecution: true,  // default: false
  // ...
})
```

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

### 5. Tool Result content/details Separation (Medium)

**Problem:** Tool results have a single `data` field. The LLM gets the same representation as the UI.

**Approach:** Add optional `details` to `ToolResult`. `content` (string, for LLM) can be a compact summary; `details` (typed object, for UI) contains the full rich output (diffs, file trees, etc.).

### 6. No-throw Contract on Critical Paths (Medium)

**Problem:** If `streamWithCallbacks` or `contextManager.get()` throws unexpectedly, the agent loop crashes rather than returning a structured error.

**Approach:** Wrap the LLM streaming call and context assembly in Result-typed wrappers. Return `{ ok: false, error }` rather than throwing.

### 7. Steering / Follow-up Message Queues (Medium)

**Problem:** There's no way to inject a message mid-run without modifying the system prompt or waiting for the run to complete.

**Approach:** Add `steer(message: string)` and `followUp(message: string)` methods to the agent run handle. Steering interrupts between tool calls; follow-up waits until the run ends and starts a new round.

### 8. Tree-structured Session Branching (Low)

Add `parentId` to turn records so conversations can branch. `agent.fork(fromTurnId)` creates a new session branch. Enables "try this approach, rollback to turn N if it fails."

### 9. Extension Hot-reload (Low)

Add file watcher on `~/.agentfoundry/extensions/` and `.agentfoundry/extensions/`. On change, reload the extension module and re-register its tools/policies/skills.

### 10. More Providers + Compat Flags (Low)

Add structured `compat` field to `ModelConfig` for OpenAI-compatible API variance (Groq, Cerebras, OpenRouter). Extend model registry to 20+ models.

### 11. Markdown-file Skill Support (Low)

Allow skills defined as `.md` files with YAML frontmatter (like pi-mono). Auto-discover from `~/.agentfoundry/skills/` and `.agentfoundry/skills/`.
