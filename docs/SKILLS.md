# Skills System

Skills are **lazily-loaded procedural knowledge** that help LLMs use tools effectively. Unlike tools (which execute operations), skills provide guidance, examples, and best practices that can be loaded on-demand to optimize token usage.

## Key Concepts

### Tools vs Skills vs Packs

| Concept | Purpose | Loading | Example |
|---------|---------|---------|---------|
| **Tool** | Execute operations | Always loaded (schema) | `read`, `write`, `bash` |
| **Skill** | Provide guidance | Lazy/on-demand | `llm-compute-skill`, `git-workflow-skill` |
| **Pack** | Bundle capabilities | At initialization | `safe()`, `compute()`, `exec()` |

### Why Skills?

**Problem**: Traditional approaches embed procedural knowledge in:
- Tool descriptions (~50-100 tokens each)
- Pack `promptFragment` fields (~200-500 tokens each)
- System prompts (always loaded)

This leads to **token waste** when capabilities aren't used.

**Solution**: Skills provide **progressive disclosure**:
1. **Summary** (~50-100 tokens): Always loaded, enables skill discovery
2. **Full content** (~500-1500 tokens): Loaded only when needed

### Token Savings

| Scenario | Without Skills | With Skills | Savings |
|----------|---------------|-------------|---------|
| Simple file operations | ~2000 tokens | ~800 tokens | 60% |
| Complex research workflow | ~7000 tokens | ~500 tokens (initial) | 93% |
| After using all skills | ~7000 tokens | ~4000 tokens | 43% |

## Quick Start

### Defining a Skill

```typescript
import { defineSkill } from 'agent-foundry'

const mySkill = defineSkill({
  id: 'my-skill',
  name: 'My Skill',
  shortDescription: 'Brief description for matching (<100 chars)',

  instructions: {
    summary: 'Concise overview (~100 tokens)',
    procedures: 'Detailed step-by-step guide (~500 tokens)',
    examples: 'Usage examples with code (~300 tokens)',
    troubleshooting: 'Common issues and solutions'
  },

  tools: ['tool-a', 'tool-b'],  // Associated tools
  loadingStrategy: 'lazy',       // 'eager' | 'lazy' | 'on-demand'
  tags: ['category1', 'category2']
})
```

### Using SkillManager

```typescript
import { SkillManager, llmComputeSkill, gitWorkflowSkill } from 'agent-foundry'

const manager = new SkillManager({ debug: true })

// Register skills
manager.register(llmComputeSkill)
manager.register(gitWorkflowSkill)

// Skills auto-load when associated tools are used
manager.onToolUsed('llm-call')  // Triggers llm-compute-skill loading

// Or load explicitly
manager.loadFully('git-workflow-skill')

// Get content for prompt compilation
const sections = manager.getPromptSections()
```

### Using SkillRegistry for Discovery

```typescript
import { SkillRegistry } from 'agent-foundry'

const registry = new SkillRegistry()
registry.registerAll([skill1, skill2, skill3])

// Query skills
const matches = registry.findMatches({
  tools: ['llm-call'],
  tags: ['compute'],
  search: 'text processing'
})

// Get recommendations
const recommended = registry.recommend({
  tools: ['bash', 'git'],
  maxResults: 3
})
```

## Loading Strategies

### eager
- Loaded immediately at registration
- Full content always in prompt
- Use for critical, always-needed skills

```typescript
defineSkill({
  // ...
  loadingStrategy: 'eager'
})
```

### lazy (default)
- Summary loaded at registration
- Full content loaded on first tool use
- Best for most skills

```typescript
defineSkill({
  // ...
  loadingStrategy: 'lazy',
  tools: ['associated-tool']  // Triggers loading when this tool is used
})
```

### on-demand
- Summary loaded at registration
- Full content only via explicit `loadOnDemand()` call
- Use for specialized, rarely-needed skills

```typescript
defineSkill({
  // ...
  loadingStrategy: 'on-demand'
})

// Later, when explicitly needed
manager.loadOnDemand('specialized-skill')
```

## Built-in Skills

