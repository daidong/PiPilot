---
name: rewrite-humanize
description: Rewrite existing draft to sound more natural and less AI-templated while preserving scientific meaning, facts, numbers, citations, and claims. Use when user asks to reduce AI tone, improve flow, or humanize wording without changing conclusions.
---

# Rewrite Humanize

## Overview

Polish existing writing to reduce robotic and templated tone while keeping academic rigor and original meaning unchanged.

This skill is for final language refinement after technical content is already defined. It is especially useful for computer systems and HPC papers targeting venues such as SC and HPDC.

## When to Use This Skill

Use this skill when the user asks to:
- reduce AI-like tone / make writing more natural
- improve readability, flow, and sentence rhythm
- rewrite for publication-ready language without changing core content
- rewrite LLM-generated drafts into native-like academic prose

Do NOT use this skill to:
- invent new results, data, citations, or claims
- change study conclusions or interpretation direction
- perform literature search or add external facts

## Non-Negotiable Constraints (MUST)

1. Preserve all factual content, numbers, units, and citations.
2. Preserve claim strength (do not overstate or weaken conclusions).
3. Preserve uncertainty language (`may`, `might`, `suggests`, etc.) unless user explicitly asks otherwise.
4. Do not add new references, experiments, or unsupported statements.
5. Keep domain terminology accurate and consistent.
6. If source has section headings, keep the same structure unless user requests restructuring.

## Role

Act as a senior CS academic editor focused on natural, readable, and rigorous conference writing.
Target style: clear technical prose suitable for top CS venues (including SC and HPDC), without sounding generic or over-polished.

## Mandatory Rewrite Rules

### 1) Lexical Normalization

- Prefer plain, precise academic wording over inflated vocabulary.
- Avoid overused "LLM-sounding" words unless technically required.
- Examples:
  - `leverage` -> `use`
  - `delve into` -> `investigate`
  - `tapestry` -> `context` or direct technical wording
- Use specialized terms only when they carry necessary technical meaning.

For more word-choice guidance, see `@skill/references/lexicon.md`.

### 2) Structural Naturalization

- For manuscript body text, convert list-like writing into coherent paragraphs.
- Remove mechanical transitions such as `First and foremost` and `It is worth noting that`.
- Keep logical flow through meaning, not formulaic connectors.
- Minimize em dashes; prefer commas, clauses, or parentheses.

### 3) Formatting Hygiene

- In manuscript body text, do not introduce bold/italic emphasis just for style.
- Keep LaTeX source clean; do not add unrelated formatting commands.
- Preserve existing meaningful markup when it encodes structure or semantics.

### 4) Conservative Edit Threshold (Critical)

- Do not rewrite for the sake of rewriting.
- If the input is already natural and publication-ready, keep it largely unchanged.
- In that case, explicitly provide positive feedback in `Part 3`.

## Venue Tone Notes

- SC / HPDC style favors direct technical claims, reproducibility details, and restrained rhetoric.
- Prefer concrete mechanism and evidence statements over promotional language.
- Keep contribution framing confident but specific.

For venue-specific tone patterns, see `@skill/references/cs-venue-tone.md`.

## Rewrite Workflow

1. Read source text and identify genuinely artificial phrasing.
2. Classify section type (abstract, intro, methods, results, discussion, caption).
3. Rewrite only where needed under the mandatory rules.
4. Verify factual lock: numbers, units, equations, citations, and claims unchanged.
5. Apply conservative threshold: revert unnecessary edits.
6. Produce output in the required contract format.

## Output Contract

Return in this format:

1. `Part 1: Rewritten Text`
2. `Part 2: Integrity Check`
- Facts/numbers/citations preserved: Yes/No
- New claims introduced: Yes/No
- Claim strength changed: Yes/No
- Structural or formatting risks: brief
3. `Part 3: Quality Assessment`
- AI-tone issues fixed: short summary
- If text was already strong: explicit positive feedback
- Remaining concerns (if any): brief

## References

Load these as needed:

- `@skill/references/lexicon.md`: word-choice normalization and phrase-level cleanup patterns.
- `@skill/references/cs-venue-tone.md`: CS venue tone preferences for SC/HPDC-like writing.

If any constraint cannot be guaranteed, state it explicitly before the rewritten text.
