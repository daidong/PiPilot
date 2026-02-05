# RFC-010: Resourceful Agent & Dynamic Skill System

**Status**: Draft
**Author**: AgentFoundry Team
**Created**: 2025-02-05
**Updated**: 2026-02-05

---

## 1. Summary

Enable AgentFoundry agents to be **resourceful and adaptive** through:

1. Built-in "Resourceful Before Asking" philosophy as a core skill (default on, user can disable)
2. Dynamic skill generation from `SKILL.md` files (OpenClaw-compatible format)
3. External skill storage in `.agentfoundry/skills/` directory
4. Hot-reload capability for runtime skill updates without app restart
5. Skill lifecycle observability in non-debug mode (creation/load/token impact logs)

---

## 2. Motivation

### Current Limitations

AgentFoundry agents can be **overly conservative** by default. This is safe but can slow down problem solving.

Inspired by OpenClaw's design philosophy:

> "Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search for it. Then ask if you're stuck. The goal is to come back with answers, not questions."

### Desired Behavior

| Current | Desired |
|---------|---------|
| "How do I find X?" | Try glob/grep first, then ask |
| "I need permission Y" | Try alternatives, explain attempts |
| Forgets learned patterns | Saves patterns as reusable skills |
| Skills fixed at compile-time | Skills loaded dynamically at runtime |

### Use Cases

1. **Resourceful Problem Solving**: Agent tries multiple approaches before asking
2. **Knowledge Capture**: When agent figures out project-specific patterns, save as skill for future use
3. **Project-Local Skills**: Each project can have its own learned skills in `.agentfoundry/skills/`
4. **Collaborative Learning**: Multiple agents can share skills via the file system

---

## 3. Design Overview

### 3.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      AgentFoundry Runtime                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │   Packs      │    │         SkillManager                  │   │
│  │  ┌────────┐  │    │  ┌─────────────┐  ┌───────────────┐  │   │
│  │  │ safe   │──┼────┼─▶│ Built-in    │  │ External      │  │   │
│  │  │ pack   │  │    │  │ Skills      │  │ SkillLoader   │  │   │
│  │  └────────┘  │    │  │ (SKILL.md)  │  │ (file-based)  │  │   │
│  └──────────────┘    │  └─────────────┘  └───────┬───────┘  │   │
│                      │                           │           │   │
│                      │                    ┌──────▼──────┐    │   │
│                      │                    │ File Watcher │    │   │
│                      │                    │ (hot-reload) │    │   │
│                      └────────────────────┴──────┬───────┴───┘   │
│                                                  │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │
                              ┌────────────────────▼────────────────┐
                              │     .agentfoundry/skills/           │
                              │  ├── project-api-auth.skill.md      │
                              │  ├── debug-patterns.skill.md        │
                              │  └── code-conventions.skill.md      │
                              └─────────────────────────────────────┘