### Framework Core (`src/skills/builtin/`)

| Skill | Description | Tools |
|-------|-------------|-------|
| `llm-compute-skill` | LLM sub-computations (call, expand, filter) | llm-call, llm-expand, llm-filter |
| `git-workflow-skill` | Git operations and best practices | bash |
| `context-retrieval-skill` | Context source usage guide | ctx-get |

### App-Specific Skills

#### research-pilot (`examples/research-pilot/skills/`)

| Skill | Description | Token Savings |
|-------|-------------|---------------|
| `academic-writing-skill` | Research paper outlining and drafting | 89% initial |
| `literature-skill` | Paper discovery, scoring, synthesis | 97% initial |
| `data-analysis-skill` | Python data analysis and visualization | 96% initial |

#### personal-assistant (`examples/personal-assistant/src/skills/`)

| Skill | Description | Token Savings |
|-------|-------------|---------------|
| `gmail-skill` | Email operations via SQLite + Gmail API | 88% initial |
| `calendar-skill` | macOS Calendar queries via icalBuddy | 72% initial |

## Skill Structure Best Practices

### Instructions

```typescript
instructions: {
  // Always loaded - keep concise
  summary: `
Brief overview of what the skill enables.
List key capabilities in 2-3 bullet points.
  `,

  // Loaded on first use - detailed guidance
  procedures: `
## Section 1
Step-by-step instructions...

## Section 2
More detailed procedures...
  `,

  // Loaded on first use - concrete examples
  examples: `
## Example 1: Basic Usage
\`\`\`json
{ "tool": "...", "input": {...} }
\`\`\`

## Example 2: Advanced Usage
...
  `,

  // Loaded on first use - problem solving
  troubleshooting: `
## Common Issues

### "Error message X"
- Cause: ...
- Fix: ...
  `
}
```

### Token Estimation

Provide estimates for budget planning:

```typescript
estimatedTokens: {
  summary: 80,    // Tokens for summary section
  full: 600       // Tokens for all sections combined
}
```

The framework auto-calculates if not provided (~4 chars per token).

### Tool Association

Associate skills with tools for automatic lazy loading:

```typescript
// Single tool
tools: ['my-tool']

// Multiple tools - skill loads when ANY is used
tools: ['tool-a', 'tool-b', 'tool-c']
```

### Tags for Discovery

Use consistent tags for skill discovery:

```typescript
tags: ['writing', 'academic', 'research']  // Domain
tags: ['python', 'data', 'visualization']  // Technology
tags: ['email', 'communication']           // Function
```

## Integrating with Packs

Packs can include skills alongside tools and policies:

```typescript
import { definePack } from 'agent-foundry'
import { mySkill } from './skills/my-skill'

export function myPack(): Pack {
  return definePack({
    id: 'my-pack',
    description: 'My capability pack',

    tools: [myTool],
    policies: [myPolicy],
    skills: [mySkill],

    skillLoadingConfig: {
      eager: [],              // Always load these
      lazy: ['my-skill'],     // Load on tool use
      onDemand: []            // Load only when explicit
    }
  })
}
```

### Migration from promptFragment

**Before** (always loaded):
```typescript
definePack({
  // ...
  promptFragment: `
## My Guide
Detailed instructions here...
500+ tokens always in prompt
  `
})
```

**After** (lazy loaded):
```typescript
definePack({
  // ...
  skills: [mySkill],
  skillLoadingConfig: { lazy: ['my-skill'] }
  // promptFragment removed - content moved to skill
})
```

## API Reference

### defineSkill(config)

Creates a validated Skill instance.

```typescript
function defineSkill<TInput, TOutput>(
  config: SkillConfig<TInput, TOutput>
): Skill<TInput, TOutput>
```

### extendSkill(base, extension)

Extends an existing skill with modifications.

```typescript
const extended = extendSkill(baseSkill, {
  id: 'extended-skill',
  instructions: {
    examples: 'Additional examples...'
  }
})
```

### mergeSkills(id, name, skills)

Combines multiple skills into one.

```typescript
const combined = mergeSkills(
  'combined-skill',
  'Combined Skill',
  [skillA, skillB, skillC]
)
```

### SkillManager

Manages skill lifecycle and loading.

```typescript
class SkillManager {
  register(skill: Skill): void
  registerAll(skills: Skill[]): void
  get(skillId: string): Skill | undefined
  getAll(): Skill[]

