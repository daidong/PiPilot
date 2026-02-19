---
name: executing-plans
description: Execution-discipline workflow for plan alignment: one deliverable target per turn with read-back and verification.
id: executing-plans
shortDescription: Keep each execution turn aligned to one active deliverable
loadingStrategy: lazy
tags:
  - planning
  - execution
  - alignment
meta:
  approvedByUser: true
---

# Summary
Use this skill on execution turns to convert plan intent into a concrete deliverable touch.

Core loop:
`read-back -> choose one target deliverable -> execute one concrete action -> verify path/evidence`.

# Workflow
1. Read active plan done_definition and extract deliverable candidates.
2. Pick exactly one primary target deliverable for this turn.
3. Execute one concrete action that creates or updates the primary target.
4. Verify the target with a direct check (`read`, `ls`, or command output).
5. Record evidence pointers under `runs/turn-xxxx/...`.

# Guardrails
- If target is blocked by environment/runtime, write one blocker evidence note under `artifacts/evidence/` and make the blocker explicit.
- Do not drift into broad planning on execution turns.
- Do not claim success without target touch or blocker-clear evidence.

# Output Discipline
- Intent/summary should explicitly mention the primary target deliverable filename.
- Keep one-turn scope narrow: one target, one advancement.