```

### 3.2 Components

| Component | Purpose |
|-----------|---------|
| `resourceful-philosophy-skill` | Core behavioral guidance for proactive problem-solving |
| `ExternalSkillLoader` | Loads skills from `SKILL.md` files |
| `skill-create` tool | Allows agents to generate new skills |
| `SkillObservability` | Emits skill creation/load/usage/token-saving logs in non-debug mode |
| File watcher | Enables hot-reload when skill files change |

### 3.3 Unified Format, Split Source

We **standardize on a single SKILL.md format**, but **do not** unify sources:

- **Framework skills**: stored as SKILL.md content embedded in code (or bundled assets).
  - Pros: stable, versioned, testable, always available.
- **External skills**: loaded from `.agentfoundry/skills/*.skill.md`.
  - Pros: hot-reload, project-local, user-editable.

**Why this split?**
- Keeps parsing and authoring consistent (one format).
- Preserves reliability for core skills.
- Keeps external skills flexible and replaceable.

**Built-in Packaging Choice (Framework Skills)**:
- **Use embedded string constants** for built-in SKILL.md content.
- Rationale: zero runtime filesystem dependency, stable and testable.

---

## 4. Detailed Design

### 4.1 Resourceful Philosophy Skill

**Format**: SKILL.md (embedded/bundled).

**Location**: `src/skills/builtin/resourceful-philosophy-skill.ts`

```typescript
export const resourcefulPhilosophySkill = defineSkill({
  id: 'resourceful-philosophy',
  name: 'Resourceful Before Asking',
  shortDescription: 'Problem-solving philosophy: be resourceful before asking for help',

  instructions: {
    summary: `Core Philosophy: Be Resourceful Before Asking
- Attempt to solve problems independently first
- Explore available tools, files, and documentation
- Try at least 2-3 approaches before asking
- Document your reasoning and attempts`,

    procedures: `
## Problem-Solving Workflow

1. **Understand First**: Read related files, check documentation
2. **Explore Tools**: List available tools, understand capabilities
3. **Try Approaches**: Attempt 2-3 different solutions
4. **Document Attempts**: Track what you tried and why it failed
5. **Ask With Context**: If stuck, explain attempts made
6. **Suggest Solutions**: Propose what additional capabilities would help

## When to Ask
- After exhausting reasonable approaches
- When blocked by permissions/capabilities
- When human judgment is genuinely needed
- NOT for information you could find yourself`,

    examples: `
## Good: Resourceful Approach
Problem: "Find all TODO comments"
1. Try: glob("**/*.ts") + grep("TODO")
2. If fails: Try different patterns
3. Result: Report findings with count

## Bad: Asking First
"How do I find TODO comments?"
→ Should try tools first!

## Good: Asking With Context
"I tried glob + grep for TODOs, found 47. But some
are in node_modules. How should I filter those?"
→ Shows attempt + specific question`,

    troubleshooting: `
## "Stuck in exploration loop"
- Set limit: max 3 attempts per sub-problem
- After limit: summarize attempts and ask

## "Over-engineering simple tasks"
- Start with simplest approach
- Add complexity only if simple fails`
  },

  tools: [],  // Always loaded, not tool-triggered
  loadingStrategy: 'eager',
  tags: ['philosophy', 'core', 'problem-solving']
})
```

**Key Design Decisions**:

1. **Eager Loading**: Always present in system prompt (not lazy)
2. **Tool-Independent**: Not triggered by specific tools
3. **Protected Section**: Won't be truncated for token budget
4. **In Safe Pack**: All agents get this by default

### 4.2 External Skill File Format (SKILL.md)

**Path**: `.agentfoundry/skills/<skill-id>.skill.md`

**Filename Canonicalization**:
- Canonical extension is `.skill.md` (lowercase).
- Loader should accept case-insensitive matches for compatibility.

**Format**: Markdown + YAML frontmatter (OpenClaw-compatible).

```markdown
---
id: project-api-patterns
name: Project API Patterns
shortDescription: API conventions discovered in this project
loadingStrategy: lazy
tools: [fetch, read]
tags: [api, project-specific]
meta:
  createdBy: agent
  createdAt: 2025-02-05T10:30:00Z
  sessionId: session-abc123
  version: 1
  approvedByUser: false
---

# Summary
Brief overview (~100 tokens).

## Procedures
Detailed step-by-step guide.

## Examples
Usage examples with code.

## Troubleshooting
Common issues and solutions.
```

**Tolerant Parsing Rules**:
- Frontmatter `id`, `name`, `shortDescription` are required.
- `Summary` is required but can be inferred.
- If `# Summary` section is missing, use the first non-empty paragraph.
- If no paragraph exists, skip this skill and log a validation error.
- `Procedures`, `Examples`, `Troubleshooting` are optional.
- Unknown sections are appended to `procedures` to avoid data loss.
- Extra headings are preserved in section bodies.
 - Section alias matching should be conservative (exact or short-heading match), to avoid accidentally treating "Steps to reproduce" as `procedures`.

