---
name: academic-writing
description: Create research outlines and section drafts with local artifact persistence.
allowed-tools:
  - skill-script-run
id: academic-writing
shortDescription: Executable writing workflow (outline + section draft) with reproducible artifacts
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - writing
  - research
  - paper
  - outline
  - drafting
meta:
  approvedByUser: true
---

# Summary
Use this skill to produce writing artifacts through executable scripts, not free-form chat output.

# Scripts
- `outline`: generate a narrative-first outline JSON + Markdown.
- `draft-section`: draft one section JSON + Markdown with citation hints.

# Recommended Usage
1. Run `outline` first to establish structure and section priorities.
2. Run `draft-section` for one target section at a time.
3. Save returned artifact paths into turn evidence.

# Examples
`skill-script-run({"skillId":"academic-writing","script":"outline","args":["--topic","Agentic efficiency for OpenEvolve","--doc-type","paper","--project-root",".","--output-dir","runs/turn-0001/artifacts/writing"]})`

`skill-script-run({"skillId":"academic-writing","script":"draft-section","args":["--section-heading","Method","--instructions","Explain scheduler and novelty-tier policy","--citation-hints","Mouret2015;Pugh2016","--project-root",".","--output-dir","runs/turn-0001/artifacts/writing"]})`
