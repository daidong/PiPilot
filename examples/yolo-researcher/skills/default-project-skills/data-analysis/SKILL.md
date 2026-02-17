---
name: data-analysis
description: Run bounded dataset analysis workflows and persist reproducible local artifacts.
allowed-tools:
  - skill-script-run
id: data-analysis
shortDescription: Executable data analysis baseline (analyze/visualize/transform/model-lite)
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - data
  - analytics
  - visualization
  - statistics
meta:
  approvedByUser: true
---

# Summary
Use this skill when a turn needs concrete dataset analysis outputs rather than conversational summary.

# Scripts
- `analyze-dataset`: run one bounded analysis task and write JSON/Markdown artifacts.

# Recommended Usage
1. Start with `--task analyze` to establish schema, row counts, and numeric summaries.
2. Use `--task visualize` only when a figure is explicitly needed.
3. Persist returned paths as turn evidence.

# Example
`skill-script-run({"skillId":"data-analysis","script":"analyze-dataset","args":["--file","data/metrics.csv","--task","analyze","--instructions","Summarize key metrics and outliers","--project-root","."]})`