**Parsing Algorithm (pseudocode)**:
```text
1) Parse YAML frontmatter.
2) If id/name/shortDescription missing → invalid.
3) Parse markdown into heading blocks.
4) Identify sections by heading text (case-insensitive):
   - Summary / Overview / TL;DR → summary
   - Procedures / Procedure / Workflow → procedures
   - Examples / Example / Usage → examples
   - Troubleshooting / FAQ → troubleshooting
   - If heading is longer than 3 words, do NOT treat it as an alias match.
5) If summary not found:
   - Use first non-empty paragraph in body as summary.
6) Collect unknown sections:
   - Append to procedures with their original headings.
7) Trim all sections.
8) If summary empty after fallback → invalid.
```

**Examples (Parsing)**:
- *Missing Summary heading*:
  ```
  ---
  id: example-skill
  name: Example
  shortDescription: Demo
  ---
  This first paragraph becomes the summary.
  ## Procedures
  Steps...
  ```
- *Unknown section preserved*:
  ```
  ## Notes
  Keep this detail...
  ```
  → Appended to `procedures` so content isn’t lost.

### 4.2.1 Approval & Loading Semantics

**What is an “unapproved skill”?**
- Any external skill file where `meta.approvedByUser === false`.
- This can include third-party or manually added skills.
- **Agent-created skills default to `approvedByUser: true`** (we trust LLM output by default).

**Unapproved Skills** (`meta.approvedByUser === false`):
- Skills are registered for discovery but are **not injected** into the system prompt.
- They are **never auto-loaded** (no eager/lazy).
- `loadOnDemand` must **refuse** to load unapproved skills.
- Only `skill-approve` can activate them.

**Lazy Semantics (default for agent-created skills)**:
- `loadingStrategy: 'lazy'` means summary is available immediately, full content loads on first matching tool usage.
- Trigger path: `onToolUsed(toolName)` → match `skill.tools[]` → `loadFully(skillId)`.
- `skill-create` should ensure lazy skills have non-empty `tools[]` (provided or inferred from recent successful tool calls).

**On-Demand Semantics**:
- `loadingStrategy: 'on-demand'` means **explicit load only**.
- The only valid trigger is `skillManager.loadOnDemand(skillId)` (or `skill-approve`).
- Tool usage never triggers on-demand loading.
- Use this only for highly specialized skills that should not auto-activate.

**Examples**:
- *Agent-created skill*: `approvedByUser: true`, `loadingStrategy: lazy`.
  - `skill-create` writes the file, registers it, and binds trigger tools.
  - Full content loads automatically the first time a bound tool is used.
- *Third-party skill*: `approvedByUser: false`, `loadingStrategy: lazy`.
  - It is discoverable but will **not** load until `skill-approve` is called.

### 4.3 External Skill Loader

**Location**: `src/skills/external-skill-loader.ts`

```typescript
export interface ExternalSkillLoaderOptions {
  skillsDir: string           // e.g., '.agentfoundry/skills'
  watchForChanges?: boolean   // Enable hot-reload
  onSkillLoaded?: (skill: Skill) => void
  onSkillRemoved?: (skillId: string) => void
  onError?: (error: Error, path: string) => void
}

export class ExternalSkillLoader {
  /** Load all .skill.md files from directory (case-insensitive match) */
  async loadAll(): Promise<Skill[]>

  /** Load single skill from file */
  async loadSkillFile(filePath: string): Promise<Skill | null>

  /** Start watching for file changes */
  startWatching(): void

  /** Stop watching */
  stopWatching(): void

  /** Get currently loaded skills */
  getLoadedSkills(): Skill[]
}
```

**Behavior**:

1. **Initial Load**: Scans directory for `**/*.skill.md` (case-insensitive)
2. **Validation**: All skills pass through `validateSkillConfig()`
3. **Hot-Reload**: File watcher detects add/modify/delete
4. **Error Handling**: Invalid files logged, don't crash agent

**ID Collision Rule**:
- External skills must **not override** built-in skills.
- If a collision is detected, the loader skips the file and logs an error.

**Example (Collision)**:
- Built-in: `llm-compute-skill`
- External file attempts `id: llm-compute-skill`
→ Loader rejects, logs: `Skill id collision with built-in: llm-compute-skill`

### 4.4 SkillManager Extensions

**Location**: `src/skills/skill-manager.ts`

New options:

