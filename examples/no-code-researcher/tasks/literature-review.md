# Task Spec: Literature Review

Goal: Produce a concise literature review on a user-provided topic. Topic: what is the best execution environment for large number of LLM agents? What are the key design considerations.

## Required Deliverables

1. `outputs/plan.md`
1. `outputs/literature-review.md`
1. `outputs/sources.md`

## Procedure

1. Clarify topic scope and evaluation criteria.
1. Gather candidate sources (local files first, then web if enabled).
1. Compare methods/findings/limitations across sources.
1. Write structured review with:
   - background
   - key approaches
   - comparative analysis
   - open gaps / future work
1. Record references and short evidence notes in `outputs/sources.md`.
1. Emit `TASK_COMPLETE` when done.
