---
name: citation-management
description: Manage references, fetch BibTeX by DOI, validate bibliography quality, and keep citation keys consistent.
allowed-tools:
  - skill-script-run
id: citation-management
shortDescription: Citation workflow for DOI->BibTeX, key normalization, and bibliography validation
loadingStrategy: lazy
tools:
  - skill-script-run
tags:
  - community
  - citations
  - bibtex
meta:
  approvedByUser: true
  upstream:
    repo: https://github.com/K-Dense-AI/claude-scientific-writer
    path: skills/citation-management
---

# Summary
Use this skill to keep references reproducible and clean. It standardizes DOI lookup, BibTeX storage, and quality checks before manuscript delivery.

## Procedures
1. Fetch missing BibTeX entries from DOI.
2. Normalize citation keys and deduplicate near-identical entries.
3. Validate the `.bib` file for missing required fields.
4. Run consistency checks before final writing/export.

## Scripts
- `setup-citation-tools`: Install optional helper dependencies.
- `doi-to-bibtex`: Resolve DOI to BibTeX and append/save.
- `validate-bib`: Quick structural quality checks for `.bib`.
- `normalize-bibtex-keys`: Rewrite keys to deterministic lowercase format.

## Notes
- Prefer DOI as canonical ID when available.
- Keep one canonical `.bib` file per project to avoid drift.