```typescript
export interface SkillManagerOptions {
  // Existing
  debug?: boolean
  skillTTL?: number
  maxFullyLoadedSkills?: number

  // NEW
  externalSkillsDir?: string    // Path to .agentfoundry/skills
  watchExternalSkills?: boolean // Enable hot-reload (default: true)
  skillTelemetry?: {
    enabled?: boolean           // default: true
    mode?: 'basic' | 'verbose' | 'off' // default: 'basic'
    sink?: 'console' | 'trace' | 'both' // default: 'both'
  }
}
```

New methods:

```typescript
class SkillManager {
  /** Load external skills from configured directory */
  async loadExternalSkills(): Promise<number>

  /** Unregister a skill (for hot-reload removal) */
  unregister(skillId: string): boolean

  /** Check if skill exists */
  has(skillId: string): boolean
}
```

### 4.5 Skill Creation Tool

**Location**: `src/tools/skill-create.ts`

```typescript
export const skillCreateTool = defineTool({
  name: 'skill-create',
  description: `Create a new reusable skill from discovered knowledge.

Use this when you've figured out something valuable that should be remembered:
- Project-specific patterns or conventions
- API usage guides you've worked out
- Debugging techniques that worked
- Configuration recipes

The skill will be saved to .agentfoundry/skills/ and lazily loaded on matching tool usage.`,

  parameters: {
    id: { type: 'string', required: true,
          description: 'Unique skill ID (kebab-case)' },
    name: { type: 'string', required: true },
    shortDescription: { type: 'string', required: true },
    summary: { type: 'string', required: true,
               description: 'Concise overview (~100 tokens)' },
    procedures: { type: 'string', required: false },
    examples: { type: 'string', required: false },
    troubleshooting: { type: 'string', required: false },
    tools: { type: 'array', required: false,
             description: 'Tools that trigger this skill' },
    tags: { type: 'array', required: false }
  },

  execute: async (input, context) => {
    // 1. Validate ID format
    // 1.1 Reject if ID collides with built-in or existing registered skill
    // 2. Build SKILL.md with meta.approvedByUser = true (trusted by default)
    // 3. Default loadingStrategy = 'lazy'
    // 4. Ensure tools[] is non-empty:
    //    - use input.tools if provided
    //    - else infer from recent successful tool calls in current run
    //    - if still empty, return validation error (require explicit tools)
    // 5. Write to .agentfoundry/skills/{id}.skill.md
    // 6. Register with SkillManager (if not hot-reloaded)
    // 7. Emit skill.created telemetry event (strategy/tools/path)
    // 8. Return success with file path
  }
})
```

**Output Example**:
```json
{
  "success": true,
  "data": {
    "skillId": "project-api-auth",
    "filePath": ".agentfoundry/skills/project-api-auth.skill.md",
    "message": "Skill \"Project API Auth\" created and registered (lazy)."
  }
}
```

### 4.6 Skill Approval Tool

**Location**: `src/tools/skill-approve.ts`

```typescript
export const skillApproveTool = defineTool({
  name: 'skill-approve',
  description: 'Approve a skill for regular use (sets meta.approvedByUser=true).',
  parameters: {
    id: { type: 'string', required: true, description: 'Skill ID to approve' },
    setLoadingStrategy: { type: 'string', required: false, description: 'Optional: eager | lazy | on-demand' }
  },
  execute: async (input, context) => {
    // 1. Locate .agentfoundry/skills/{id}.skill.md
    // 2. Update frontmatter meta.approvedByUser = true
    // 3. Optionally update loadingStrategy if provided
    // 4. Write file back (preserve body)
    // 5. Trigger reload (or direct register)
  }
})
```

### 4.7 Integration into Safe Pack

**Location**: `src/packs/safe.ts`

```typescript
export const safePack = definePack({
  id: 'safe',
  name: 'Safe Pack',
  description: 'Safe tools for reading, writing, and learning',

  tools: [
    // Existing
    readTool, writeTool, editTool, globTool, grepTool, ctxGetTool,
    // NEW
    skillCreateTool,
    skillApproveTool
  ],

  skills: [
    contextRetrievalSkill,
    resourcefulPhilosophySkill  // NEW (default on, user can disable)
  ],

  skillLoadingConfig: {
    eager: ['resourceful-philosophy'],  // Always loaded
    lazy: ['context-retrieval-skill']
  }
})
```