  // Loading
  loadFully(skillId: string): string | undefined
  loadOnDemand(skillId: string): string | undefined
  onToolUsed(toolName: string): void

  // Content
  getContent(skillId: string): string | undefined
  getState(skillId: string): SkillState | undefined
  getPromptSections(): Array<{ id: string; content: string; protected: boolean }>

  // Management
  downgrade(skillId: string): void
  unload(skillId: string): void
  reset(): void
  cleanup(): void

  // Stats
  getTokenUsage(): { current: number; maxPotential: number }
  getStats(): SkillManagerStats
}
```

### SkillRegistry

Provides skill discovery and querying.

```typescript
class SkillRegistry {
  register(skill: Skill): void
  registerAll(skills: Skill[]): void
  get(skillId: string): Skill | undefined
  has(skillId: string): boolean

  // Queries
  getByTool(toolName: string): Skill[]
  getByTag(tag: string): Skill[]
  getByStrategy(strategy: SkillLoadingStrategy): Skill[]
  query(options: SkillQuery): Skill[]
  findMatches(options: SkillQuery): SkillMatch[]
  recommend(context: RecommendContext): Skill[]

  // Metadata
  getAllTags(): string[]
  getAllTools(): string[]
  getStats(): SkillRegistryStats
}
```

## Creating App-Specific Skills

### Directory Structure

```
examples/my-app/
├── src/
│   ├── skills/
│   │   ├── my-domain-skill.ts
│   │   ├── another-skill.ts
│   │   └── index.ts
│   └── agent/
│       └── coordinator.ts
```

### Skill Definition Template

```typescript
// my-domain-skill.ts
import { defineSkill } from 'agent-foundry'
import type { Skill } from 'agent-foundry'

export const myDomainSkill: Skill = defineSkill({
  id: 'my-domain-skill',
  name: 'My Domain',
  shortDescription: 'Domain-specific operations and best practices',

  instructions: {
    summary: `...`,
    procedures: `...`,
    examples: `...`,
    troubleshooting: `...`
  },

  tools: ['domain-tool-1', 'domain-tool-2'],
  loadingStrategy: 'lazy',
  estimatedTokens: { summary: 80, full: 600 },
  tags: ['my-domain', 'category']
})

export default myDomainSkill
```

### Index Export

```typescript
// index.ts
export { myDomainSkill } from './my-domain-skill.js'
export { anotherSkill } from './another-skill.js'

import { myDomainSkill } from './my-domain-skill.js'
import { anotherSkill } from './another-skill.js'

export const appSkills = [myDomainSkill, anotherSkill]

export const skillsById = {
  'my-domain-skill': myDomainSkill,
  'another-skill': anotherSkill
} as const
```

## Testing Skills

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { SkillManager } from 'agent-foundry'
import { mySkill } from './my-skill'

describe('mySkill', () => {
  let manager: SkillManager

  beforeEach(() => {
    manager = new SkillManager()
  })

  it('should have correct structure', () => {
    expect(mySkill.id).toBe('my-skill')
    expect(mySkill.loadingStrategy).toBe('lazy')
    expect(mySkill.tools).toContain('expected-tool')
  })

  it('should start with summary-loaded state', () => {
    manager.register(mySkill)
    expect(manager.getState('my-skill')).toBe('summary-loaded')
  })

  it('should load fully when tool is used', () => {
    manager.register(mySkill)
    manager.onToolUsed('expected-tool')
    expect(manager.getState('my-skill')).toBe('fully-loaded')
  })

  it('should demonstrate token savings', () => {
    manager.register(mySkill)
    const usage = manager.getTokenUsage()
    const savings = mySkill.estimatedTokens.full - usage.current
    expect(savings).toBeGreaterThan(0)
  })
})
```
