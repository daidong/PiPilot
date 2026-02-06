# RFC-001: Writing Support via Skills

**Status**: Implemented (Skills Migration)
**Author**: Captain
**Date**: 2026-02-02
**Updated**: 2026-02-05

## 1. Motivation

Today the coordinator agent handles paper drafting inline using its general system prompt.
While writing principles have been added to that prompt (Section 8), this approach has limits:

1. The coordinator's context window is already dense with tool rules, intent gating, and
   entity management. Writing instructions compete for attention with operational concerns.
2. Writing-specific knowledge (~750 tokens) was always loaded even when not needed.
3. Paper writing benefits from focused procedural knowledge that can be loaded on-demand.

## 2. Solution: Skills-Based Approach

### 2.1 Migration Completed

The original RFC proposed dedicated `writingOutliner` and `writingDrafter` SimpleAgents.
This has been **superseded** by the Skills architecture:

| Original Proposal | Implemented Solution |
|-------------------|---------------------|
| `writingOutliner` SimpleAgent | `academicWritingSkill` (lazy-loaded) |
| `writingDrafter` SimpleAgent | `academicWritingSkill` (lazy-loaded) |
| `writing-agent.ts` | **Deleted** (redundant) |

### 2.2 How It Works Now

1. **Coordinator** registers `academicWritingSkill` via SkillManager
2. When user requests writing tasks, the skill is **lazy-loaded**
3. Skill content provides the same procedural knowledge:
   - Narrative over enumeration philosophy
   - Outline creation with narrative arc
   - Draft writing with citation integration
   - Style guidelines

### 2.3 Token Savings

| Before (SimpleAgents) | After (Skills) | Savings |
|-----------------------|----------------|---------|
| ~750 tokens always loaded | ~80 tokens initially | 89% |
| Full content every request | Full content on first use | - |

## 3. Writing Principles (In academicWritingSkill)

The skill carries these principles in its `instructions.procedures`:

- Narrative over enumeration: tell a story, not a bullet list.
- Every sentence earns its place.
- Formal but accessible: precision without jargon.
- Direct, confident claims.
- No dashes as structural elements.
- Citation integration: [Author, Year] woven into narrative.

## 4. Usage

```typescript
import { academicWritingSkill } from './skills/index.js'
import { SkillManager } from 'agent-foundry'

// Register skill
const skillManager = new SkillManager()
skillManager.register(academicWritingSkill)

// Skill loads automatically when associated tools are used
// Or load explicitly when writing intent is detected:
skillManager.loadFully('academic-writing-skill')

// Get content for prompt compilation
const sections = skillManager.getPromptSections()
```

## 5. Future Enhancements

If dedicated writing tools are needed (e.g., for structured JSON output):

1. Create `writing-outline` and `writing-draft` as **simple tools** (not agents)
2. Tools would produce structured JSON output
3. Coordinator uses `academicWritingSkill` for guidance, tools for execution

This maintains the token-efficient Skills architecture while adding
structured output capabilities if needed.

## 6. Related Files

- `examples/research-pilot/skills/academic-writing-skill.ts` - The skill definition
- `examples/research-pilot/skills/index.ts` - Skill exports
- `src/skills/skill-manager.ts` - Lazy loading infrastructure

## 7. Recommended `kernelV2` Runtime Config

For `createAgent(...)`, use this baseline configuration:

```ts
kernelV2: {
  enabled: true,
  migration: {
    autoFromV1: true
  },
  storage: {
    integrity: {
      verifyOnStartup: true
    },
    recovery: {
      autoTruncateToLastValidRecord: true,
      createRecoverySnapshot: true
    }
  },
  lifecycle: {
    autoWeekly: true
  },
  telemetry: {
    baselineAlwaysOn: true,
    mode: 'stderr+file',
    filePath: '.agent-foundry-v2/logs/kernel-v2.log'
  }
}
```

This locks in the five agreed defaults:
- V2 enabled by default
- automatic one-time migration from V1
- automatic corruption recovery on startup
- weekly lifecycle maintenance
- telemetry to both stderr and log file