**Implementation Note**:
- In `create-agent.ts` / `define-agent.ts`, if `disableResourcefulSkill === true`,
  skip registering `resourceful-philosophy` (or unregister after pack load).

### 4.8 Skill Observability (Non-Debug Default)

**Goal**:
- Make dynamic skill behavior auditable in normal runs (not only `debug: true`).
- Allow users to verify that lazy loading and token optimization are actually working.

**Principles**:
1. **Always-on basic telemetry** by default (`skillTelemetry.enabled = true`, `mode = basic`).
2. **Debug mode is additive**: debug includes more detail but does not gate core skill logs.
3. **Structured events first**: emit machine-readable events to trace; console output is concise.

**Required Events** (basic mode):
- `skill.created` (id, loadingStrategy, tools, filePath, approvedByUser)
- `skill.registered` (id, strategy, summaryTokens, fullTokens)
- `skill.loaded.summary` (id, reason: register|reload)
- `skill.loaded.full` (id, strategy, trigger: tool|on-demand|eager, triggerTool?)
- `skill.hot_reloaded` (id, action: add|modify|remove)
- `skill.load_blocked` (id, reason: unapproved|invalid|collision|missing)
- `skill.token_savings` (runId/sessionId, summaryOnlyTokens, fullLoadedTokens, estimatedSavedTokens)

**Console Output** (basic mode, concise):
- At most one line per key transition.
- Example:
  - `[skill] created id=project-api-auth strategy=lazy tools=fetch,read approved=true`
  - `[skill] lazy-load id=project-api-auth trigger=fetch tokens=+620`
  - `[skill] token-savings run=abc saved=~1180 (summary=140 full=1320)`

**Acceptance Criteria**:
1. In non-debug mode, user can observe skill create/register/lazy-load events.
2. Token-saving summary is emitted at least once per `agent.run()`.
3. Approval-related load blocks are visible without enabling debug.
4. Debug mode may add stack traces and verbose internals but not replace basic logs.

---

## 5. Directory Structure

```
project/
├── .agentfoundry/
│   ├── skills/                          # External skills
│   │   ├── project-api-auth.skill.md
│   │   ├── debug-memory-leaks.skill.md
│   │   └── code-conventions.skill.md
│   ├── memory/                          # Existing KV memory
│   │   ├── items.json
│   │   └── index.json
│   └── config.json                      # Future: local config
└── src/
    └── ...
```

---

## 6. Implementation Plan

### Phase 1: Resourceful Philosophy Skill
1. Create `src/skills/builtin/resourceful-philosophy-skill.ts`
2. Export from `src/skills/builtin/index.ts`
3. Add to `safe` pack with `eager` loading

**Deliverable**: All agents behave more proactively

### Phase 2: External Skill Loader
1. Create `src/skills/external-skill-loader.ts`
2. Implement SKILL.md parsing + tolerant section extraction
3. Implement file watching

**Deliverable**: Can load skills from `SKILL.md` files

### Phase 3: SkillManager Integration
1. Add `externalSkillsDir` and `watchExternalSkills` options
2. Implement `loadExternalSkills()` method
3. Implement `unregister()` for hot-reload

**Deliverable**: SkillManager supports external skills

### Phase 4: Agent Integration
1. Add config options to `AgentConfig`
2. Auto-load external skills on agent init
3. Enable watching by default

**Deliverable**: Agents auto-load external skills

### Phase 5: Skill Creation Tool
1. Create `src/tools/skill-create.ts`
2. Add to `safe` pack
3. Export from `src/index.ts`
4. Default to lazy with meta.approvedByUser=true
5. Ensure non-empty trigger tools (input or inference from recent tool usage)
6. Emit `skill.created` telemetry event

**Deliverable**: Agents can create new skills

### Phase 6: Skill Approval Tool
1. Create `src/tools/skill-approve.ts`
2. Add to `safe` pack
3. Export from `src/index.ts`
4. Preserve SKILL.md body while updating frontmatter

