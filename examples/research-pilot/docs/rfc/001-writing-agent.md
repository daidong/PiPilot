# RFC-001: Dedicated Writing Agent Pipeline

**Status**: Draft
**Author**: Captain
**Date**: 2026-02-02

## 1. Motivation

Today the coordinator agent handles paper drafting inline using its general system prompt.
While writing principles have been added to that prompt (Section 8), this approach has limits:

1. The coordinator's context window is already dense with tool rules, intent gating, and
   entity management. Writing instructions compete for attention with operational concerns.
2. A dedicated `writingOutliner` and `writingDrafter` already exist in `writing-agent.ts`
   but are not wired into the coordinator. They sit unused.
3. Paper writing benefits from a focused, multi-turn workflow (outline → draft → revise)
   that the coordinator's single-shot tool loop is not designed for.

The goal is to make the writing sub-agents first-class participants in the coordinator's
workflow so that paper drafting follows a structured, high-quality pipeline.

## 2. Design Overview

### 2.1 New Coordinator Tools

Expose two new tools to the coordinator:

| Tool | Delegates to | Purpose |
|------|-------------|---------|
| `writing-outline` | `writingOutliner` | Generate a structured outline given topic, notes, and literature |
| `writing-draft` | `writingDrafter` | Draft a single section given outline entry, context, and sources |

These tools follow the same pattern as `literature-search` and `data-analyze`: the
coordinator invokes them as tools and receives structured JSON back.

### 2.2 Writing Workflow

When the user asks to write or draft a paper/section:

1. **Outline phase.** Coordinator calls `writing-outline` with the topic, pinned notes, and
   literature entities. Returns a section-by-section plan.
2. **Draft phase.** For each section (or user-selected sections), coordinator calls
   `writing-draft` with the outline entry, prior sections as context, and relevant
   literature. Each call returns a single drafted section.
3. **Assembly.** Coordinator assembles sections into a coherent document, saved via `write`.
4. **Revision.** User can request targeted rewrites. Coordinator calls `writing-draft` again
   for specific sections, passing updated context.

### 2.3 Writing Agent Enhancements

The current `writingDrafter` is stateless. To support the workflow above, extend it with:

- **Cross-section context**: accept previously drafted sections so the agent can maintain
  narrative continuity across the paper.
- **Revision mode**: accept an existing draft plus revision instructions, producing an
  improved version rather than writing from scratch.
- **Style configuration**: accept style presets (e.g., "conference paper", "survey",
  "workshop paper") that tune tone, depth, and citation density.

### 2.4 Intent Gating

Add to the coordinator's intent gating table:

| Condition | Required Tool |
|-----------|--------------|
| "Write/draft a paper/section/abstract" | `writing-outline` then `writing-draft` |

This prevents the coordinator from drafting inline and ensures the dedicated pipeline is used.

## 3. Writing Principles (Embedded in Sub-agents)

The writing agents already carry these principles in their system prompts:

- Narrative over enumeration: tell a story, not a bullet list.
- Every sentence earns its place.
- Formal but accessible: precision without jargon.
- Direct, confident claims.
- No dashes as structural elements.

## 4. Open Questions

1. **Granularity of user control.** Should the user approve the outline before drafting
   begins, or should the pipeline run end-to-end and present the full draft?
2. **Iteration strategy.** When the user says "rewrite the intro," should we redraft only
   that section or also update subsequent sections that reference it?
3. **Citation integration.** Should the writing agent pull from the literature entity store
   directly, or should the coordinator pre-select relevant papers?
4. **Quality gate.** Should there be an automated review step (e.g., a critic agent) before
   presenting the draft to the user?

## 5. Implementation Phases

### Phase A: Wiring (Minimum Viable)

- Create `writing-outline` and `writing-draft` tool wrappers in coordinator
- Add intent gating rule
- Test with a simple "draft a section on X" flow

### Phase B: Context Threading

- Pass previously drafted sections as context to `writing-draft`
- Add revision mode to the drafter agent
- Support "rewrite section N" commands

### Phase C: Quality and Polish

- Add style presets
- Consider a critic/review sub-agent for automated feedback
- Support full paper assembly with table of contents and bibliography
