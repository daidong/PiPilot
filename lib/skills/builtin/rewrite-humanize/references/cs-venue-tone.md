# CS Venue Tone Notes (SC / HPDC Oriented)

This reference captures lightweight tone preferences for systems and HPC papers.
Use as guidance only; do not override user or venue template requirements.

## Core Style

- Lead with concrete technical problem framing.
- State contributions in specific, testable terms.
- Tie claims to evidence, not adjectives.
- Keep rhetoric restrained; avoid marketing tone.

## Section-Level Expectations

### Abstract

- One-sentence problem context, one-sentence approach, key quantitative results, and implication.
- Avoid broad claims that are not directly supported by reported metrics.

### Introduction

- Clearly define bottleneck, prior limitations, and why they matter at scale.
- Contributions should be concrete and countable.

### Methods / Design

- Prioritize mechanism clarity and implementation constraints.
- Keep terminology consistent with systems/HPC practice.

### Results

- Report setup and metrics precisely.
- Emphasize effect sizes and tradeoffs, not only best-case improvements.

### Discussion / Limitations

- Explicitly state scope boundaries and conditions where results may not transfer.

## Language Patterns to Prefer

- `We evaluate on ...`
- `Compared with <baseline>, our method improves ... by ...`
- `The gain is most visible when ...`
- `This result suggests ... under ... conditions`

## Language Patterns to Avoid

- `revolutionary`, `groundbreaking`, `unparalleled` without direct evidence
- Vague claims such as `significantly better` without metric context

## Reproducibility Signal

When rewriting, preserve or improve clarity around:
- hardware/software setup
- dataset and workload configuration
- statistical reporting choices
- fairness of baseline comparison
