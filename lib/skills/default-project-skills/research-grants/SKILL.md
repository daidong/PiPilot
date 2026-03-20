---
name: research-grants
description: Plan and draft grant proposals with agency-aware structure, compliance checks, and reviewer-oriented framing.
allowed-tools:
  - skill-script-run
id: research-grants
shortDescription: Grant proposal workflow for scope design, compliance checks, and draft assembly
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - community
  - grants
  - proposal
meta:
  approvedByUser: true
  upstream:
    repo: https://github.com/K-Dense-AI/claude-scientific-writer
    path: skills/research-grants
---

# Summary
Use this skill to build fundable grant drafts that are specific, compliant, and reviewer-readable.

## Procedures
1. Initialize a proposal folder with standard sections for the target agency.
2. Draft problem statement, aims, methods, milestones, risk mitigation, and evaluation.
3. Run compliance checks (word/page budgets, required sections, format constraints).
4. Produce a reviewer-oriented summary that maps each requirement to evidence in the draft.

## Scripts
- `init-grant-structure`: Scaffold proposal markdown files by agency.
- `check-grant-compliance`: Quick section/length checks.
- `grant-summary-card`: Build a one-page review summary from draft files.

## Notes
- Keep claims measurable and verifiable.
- Tie deliverables to timeline and budget assumptions.
