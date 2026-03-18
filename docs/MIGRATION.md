# AgentFoundry Migration Guide

This guide covers deprecated APIs and their replacements. Follow these instructions when upgrading your AgentFoundry-based applications.

---

## Table of Contents

1. [promptFragment to Skills](#1-promptfragment--skills)
2. [SimpleAgent to Agent (type renames)](#2-simpleagent--agent-type-renames)
3. [withExecutorRetry to withRetry](#3-withexecutorretry--withretry)
4. [backoffMs / backoffMultiplier to backoff](#4-backoffms--backoffmultiplier--backoff)
5. [SkillScripts removal (Phase 3.1)](#5-skillscripts-removal-phase-31)
6. [Configuration changes (agent.yaml)](#6-configuration-changes-agentyaml)

---

## 1. promptFragment → Skills

### What changed

The `promptFragment` property on packs has been deprecated in favor of the Skills system. Skills provide **progressive disclosure** -- only loading detailed instructions when they are actually needed, rather than stuffing everything into the system prompt up front.

### Why

Token savings of **60-93%** on initial prompts. A pack that previously injected 2000 tokens into every system prompt now loads only a ~100-token summary, with full content loaded lazily when associated tools are first used.

| Scenario | Without Skills | With Skills (initial) | Savings |
|----------|---------------|----------------------|---------|
| Simple file operations | ~2000 tokens | ~800 tokens | 60% |
| Complex research workflow | ~7000 tokens | ~500 tokens | 93% |

### Before

```typescript
import { definePack } from 'agent-foundry'

const myPack = definePack({
  id: 'my-pack',
  description: 'My custom pack',
  tools: [myTool],
  policies: [myPolicy],
  promptFragment: `
## How to use my-tool

### Step 1: Prepare input
Always validate input before calling my-tool...

### Step 2: Handle output
Parse the JSON response and check for errors...

### Examples
Example 1: Basic usage
  { "input": "hello" }

### Troubleshooting
If you see "connection refused", check that the server is running...
  `
})
```

### After

```typescript
import { definePack, defineSkill } from 'agent-foundry'

// Step 1: Extract promptFragment content into a skill
const mySkill = defineSkill({
  id: 'my-skill',
  name: 'My Skill',
  shortDescription: 'Guidance for using my-tool effectively',
  instructions: {
    // ~100 tokens -- always loaded
    summary: 'Use my-tool to process data. Validate input first, then parse JSON output.',

    // ~500 tokens -- loaded when my-tool is first used
    procedures: `
## Step 1: Prepare input
Always validate input before calling my-tool...

## Step 2: Handle output
Parse the JSON response and check for errors...
    `,

    // ~300 tokens -- loaded on demand
    examples: `
## Basic usage
\`\`\`json
{ "input": "hello" }
\`\`\`
    `,

    // loaded when errors occur
    troubleshooting: `
## "connection refused"
- Cause: Server is not running
- Fix: Start the server before calling my-tool
    `
  },
  tools: ['my-tool'],          // Triggers full loading when my-tool is used
  loadingStrategy: 'lazy',     // 'eager' | 'lazy' | 'on-demand'
  tags: ['data-processing']
})

// Step 2: Add the skill to the pack instead of promptFragment
const myPack = definePack({
  id: 'my-pack',
  description: 'My custom pack',
  tools: [myTool],
  policies: [myPolicy],
  skills: [mySkill]
  // promptFragment is removed
})
```

### Migration steps

1. **Create a skill** for each pack that uses `promptFragment`. Split the prompt content into the four instruction sections: `summary`, `procedures`, `examples`, and `troubleshooting`.
2. **Set the `tools` array** on the skill to list which tools it provides guidance for. This enables automatic lazy loading.
3. **Add the skill** to the pack's `skills` array.
4. **Remove the `promptFragment`** property from the pack.
5. **Test** that skill content loads when the associated tool is first used.

> **Note:** If you set both `promptFragment` and `skills` on a pack, `definePack` will emit a console warning. Both will work during the transition period, but `promptFragment` will be removed in a future major version.

### Timeline

`promptFragment` will be removed in a future major version. Migrate at your earliest convenience.

---

## 2. SimpleAgent → Agent (type renames)

### What changed

The `SimpleAgent*` type names and helper functions were renamed to drop the "Simple" prefix. The old names remain as deprecated aliases.

### Before

```typescript
import type {
  SimpleAgent,
  SimpleAgentDefinition,
  SimpleAgentContext,
  SimpleAgentResult,
  SimpleAgentTraceEvent
} from 'agent-foundry'

import { isSimpleAgent, createSimpleAgentContext } from 'agent-foundry'
```

### After

```typescript
import type {
  Agent,              // was SimpleAgent
  AgentDefinition,    // was SimpleAgentDefinition
  AgentContext,       // was SimpleAgentContext
  AgentResult,        // was SimpleAgentResult
  AgentTraceEvent     // was SimpleAgentTraceEvent
} from 'agent-foundry'

import { isAgent, createAgentContext } from 'agent-foundry'
```

### Full mapping

| Deprecated | Replacement |
|------------|-------------|
| `SimpleAgent` | `Agent` |
| `SimpleAgentDefinition` | `AgentDefinition` |
| `SimpleAgentContext` | `AgentContext` |
| `SimpleAgentResult<T>` | `AgentResult<T>` |
| `SimpleAgentTraceEvent` | `AgentTraceEvent` |
| `isSimpleAgent()` | `isAgent()` |
| `createSimpleAgentContext()` | `createAgentContext()` |

> **Note:** The `SchemaFreeAgent`, `SchemaFreeAgentDefinition`, etc. type aliases exported from `src/index.ts` are the **primary recommended exports** that point to the same underlying types. Use whichever naming convention suits your project.

### Migration steps

1. Find-and-replace the type names in your codebase.
2. Update function calls from `isSimpleAgent` to `isAgent` and `createSimpleAgentContext` to `createAgentContext`.

### Timeline

The `Simple*` aliases will be removed in a future major version.

---

## 3. withExecutorRetry → withRetry

### What changed

The standalone `withExecutorRetry()` function has been deprecated in favor of the unified `withRetry()` function, which supports both executor retries (transparent, no LLM tokens) and agent retries (LLM-involved correction).

### Before

```typescript
import { withExecutorRetry } from 'agent-foundry'

const result = await withExecutorRetry(
  () => fetchFromAPI(),
  {
    mode: 'executor_retry',
    maxAttempts: 3,
    backoffMs: 1000,
    backoffMultiplier: 2
  }
)
```

### After

```typescript
import { withRetryExecutor } from 'agent-foundry'
// or: import { withRetry } from 'agent-foundry/core/retry'

const result = await withRetryExecutor(
  () => fetchFromAPI(),
  {
    mode: 'executor_retry',
    maxAttempts: 3,
    backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 }
  }
)
```

### Migration steps

1. Replace `withExecutorRetry(fn, strategy)` with `withRetry(fn, options)`.
2. Convert flat `backoffMs` / `backoffMultiplier` to the `backoff` object (see section 4 below).

### Timeline

`withExecutorRetry` will be removed in a future major version.

---

## 4. backoffMs / backoffMultiplier → backoff

### What changed

The flat `backoffMs` and `backoffMultiplier` properties on `RetryStrategy` have been replaced by a structured `backoff` property that supports multiple strategies.

### Before

```typescript
const strategy: RetryStrategy = {
  mode: 'executor_retry',
  maxAttempts: 3,
  backoffMs: 1000,
  backoffMultiplier: 2
}
```

### After

```typescript
const strategy: RetryStrategy = {
  mode: 'executor_retry',
  maxAttempts: 3,
  backoff: { type: 'exponential', baseMs: 1000, multiplier: 2 }
}
```

### Available backoff strategies

| Type | Properties | Behavior |
|------|-----------|----------|
| `none` | -- | No delay between retries |
| `fixed` | `delayMs` | Same delay every time |
| `exponential` | `baseMs`, `multiplier`, `maxMs?` | Exponential growth with optional cap |
| `custom` | `compute: (attempt) => number` | Fully custom delay function |

### Migration steps

1. Search your codebase for `backoffMs` and `backoffMultiplier`.
2. Replace with the equivalent `backoff` object.
3. If you only used `backoffMs` (without `backoffMultiplier`), use `{ type: 'fixed', delayMs: <value> }`.
4. If you used both, use `{ type: 'exponential', baseMs: <backoffMs>, multiplier: <backoffMultiplier> }`.

### Timeline

`backoffMs` and `backoffMultiplier` will be removed in a future major version.

---

## 5. SkillScripts removal (Phase 3.1)

### What changed

The `SkillScripts` interface and the `scripts` property on skill configurations were identified as dead code (never executed at runtime) and have been removed in Phase 3.1. The `SkillScriptMetadata` type still exists in `meta.scripts` for external skill loaders.

### Who is affected

Only users who referenced the `scripts` generic type parameter on `Skill` or passed a `scripts` property directly to `defineSkill()`. This was never part of the documented public API and had no runtime effect.

### Migration steps

1. Remove any generic type parameters from `Skill<...>` usages -- use plain `Skill` instead.
2. Remove any `scripts` property from `defineSkill()` calls.
3. If you need script metadata for external skills, use `meta.scripts` instead.

### Timeline

Already removed. No deprecation period.

---

## 6. Configuration changes (agent.yaml)

### Skills in agent.yaml

Skills are currently configured **programmatically** through packs (via `definePack({ skills: [...] })`), not through `agent.yaml`. The `agent.yaml` format has not changed its core structure:

```yaml
id: my-agent
name: My Agent
identity: You are a helpful assistant.
constraints:
  - Do not modify files outside the project
packs:
  - safe
  - compute
  - name: exec
    options:
      allowedCommands: ['npm', 'node']
model:
  default: gpt-4o
  provider: openai
  maxTokens: 4096
  temperature: 0.7
  reasoningEffort: medium   # Added for reasoning models
runner:
  mode: autonomous
  maxTurns: 10
maxSteps: 50
```

### New fields since V1

| Field | Added in | Description |
|-------|---------|-------------|
| `model.reasoningEffort` | V2 | Controls reasoning depth for supported models (`low` / `medium` / `high` / `max`) |
| `runner` | V2 | CLI runner configuration (mode, maxTurns, continuePrompt, additionalInstructions) |

### Supported pack names

The following pack names are valid in `agent.yaml`:

```
safe, compute, network, exec, git, exploration,
kv-memory, kvMemory, docs, discovery, todo,
web, documents, sqlite, memory-search, memorySearch
```

> **Note:** The `python` pack is intentionally excluded from YAML configuration because it requires a non-serializable `PythonBridge` instance. Configure it programmatically.

---

## Quick reference: all deprecated APIs

| Deprecated API | Replacement | Location |
|----------------|-------------|----------|
| `Pack.promptFragment` | `Pack.skills` + `defineSkill()` | `src/types/pack.ts` |
| `PackConfig.promptFragment` | `PackConfig.skills` + `defineSkill()` | `src/types/pack.ts` |
| `SimpleAgent` | `Agent` | `src/agent/define-simple-agent.ts` |
| `SimpleAgentDefinition` | `AgentDefinition` | `src/agent/define-simple-agent.ts` |
| `SimpleAgentContext` | `AgentContext` | `src/agent/define-simple-agent.ts` |
| `SimpleAgentResult<T>` | `AgentResult<T>` | `src/agent/define-simple-agent.ts` |
| `SimpleAgentTraceEvent` | `AgentTraceEvent` | `src/agent/define-simple-agent.ts` |
| `isSimpleAgent()` | `isAgent()` | `src/agent/define-simple-agent.ts` |
| `createSimpleAgentContext()` | `createAgentContext()` | `src/agent/define-simple-agent.ts` |
| `withExecutorRetry()` | `withRetry()` | `src/core/retry.ts` |
| `RetryStrategy.backoffMs` | `RetryStrategy.backoff` | `src/core/retry.ts` |
| `RetryStrategy.backoffMultiplier` | `RetryStrategy.backoff` | `src/core/retry.ts` |
| `SkillScripts` (Phase 3.1) | Removed (dead code) | `src/types/skill.ts` |

---

## Need help?

- **Skills system**: See `docs/SKILLS.md` for the full skills documentation.
- **Building apps**: See `docs/AGENT_DEV_GUIDE.md` for framework capabilities.
- **Team module**: See `docs/TEAM.md` for multi-agent collaboration.
