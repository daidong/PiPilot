# RFC-004: Rename Schema-Free Agent → LLMStep

**Status:** Proposed
**Date:** 2026-01-27

## Motivation

The current "schema-free agent" (`defineAgent` in `define-simple-agent.ts`) is not an agent in any meaningful sense. It performs a single LLM call with JSON output parsing — no tool loop, no autonomy, no runtime. Calling it an "agent" creates confusion with the full `Agent` type (which owns a Runtime, ToolRegistry, PolicyEngine, and runs an autonomous loop).

The rename to `LLMStep` makes the concept honest: it is a **step** in a pipeline that wraps a single LLM call.

## Naming Map

| Old Name | New Name |
|----------|----------|
| `defineAgent` (in define-simple-agent.ts) | `defineLLMStep` |
| `Agent` (interface) | `LLMStep` |
| `AgentDefinition` | `LLMStepDefinition` |
| `AgentContext` | `LLMStepContext` |
| `AgentResult` | `LLMStepResult` |
| `AgentTraceEvent` | `LLMStepTraceEvent` |
| `isAgent` | `isLLMStep` |
| `createAgentContext` | `createLLMStepContext` |
| `kind: 'agent'` | `kind: 'llm-step'` |
| File: `define-simple-agent.ts` | File: `define-llm-step.ts` |
| Test: `define-simple-agent.test.ts` | Test: `define-llm-step.test.ts` |

## Design Principles

- **Same interface**: `{ id, kind, run(input, ctx) }` — Team flow combinators work unchanged
- **Full backward compatibility**: All old names kept as `@deprecated` aliases (Simple*, SchemaFree*, Agent/defineAgent)
- **No functional changes**: Only naming; no behavior, API shape, or runtime semantics change

## Files to Change

### 1. Create `src/agent/define-llm-step.ts` (replaces `define-simple-agent.ts`)

- Copy content from `define-simple-agent.ts`, rename all internal types/functions:
  - `Agent` → `LLMStep`, `AgentDefinition` → `LLMStepDefinition`
  - `AgentContext` → `LLMStepContext`, `AgentResult` → `LLMStepResult`
  - `AgentTraceEvent` → `LLMStepTraceEvent`
  - `defineAgent` → `defineLLMStep`, `isAgent` → `isLLMStep`
  - `createAgentContext` → `createLLMStepContext`
  - `kind: 'agent'` → `kind: 'llm-step'`
- Keep deprecated aliases at bottom (all three generations):
  - Generation 1 (Simple*): `SimpleAgent`, `SimpleAgentDefinition`, `isSimpleAgent`, `createSimpleAgentContext`, etc.
  - Generation 2 (SchemaFree*): `SchemaFreeAgent`, `SchemaFreeAgentDefinition`, etc.
  - Generation 3 (Agent/defineAgent): `defineAgent = defineLLMStep`, `isAgent = isLLMStep`, `createAgentContext = createLLMStepContext`

### 2. Delete `src/agent/define-simple-agent.ts`

### 3. Update `src/index.ts` (lines 120-141)

- Change import path from `./agent/define-simple-agent.js` → `./agent/define-llm-step.js`
- Primary exports: `defineLLMStep`, `isLLMStep`, `createLLMStepContext`
- Primary type exports: `LLMStep`, `LLMStepDefinition`, `LLMStepContext`, `LLMStepResult`, `LLMStepTraceEvent`
- Keep all deprecated aliases: `defineSimpleAgent`, `isSchemaFreeAgent`, `createSimpleAgentContext`, `SchemaFreeAgent`, `SchemaFreeAgentDefinition`, `SchemaFreeAgentContext`, `SchemaFreeAgentResult`, `SchemaFreeAgentTraceEvent`, `SimpleAgent`, `SimpleAgentDefinition`, `SimpleAgentContext`, `SimpleAgentResult`, `SimpleAgentTraceEvent`

### 4. Update `src/team/index.ts` (JSDoc only)

- Update the example in the module doc comment (lines 14-75) to use `defineLLMStep` instead of `defineAgent`

### 5. No changes to `src/team/agent-bridge.ts`

- The bridge's private `isAgent()` (line 226) checks `typeof obj['run'] === 'function'` — no `kind` check. Works with both full agents and LLMSteps without changes.

### 6. Create `tests/agent/define-llm-step.test.ts` (replaces old test)

- Copy from `define-simple-agent.test.ts`, update all imports and names
- Update `kind` assertion from `'agent'` to `'llm-step'`

### 7. Delete `tests/agent/define-simple-agent.test.ts`

### 8. Update example files (5 source files)

Update import blocks and variable names:

**Files:**
- `examples/literature-agent/index.ts`
- `examples/research-pilot/agents/data-agent.ts`
- `examples/research-pilot/agents/writing-agent.ts`
- `examples/research-pilot/agents/data-team.ts`
- `examples/research-pilot/agents/literature-team.ts`

Import change pattern:
```typescript
// Old:
import { defineAgent as defineSimpleAgent, createAgentContext, type Agent as SimpleAgent, type AgentContext }
  from '../../src/agent/define-simple-agent.js'

// New:
import { defineLLMStep, createLLMStepContext, type LLMStep, type LLMStepContext }
  from '../../src/agent/define-llm-step.js'
```

Also rename local usages: `defineSimpleAgent(...)` → `defineLLMStep(...)`, `SimpleAgent` → `LLMStep`, `AgentContext` → `LLMStepContext`, `createAgentContext` → `createLLMStepContext`.

**NOT affected:**
- `examples/dataanalysis-agent/index.ts` — uses `defineAgent` from `src/index.ts` which is the full agent factory from `define-agent.ts`, not the simple agent
- `examples/research-pilot-desktop/out/` — build output, not source

### 9. Update `docs/rfcs/RFC-002-schema-free-agent-communication.md`

- Add a note at top about the rename
- Update key code examples to use `defineLLMStep`

## No Changes Needed

- `src/team/flow/simple-step.ts` — already uses "step" naming
- `src/team/agent-bridge.ts` — duck-types on `run()`, no `kind` check
- `src/agent/define-agent.ts` — full agent factory, unrelated
- `src/types/agent.ts` — full `Agent` type, unrelated
- `examples/dataanalysis-agent/` — uses full agent, not simple agent

## Verification

```bash
npm run build       # TypeScript compiles cleanly
npm run test:run    # All tests pass
```
