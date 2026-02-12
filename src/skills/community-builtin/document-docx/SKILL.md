---
name: document-skills-docx
description: Read, convert, and structure DOCX documents for drafting workflows.
allowed-tools:
  - skill-script-run
id: document-docx
shortDescription: DOCX extraction and conversion workflow for manuscript drafting
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - community
  - docx
  - document-processing
meta:
  approvedByUser: true
  capabilities:
    convert_to_markdown:
      script: docx-to-markdown
      extensions:
        - docx
  upstream:
    repo: https://github.com/K-Dense-AI/claude-scientific-writer
    path: skills/document-skills/docx
---

# Summary
Use this skill for DOCX-first workflows: extract text, convert to markdown, and scaffold structured drafts.

## Procedures
1. Prepare DOCX tooling once in the environment.
2. Convert `.docx` to markdown for tool-friendly editing.
3. Extract raw text when markdown conversion fails or formatting is noisy.
4. Create a clean DOCX template for collaborative writing handoff.

## Scripts
- `setup-docx-tools`: Install conversion dependencies.
- `docx-to-markdown`: Convert DOCX to Markdown.
- `extract-docx-text`: Dump plain text from DOCX.
- `init-docx-template`: Generate a minimal DOCX template file.

## Notes
- Prefer markdown as intermediate editing format.
- Keep the original DOCX unchanged; write outputs to new files.
