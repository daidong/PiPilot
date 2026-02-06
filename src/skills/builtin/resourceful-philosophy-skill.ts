/**
 * resourceful-philosophy-skill
 *
 * Core behavior guidance: be resourceful before asking.
 * This skill is intended to be eagerly loaded.
 */

import type { Skill } from '../../types/skill.js'
import { defineSkill } from '../define-skill.js'

export const resourcefulPhilosophySkill: Skill = defineSkill({
  id: 'resourceful-philosophy',
  name: 'Resourceful Before Asking',
  shortDescription: 'Core problem-solving workflow: try reasonable paths before asking for help',
  instructions: {
    summary: `Core philosophy:
- Try to solve the problem independently first.
- Explore files, tools, and available context before escalating.
- If blocked, report attempted approaches and concrete blockers.`,
    procedures: `## Problem-Solving Workflow
1. Understand first: read relevant files and docs.
2. Explore tools: check available capabilities.
3. Try 2-3 approaches: start simple, escalate complexity only if needed.
4. Track attempts: what was tried and why it failed.
5. Ask with context: include attempts and blockers.
6. Suggest next capability: explain what would unblock progress.

## When To Ask
- After exhausting reasonable approaches.
- When blocked by permissions or missing capabilities.
- When genuine human judgment is required.
- Not for information that can be directly retrieved.`,
    examples: `## Good
Task: find TODO comments.
1. Use glob to find target files.
2. Use grep to locate TODO.
3. Return concise findings and counts.

## Bad
"How do I find TODO?"
The agent should try directly first.

## Good Escalation
"I searched and found TODOs in source + vendored files. I can filter vendored paths. Do you want source-only results?"`,
    troubleshooting: `## Stuck In Exploration Loop
- Limit to 3 attempts per sub-problem, then summarize and ask.

## Over-Engineering
- Prefer the simplest approach first; add complexity only when needed.`
  },
  tools: [],
  loadingStrategy: 'eager',
  tags: ['philosophy', 'core', 'problem-solving']
})
