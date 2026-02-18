---
name: literature-search
description: Search academic literature (OpenAlex + arXiv), persist local paper artifacts, and return machine-readable summaries.
allowed-tools:
  - skill-script-run
id: literature-search
shortDescription: Fast prior-art bootstrap with local caching for future retrieval
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - research
  - literature
  - papers
  - prior-art
meta:
  approvedByUser: true
---

# Summary
Use this skill when the task requires prior-art discovery, related-work grounding, or novelty checks.

It executes one bounded search run and writes local artifacts for later reuse.

# Scripts
- `search-papers`: quick single-query search over OpenAlex + arXiv.
- `search-sweep`: full multi-query sweep + citation expansion with ranked merged output.

# Recommended Usage
1. Bootstrap literature before deep repo/code analysis for open-ended research goals.
2. Save artifacts under `runs/turn-xxxx/artifacts/literature` in the current workspace.
3. Use returned paths as evidence pointers in turn output and plan updates.

Prefer `search-sweep` for first-pass prior-art grounding on open-ended goals.

# Example
`skill-script-run({"skillId":"literature-search","script":"search-papers","args":["--query","AlphaEvolve agentic optimization ideas","--limit","8","--project-root",".","--output-dir","runs/turn-0001/artifacts/literature"]})`

`skill-script-run({"skillId":"literature-search","script":"search-sweep","args":["--query","AlphaEvolve agentic optimization ideas","--limit-per-query","8","--final-limit","40","--project-root",".","--output-dir","runs/turn-0001/artifacts/literature"]})`

# Notes
- This skill is additive and non-blocking. If APIs are unavailable, fallback to `fetch` and still persist artifacts.
- Keep search bounded; avoid broad crawling in one turn.