**Deliverable**: Users can approve skills for regular use

### Phase 7: Observability & Telemetry
1. Add `skillTelemetry` config plumbing (AgentConfig + SkillManager)
2. Emit required lifecycle events in non-debug mode
3. Add per-run token-saving summary logs

**Deliverable**: Dynamic skill behavior is observable without debug mode

### Phase 8: Testing & Documentation
1. Unit tests for ExternalSkillLoader
2. Integration tests for hot-reload
3. Integration tests for lazy-triggered loading + telemetry output
4. Update `docs/SKILLS.md`

---

## 7. Security Considerations

| Risk | Mitigation |
|------|------------|
| Code injection via skill files | Skills are Markdown data, not executable code |
| Malicious skill content | Skill instructions are just LLM context, not executed |
| Path traversal | Only loads from `.agentfoundry/skills/` |
| Resource exhaustion | Token budget limits skill content size |
| Sensitive data in skills | Skills should not contain secrets (documented) |

### What Skills Can Do
- Provide instructions/guidance to the LLM
- Be loaded/unloaded based on tool usage
- Be searched via SkillRegistry

### What Skills Cannot Do
- Execute arbitrary code
- Access files outside skill content
- Modify agent configuration
- Bypass policy engine

---

## 8. API Changes

### New Types

```typescript
// src/types/agent.ts
export interface AgentConfig {
  // Existing...

  /** Directory for external skills (default: '.agentfoundry/skills') */
  externalSkillsDir?: string

  /** Watch for skill file changes (default: true) */
  watchExternalSkills?: boolean

  /** Disable resourceful philosophy skill (default: false) */
  disableResourcefulSkill?: boolean

  /** Skill lifecycle observability settings */
  skillTelemetry?: {
    enabled?: boolean                  // default: true
    mode?: 'basic' | 'verbose' | 'off' // default: 'basic'
    sink?: 'console' | 'trace' | 'both' // default: 'both'
  }
}
```

### New Exports

```typescript
// src/index.ts
export { ExternalSkillLoader } from './skills/external-skill-loader.js'
export { resourcefulPhilosophySkill } from './skills/builtin/resourceful-philosophy-skill.js'
export { skillCreateTool } from './tools/skill-create.js'
export { skillApproveTool } from './tools/skill-approve.js'
```

---

## 9. Backwards Compatibility

- **Fully backwards compatible**: All changes are additive
- Existing agents work unchanged
- New features are opt-out, not opt-in
- No breaking changes to existing APIs

---

## 10. Alternatives Considered

### Alternative 1: TypeScript Skill Files
**Rejected**: Requires compilation, harder for agents to generate

### Alternative 2: Skill Creation as Command (not Tool)
**Rejected**: Tools are the agent's native interface for actions

### Alternative 3: Separate Learning Pack
**Rejected**: Philosophy should be core to all agents

### Alternative 4: SKILL.md Only (Markdown + Frontmatter)
**Chosen**: Compatible with external ecosystems and human-editable

---

## 11. Open Questions

1. **Skill Versioning**: Should we support multiple versions of the same skill?
2. **Skill Sharing**: Should there be a mechanism to share skills across projects?
3. **Skill Validation**: Should we validate tool names in skill.tools[]?
4. **Skill Limits**: Should there be a max number of external skills?
5. **Telemetry Export**: Should skill telemetry integrate with external metrics/log pipelines?

---

## 12. Future Enhancements

1. **Skill Marketplace**: Share skills via ClawHub-like registry
2. **Skill Templates**: Pre-built templates for common patterns
3. **Skill Dependencies**: Skills can reference other skills
4. **Skill Testing**: Validate skill effectiveness with test cases
5. **Skill Analytics**: Track which skills are most used/useful

---

## 13. References

- [OpenClaw SOUL.md Design](https://docs.openclaw.ai/reference/templates/SOUL)
- [OpenClaw Identity Architecture](https://www.mmntm.net/articles/openclaw-identity-architecture)
- [RFC-001 Skills System](./RFC-001-SKILLS.md) (if exists)
