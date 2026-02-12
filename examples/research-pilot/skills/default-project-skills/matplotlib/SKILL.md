---
name: matplotlib
description: Reusable plotting templates and style presets for scientific figures.
allowed-tools:
  - skill-script-run
id: matplotlib
shortDescription: Plot template + style presets for consistent matplotlib figures
loadingStrategy: on-demand
tools:
  - skill-script-run
tags:
  - data
  - visualization
  - matplotlib
  - plotting
meta:
  approvedByUser: true
---

# Summary
Use this skill when you need fast, consistent matplotlib scaffolding (plot examples and style presets) before or alongside `data-analyze`.

## Procedures
1. For quick plot structure examples, run `plot_template`.
2. For style presets (`publication`, `presentation`, `web`, `dark`, `minimal`), run `style_configurator`.
3. Use generated examples/styles as references, then produce dataset-specific outputs with `data-analyze`.

## Scripts
- `plot_template`: Demonstrates common plot types and layout patterns.
- `style_configurator`: Generates and previews matplotlib style presets.

## Notes
- Keep project outputs in `.research-pilot/outputs/*`.
- Prefer `data-analyze` for final dataset-driven figures; use this skill to accelerate setup and styling decisions.
