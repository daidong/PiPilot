# Task Spec: Real PDF -> Review

Goal: Convert a real research-paper PDF to markdown and produce a structured review.

## Input

- Preferred PDF path: `workspace/papers/paper.pdf`
- If missing, search for `*.pdf` under `workspace/` and choose the best candidate.

## Required Deliverables

1. `outputs/plan.md`
1. `outputs/paper.extracted.md`
1. `outputs/paper-review.md`
1. `outputs/sources.md`

## Required Workflow

1. Read `agent.md` and this task file first.
1. Confirm target PDF exists and log chosen path in `outputs/plan.md`.
1. Convert PDF to markdown using `markitdown` skill:
   - Optional one-time setup: `setup-markitdown`
   - Conversion script: `convert-file <pdf-path> outputs/paper.extracted.md`
1. Read and inspect extracted markdown; note obvious extraction issues (layout artifacts, broken equations, hyphen joins).
1. Produce `outputs/paper-review.md` with this structure:
   - Title / metadata (as recoverable)
   - Problem statement
   - Method overview
   - Key results / claims
   - Strengths
   - Weaknesses / threats to validity
   - Reproducibility checklist
   - Open questions / next experiments
1. Write `outputs/sources.md`:
   - Input PDF path
   - Extraction command used
   - Any external references consulted
1. Emit `TASK_COMPLETE` when all deliverables exist.

## Quality Bar

- Do not fabricate missing details; explicitly mark unknown fields.
- Keep claims tied to evidence from extracted text.
- Prefer concise, verifiable summaries over broad speculation.
